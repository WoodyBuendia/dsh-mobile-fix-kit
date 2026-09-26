import z from "@deepseek-ai/schemastery";
import { WebSocket } from "ws";
import { loadConfig, saveConfig } from "./config.js";
import { registerManagementRoutes } from "./management.js";
import { RemoteAccessManager } from "./remote-access.js";
import { RelayClient, localPath } from "./relay-client.js";
export const name = "dsh-mobile";
export const Config = z.object({
    relay: z.string().required(),
    dshPort: z.natural().max(65535).required(),
});
// ===================================================================
// local patch: make the companion the DSH web-auth boundary
// ===================================================================
// DSH requires a signed browser-session cookie on every request and offers no
// loopback or header bypass (see @deepseek-ai/dsh-client-connection BrowserAuth
// / HostConnectionService.requestRejection). The phone never obtains one, so
// the companion mints one through the in-process `connection` service -- the
// very service `dsh web` uses to print its authenticated launch URL -- and
// attaches it to every upstream request.
//
// Everything lives in this entry module on purpose: the profile loader
// re-imports an entry module when the entry is re-created, but a static
// dependency keeps its cached module, so patches placed in relay-client.js
// would not take effect on a live reload. Patching the RelayClient prototype
// from here works both on a live reload and after a full restart.
const COOKIE_REFRESH_MS = 6 * 60 * 60 * 1000;
const COOKIE_RETRY_MS = 5000;
let lastLog = "";
function log(message) {
    // console reaches the web service log even before ctx.logger is usable.
    if (message === lastLog)
        return;
    lastLog = message;
    console.log(`dsh-mobile[auth] ${message}`);
}
// `ctx.get(name)` is strict by default and returns undefined while the
// providing fiber is not yet active, so the attempt made during plugin
// activation can miss; retry until it succeeds.
function resolveConnection(ctx) {
    for (const strict of [true, false]) {
        const connection = ctx.get("connection", strict);
        if (connection && typeof connection.authenticatedUrl === "function")
            return connection;
    }
    return undefined;
}
async function mintDshAuthCookie(ctx, dshPort) {
    const connection = resolveConnection(ctx);
    if (!connection) {
        log("connection service not available yet");
        return undefined;
    }
    const url = connection.authenticatedUrl(`http://127.0.0.1:${dshPort}/`);
    const response = await fetch(url, { redirect: "manual" });
    const raw = response.headers.get("set-cookie");
    log(`mint status=${response.status} setCookie=${raw ? "yes" : "no"}`);
    if (!raw)
        return undefined;
    const pair = raw.split(";")[0].trim();
    return pair.includes("=") ? pair : undefined;
}
/** Attach the minted DSH session cookie to every request forwarded upstream. */
function patchRelayClient() {
    const proto = RelayClient.prototype;
    if (proto.__dshMobileAuthPatched === true)
        return;
    const original = proto.upstreamHeaders;
    proto.upstreamHeaders = function (input) {
        const headers = original.call(this, input);
        const cookie = this.config && this.config.dshAuthCookie;
        if (cookie) {
            let merged = false;
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() !== "cookie")
                    continue;
                const current = headers[key];
                headers[key] = current
                    ? (String(current).includes(cookie) ? current : `${current}; ${cookie}`)
                    : cookie;
                merged = true;
            }
            if (!merged)
                headers.cookie = cookie;
        }
        return headers;
    };
    proto.__dshMobileAuthPatched = true;
    log("RelayClient.upstreamHeaders patched");
}
// The plugin sends `ping` every 25s and the relay answers `pong`, but nothing
// consumes pong: `authenticated` stays true until the socket's close event
// fires. Behind this host's fake-IP transparent proxy a half-open socket never
// delivers that event, so the plugin keeps claiming a connection the relay can
// no longer route to -- the relay then hands the phone's `ws_open` to a dead
// socket, and the phone dies on the relay's 10s "tunnel timeout" (1013).
// Watch inbound frames (pongs are the only regular ones) and force a reconnect
// when they stop.
const RELAY_SILENCE_TIMEOUT_MS = 75 * 1000;
const RELAY_WATCHDOG_INTERVAL_MS = 10 * 1000;
function patchRelayClientLiveness() {
    const proto = RelayClient.prototype;
    if (proto.__dshMobileLivenessPatched === true)
        return;
    const originalConnect = proto.connect;
    proto.connect = function () {
        const result = originalConnect.call(this);
        this.__dshMobileLastInboundAt = Date.now();
        if (this.ws)
            this.ws.on("message", () => { this.__dshMobileLastInboundAt = Date.now(); });
        if (this.__dshMobileWatchdog)
            clearInterval(this.__dshMobileWatchdog);
        this.__dshMobileWatchdog = setInterval(() => {
            if (this.stopped)
                return;
            const socket = this.ws;
            // A non-OPEN socket is already the close handler's business.
            if (!socket || socket.readyState !== 1)
                return;
            const idle = Date.now() - (this.__dshMobileLastInboundAt || 0);
            if (idle <= RELAY_SILENCE_TIMEOUT_MS)
                return;
            log(`relay silent for ${Math.round(idle / 1000)}s; forcing reconnect`);
            this.__dshMobileLastInboundAt = Date.now();
            try {
                socket.terminate();
            }
            catch {
                try {
                    socket.close();
                }
                catch { /* already gone */ }
            }
        }, RELAY_WATCHDOG_INTERVAL_MS);
        return result;
    };
    const originalStop = proto.stop;
    proto.stop = function () {
        if (this.__dshMobileWatchdog) {
            clearInterval(this.__dshMobileWatchdog);
            this.__dshMobileWatchdog = undefined;
        }
        return originalStop.call(this);
    };
    proto.__dshMobileLivenessPatched = true;
    log("RelayClient.connect liveness watchdog installed");
}
// The stock openWs acknowledges with `ws_open_ok` only once the LOCAL WebSocket
// to DSH fires "open", and swallows any "error". So when that local socket
// fails, the phone gets no answer at all and the relay kills the tunnel on its
// own 10s timer (1013) with nothing recorded anywhere. Reimplement it with
// timing, an explicit failure reply, and an open deadline shorter than the
// relay's so failures surface as a reason instead of a silent 10s hang.
const LOCAL_WS_OPEN_TIMEOUT_MS = 8 * 1000;
const MAX_WS_TUNNELS = 16; // mirrors MAX_WS_CHANNELS in relay-client.js
function patchRelayClientWsDiagnostics() {
    const proto = RelayClient.prototype;
    if (proto.__dshMobileWsInstrumented === true)
        return;
    proto.openWs = function (sessionId, msg) {
        const channel = msg.channel ?? "";
        if (this.sessionSocketCount(sessionId) >= MAX_WS_TUNNELS) {
            log("ws_open rejected: too many tunnels");
            this.sendInner(sessionId, "ws_close", { code: 1013, reason: "too many tunnels" }, channel);
            return;
        }
        const key = this.channelKey(sessionId, channel);
        const path = localPath(msg.payload.path);
        const started = Date.now();
        log(`ws_open -> ${path}`);
        const socket = new WebSocket(`ws://127.0.0.1:${this.config.dshPort}${path}`, {
            headers: this.upstreamHeaders(msg.payload.headers ?? {}),
        });
        this.localSockets.set(key, { sessionId, socket });
        let settled = false;
        let failed = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            failed = true;
            log(`ws_open TIMEOUT after ${Date.now() - started}ms path=${path}`);
            try {
                socket.terminate();
            }
            catch { /* already gone */ }
            this.localSockets.delete(key);
            this.sendInner(sessionId, "ws_close", { code: 1011, reason: "local ws timeout" }, channel);
        }, LOCAL_WS_OPEN_TIMEOUT_MS);
        socket.on("open", () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            log(`ws_open OK in ${Date.now() - started}ms path=${path}`);
            this.sendInner(sessionId, "ws_open_ok", {}, channel);
        });
        socket.on("message", (data, binary) => this.sendInner(sessionId, "ws_frame", {
            dataB64: Buffer.from(data).toString("base64"),
            opcode: binary ? 2 : 1,
        }, channel));
        socket.on("close", (code, reason) => {
            const closedBeforeOpen = !settled;
            if (!settled) {
                settled = true;
                clearTimeout(timer);
            }
            this.localSockets.delete(key);
            // An error/timeout already told the peer why; don't duplicate it.
            if (failed)
                return;
            if (closedBeforeOpen) {
                log(`ws_open CLOSED before open after ${Date.now() - started}ms path=${path} code=${code}`);
                this.sendInner(sessionId, "ws_close", { code: 1011, reason: `local ws closed (${code})` }, channel);
                return;
            }
            this.sendInner(sessionId, "ws_close", { code, reason: reason.toString() }, channel);
        });
        socket.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            failed = true;
            clearTimeout(timer);
            log(`ws_open FAILED after ${Date.now() - started}ms path=${path}: ${error instanceof Error ? error.message : String(error)}`);
            this.localSockets.delete(key);
            this.sendInner(sessionId, "ws_close", { code: 1011, reason: "local ws error" }, channel);
        });
    };
    proto.__dshMobileWsInstrumented = true;
    log("RelayClient.openWs instrumented");
}
// The socket's message listener calls `this.handle(value)` OUTSIDE any
// try/catch, and `ws.on("error", () => undefined)` swallows whatever escapes.
// So one throw anywhere below -- acceptSession, openSealed, handleInner --
// leaves the peer with no server_hello, no device_close and no log at all, and
// the relay then kills the tunnel/handshake on its 10s timer. Wrap handle() so
// a throw is recorded and answered instead of vanishing.
function patchRelayClientHandleGuard() {
    const proto = RelayClient.prototype;
    if (proto.__dshMobileHandleGuarded === true)
        return;
    const originalHandle = proto.handle;
    proto.handle = function (msg) {
        try {
            return originalHandle.call(this, msg);
        }
        catch (error) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            log(`handle(${msg && msg.type}) THREW -> ${detail}`);
            const sessionId = msg && msg.payload && msg.payload.accessSessionId;
            // Never leave the peer waiting on a 10s timer with no answer.
            try {
                if (typeof sessionId === "string")
                    this.sendOuter("device_close", { accessSessionId: sessionId, reason: "internal_error" });
            }
            catch { /* socket already gone */ }
            return undefined;
        }
    };
    proto.__dshMobileHandleGuarded = true;
    log("RelayClient.handle guarded");
}
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
    });
    res.end(body);
}
/** TEMP verification route: exercises the exact headers the proxy forwards. */
function registerAuthProbe(ctx, config) {
    return ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-mobile-authprobe",
        handler: async (req, res) => {
            try {
                const headers = RelayClient.prototype.upstreamHeaders.call({ config }, {});
                const response = await fetch(`http://127.0.0.1:${config.dshPort}/`, {
                    headers,
                    redirect: "manual",
                });
                const snippet = (await response.text()).slice(0, 140);
                sendJson(res, 200, {
                    patchRev: 6,
                    cookieName: config.dshAuthCookie
                        ? config.dshAuthCookie.slice(0, config.dshAuthCookie.indexOf("="))
                        : null,
                    headersCarryCookie: Object.keys(headers).some(key => key.toLowerCase() === "cookie"),
                    status: response.status,
                    verdict: response.status === 200 && !snippet.includes("authentication required")
                        ? "PASS: DSH accepted the forwarded request"
                        : "FAIL: DSH still rejects the forwarded request",
                    snippet,
                });
            }
            catch (error) {
                sendJson(res, 200, {
                    patchRev: 6,
                    verdict: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        },
    });
}
// ===================== end local patch =====================
export function apply(ctx, pluginConfig) {
    patchRelayClient();
    patchRelayClientLiveness();
    patchRelayClientWsDiagnostics();
    patchRelayClientHandleGuard();
    ctx.effect(() => {
        let disposed = false;
        let manager;
        let unregister;
        let probeDisposer;
        let cookieTimer;
        void (async () => {
            try {
                const config = {
                    ...(await loadConfig()),
                    relay: pluginConfig.relay,
                    dshPort: pluginConfig.dshPort,
                };
                await saveConfig(config);
                if (disposed)
                    return;
                // --- local patch: mint the DSH cookie, retrying until it works ---
                const refreshCookie = async () => {
                    try {
                        const cookie = await mintDshAuthCookie(ctx, config.dshPort);
                        if (cookie) {
                            config.dshAuthCookie = cookie;
                            log(`DSH web session acquired (${cookie.slice(0, cookie.indexOf("="))})`);
                            return true;
                        }
                    }
                    catch (error) {
                        log(`mint failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    return false;
                };
                const scheduleCookie = (delay) => {
                    cookieTimer = setTimeout(async () => {
                        if (disposed)
                            return;
                        const ok = await refreshCookie();
                        if (!disposed)
                            scheduleCookie(ok ? COOKIE_REFRESH_MS : COOKIE_RETRY_MS);
                    }, delay);
                };
                scheduleCookie(0);
                probeDisposer = registerAuthProbe(ctx, config);
                // --- end local patch ---
                manager = new RemoteAccessManager(config);
                unregister = registerManagementRoutes(ctx.webServer, manager);
                await manager.initialize();
                ctx.logger.info(config.deviceToken
                    ? `DSH mobile remote connecting through ${config.relay}`
                    : "DSH mobile remote is ready to pair in WebUI Settings");
            }
            catch (error) {
                ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
            }
        })();
        return () => {
            disposed = true;
            clearTimeout(cookieTimer);
            probeDisposer?.();
            unregister?.();
            manager?.dispose();
        };
    }, "dsh-mobile.lifecycle");
}
