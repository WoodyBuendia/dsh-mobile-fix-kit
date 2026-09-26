process.env.DSH_REMOTE_CONFIG = "/tmp/dshmob-test-config.json";
import net from "node:net";
const base = (process.env.DSH_MOBILE_PKG ?? process.env.HOME + "/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile") + "/dist";
const plugin = await import(`${base}/plugin.js`);
const rl = await import(`${base}/relay-client.js`);

const ctx = { get: () => undefined, effect: (cb) => { cb(); return () => {}; },
  logger: { info(){}, warn(){} }, webServer: { register: () => () => {} } };
plugin.apply(ctx, { relay: "https://example.invalid", dshPort: 3080 });
console.log("看门狗已安装 :", rl.RelayClient.prototype.__dshMobileLivenessPatched === true);
console.log("connect 已包装:", rl.RelayClient.prototype.connect.toString().includes("__dshMobileWatchdog"));

// 只接受连接、不完成 WS 握手 —— 让真实 socket 永远停在 CONNECTING(0)，不会触发既有重连
const srv = net.createServer(() => {});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const c = Object.create(rl.RelayClient.prototype);
c.config = { relay: `http://127.0.0.1:${port}/`, dshPort: 3080, deviceId: "x", deviceToken: "y" };
c.stopped = false; c.retry = 0; c.secureSessions = new Map(); c.localSockets = new Map(); c.localRequests = new Map();
c.connect();
console.log("真实 socket readyState:", c.ws.readyState, "(0=CONNECTING，符合预期)");

let terminated = false;
c.ws = { readyState: 1, on(){}, terminate(){ terminated = true; }, close(){} };
c.__dshMobileLastInboundAt = Date.now() - 10 * 60 * 1000;   // 静默 10 分钟
console.log("等待看门狗（间隔 10s，阈值 75s）...");
const t0 = Date.now();
while (!terminated && Date.now() - t0 < 13000) await new Promise(r => setTimeout(r, 200));
console.log(terminated ? ">>> 看门狗生效：静默超时后触发了强制重连" : ">>> 看门狗未触发（失败）");
try { srv.close(); } catch {}
process.exit(terminated ? 0 : 1);
