process.env.DSH_REMOTE_CONFIG = "/tmp/dshmob-test-config.json";
import net from "node:net";
const base = (process.env.DSH_MOBILE_PKG ?? process.env.HOME + "/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile") + "/dist";
const plugin = await import(`${base}/plugin.js`);
const rl = await import(`${base}/relay-client.js`);

plugin.apply({ get: () => undefined, effect: (cb) => { cb(); return () => {}; },
  logger: { info(){}, warn(){} }, webServer: { register: () => () => {} } },
  { relay: "https://example.invalid", dshPort: 3080 });
console.log("openWs 已插桩 :", rl.RelayClient.prototype.__dshMobileWsInstrumented === true);

// 场景 A：本地 WS 打不开（端口无监听）→ 应快速上报而不是静默
const deadPort = await new Promise(r => { const s = net.createServer(); s.listen(0,"127.0.0.1",()=>{ const p=s.address().port; s.close(()=>r(p)); }); });
const c = Object.create(rl.RelayClient.prototype);
c.config = { dshPort: deadPort, relay: "http://127.0.0.1:1/", dshAuthCookie: "dsh-auth-TEST=abc" };
c.localSockets = new Map(); c.sent = [];
c.sendInner = (sid, type, payload, ch) => { c.sent.push({ type, code: payload && payload.code, reason: payload && payload.reason, ch }); return true; };
c.sessionSocketCount = () => 0;
c.channelKey = (sid, ch) => `${sid}:${ch}`;
c.openWs("sess1", { channel: "ch1", payload: { path: "/api" } });
await new Promise(r => setTimeout(r, 1500));
console.log("上报内容:", JSON.stringify(c.sent));
console.log("localSockets 残留:", c.localSockets.size);
const ok = c.sent.some(x => x.type === "ws_close" && x.code === 1011) && c.localSockets.size === 0;
console.log(ok ? ">>> 通过：本地 WS 失败会立即上报原因（不再静默吞掉）" : ">>> 失败");
process.exit(ok ? 0 : 1);
