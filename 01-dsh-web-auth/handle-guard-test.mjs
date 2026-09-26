process.env.DSH_REMOTE_CONFIG = "/tmp/dshmob-test-config.json";
const base = (process.env.DSH_MOBILE_PKG ?? process.env.HOME + "/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile") + "/dist";
const plugin = await import(`${base}/plugin.js`);
const rl = await import(`${base}/relay-client.js`);
plugin.apply({ get: () => undefined, effect: (cb) => { cb(); return () => {}; },
  logger: { info(){}, warn(){} }, webServer: { register: () => () => {} } },
  { relay: "https://example.invalid", dshPort: 3080 });
console.log("handle 已加守卫:", rl.RelayClient.prototype.__dshMobileHandleGuarded === true);

// 令 config 为 null -> acceptSession 读 e2eeMasterKey 时抛 TypeError -> 应被守卫捕获并回 device_close
const c = Object.create(rl.RelayClient.prototype);
c.config = null; c.sent = [];
c.sendOuter = (type, payload) => { c.sent.push({ type, ...payload }); return true; };
c.handle({ type: "client_hello", payload: { accessSessionId: "sess-x" } });
console.log("守卫回报内容:", JSON.stringify(c.sent));
const ok = c.sent.length === 1 && c.sent[0].type === "device_close" && c.sent[0].reason === "internal_error";
console.log(ok ? ">>> 通过：内部异常不再静默吞掉，会记录并立即回复对端" : ">>> 失败");
process.exit(ok ? 0 : 1);
