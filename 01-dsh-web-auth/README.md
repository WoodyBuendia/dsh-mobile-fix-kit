# dsh-mobile 的 DSH Web 授权补丁

给 `@april-jk/dsh-mobile@0.1.5`（远程 Companion，手机端 DSH）打的本地补丁。
没有它，手机能配对、能看到计算机名和对话列表，但**打不开 DSH 界面**，只会显示一行：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

## 根因

DSH 对每个浏览器请求都要求一枚**签名 cookie**，且没有任何旁路。

| 事实 | 位置 |
|---|---|
| 未授权时返回的那句话 | `@deepseek-ai/dsh-client-connection/lib/index.js:449` |
| 判定逻辑：从 **Host 头**推出 authority → 找名为 `cookieName(authority)` 的 cookie → 验签 | 同文件 `isAuthenticated()` |
| 唯一合法取得途径：用 `/?token=<本进程 launchToken>` 换 cookie，或手持有效 cookie | 同文件 `authorizeIndex()` |
| `trustedHosts` **不能**绕过鉴权（它只管 Host/Origin 反 DNS-rebinding 的 403 围栏，过了围栏照样要 cookie） | 同文件 `requestRejection()` |
| 插件原本只**透传**手机带来的 cookie，而手机永远没有这枚 cookie | 插件 `dist/relay-client.js` 的 `upstreamHeaders()` |

最直观的对照：同一台机器上，你的浏览器能打开 `127.0.0.1:3080`，手机不能——唯一差别就是浏览器有那枚 cookie。

## 补丁做什么

1. 插件在进程内取到 `connection` 服务（**就是 `dsh web` 用来打印访问 URL 的那个服务**），
   调 `connection.authenticatedUrl()` 拿到带 token 的 URL，内部请求一次，换回签名 cookie。
2. 把这枚 cookie 附到**每一条**转发给 `127.0.0.1:3080` 的请求上（HTTP 与 WebSocket 都走
   `upstreamHeaders()`）。

### 两个必须处理的坑

**坑 1：`ctx.get(name)` 默认 strict。**
`@deepseek-ai/cordis` 的 `get(name, strict = true)` 在提供该服务的 fiber 尚未 ACTIVE 时返回
`undefined`。插件激活那一刻去取 `connection` 可能取不到，所以补丁**失败每 5 秒重试**，
成功后改为 6 小时刷新一次。

**坑 2：`patchReload: "live"` 只重建条目，不重新导入模块。**
实测：把 profile patch 里的条目 `disabled: true` → `/dsh-mobile/api/state` 变成空 body 的 404
（条目确实卸载），再启用 → 又回到 200，**但新代码的日志 0 行、新路由仍是 404**。
模块一直在 Node 的 ESM 缓存里。结论：**改 `dist/` 之后必须重启进程**。

### 为什么补丁落在两个文件里

主路径与冗余路径并存，因为两条路互相独立：

| 文件 | 作用 |
|---|---|
| `dist/plugin.js` | 铸造 cookie（带重试）+ 运行时给 `RelayClient.prototype.upstreamHeaders` 打补丁 + 注册健康检查路由 `/dsh-mobile-authprobe` |
| `dist/relay-client.js` | 在 `upstreamHeaders()` 里直接注入 cookie |

两条路径都做了「cookie 已在 header 里就不再追加」的去重判断，所以同时生效也只会有一枚。

## 验证

```bash
curl -s http://127.0.0.1:3080/dsh-mobile-authprobe
```

期望：

```json
{"patchRev":3,"cookieName":"dsh-auth-...","headersCarryCookie":true,"status":200,
 "verdict":"PASS: DSH accepted the forwarded request","snippet":"<!doctype html>..."}
```

这个探针走的是 `upstreamHeaders()` 的**真实转发头**再打 DSH，也就是中继代理实际用的那套头，
所以 PASS 等价于手机侧会通过。

## 第二个故障模式：中继连接半死（看门狗）

授权修好之后仍会复发的另一种故障，症状完全不同：

- 插件 `/dsh-mobile/api/state` 一直报 `relayConnection: "connected"`、`dsh: "online"`
- 但手机进不去，访问会话记录里是一串**精确 10.00 秒**的失败会话，间隔约 14 秒重试

### 根因

| 环节 | 事实 |
|---|---|
| 插件心跳 | `relay-client.js` 在 `auth_ok` 后每 25 秒发一次 `ping` |
| 中继回应 | `dsh-relay/src/server.ts:1184` —— `if (msg.type === "ping") return ws.send(...envelope("pong", {}))` |
| **插件却不消费 pong** | `handle()` 里**没有 `pong` 分支**。心跳是"发出去就不管" |
| 后果 | `authenticated` 只在 socket 的 `close` 事件里被置回 false。**半开连接永不触发 close** ⇒ 插件永远自报 connected |
| 中继这侧 | 收到手机开 WebSocket 时起一个计时器：`setTimeout(() => ws.close(1013, "tunnel timeout"), 10_000)`（`dsh-relay/src/server.ts:1099`），等插件回 `ws_open_ok` |
| 于是 | 中继把手机的 `ws_open` 投给一条已经死掉的插件连接 → 手机等不到 `ws_open_ok` → 10 秒被中继以 1013 关闭 |

本机 DNS 走 fake-IP 透明代理，出现"只断单向、收不到 FIN"的半开连接很常见。

### 修法

`plugin.js` 的 `patchRelayClientLiveness()` 包装 `RelayClient.prototype.connect`：

- 在 socket 上挂一个 `message` 监听，记录 `__dshMobileLastInboundAt`
- 每 10 秒检查一次：socket 仍是 OPEN 但**超过 75 秒没有任何入站帧**（中继平时不主动下发，
  唯一的规律入站就是对 ping 的 pong，所以这个指标很干净）→ 调 `socket.terminate()`
- `terminate()` 触发既有的 `close` 流程（`authenticated=false` + 退避重连），于是自愈
- 同时包装 `stop()` 清理定时器

### 验证

```bash
node Work/dsh-mobile-auth-patch/watchdog-test.mjs
```

离线验证用一个「只接受连接、不完成 WS 握手」的 TCP 服务器，让真实 socket 停在 CONNECTING(0)
（这样既不会触发既有重连、也不干扰观察），再换成假 socket 并把它标记为静默 10 分钟，
观察看门狗是否在下一个 tick 调用了 `terminate()`。

### 自愈期间的现象

看门狗触发时会往 web.log 写一行：

```
dsh-mobile[auth] relay silent for 8Xs; forcing reconnect
```

随后应出现 `Relay disconnected; retrying in 1s` → `Connected to Relay; DSH is online`。
手机上等约 1 分钟重新进一次即可。

## 升级插件后怎么重修

`dsh plugin --profile web update` 会覆盖整个包，补丁丢失。两步：

1. 若新版本结构没变，直接 `./apply.sh`（版本不一致时会拒绝，确认无误再加 `--force`）。
2. 若 `dist/plugin.js` 或 `dist/relay-client.js` 结构变了，按下面重新派生：
   - 在 `plugin.js` 里补三块：`mintDshAuthCookie()`、`patchRelayClient()`、`registerAuthProbe()`，
     并在 `apply()` 里调用 `patchRelayClient()`、用 `scheduleCookie()` 启动重试循环；
   - 在 `relay-client.js` 的 `upstreamHeaders()` 返回前插入 cookie 合并块；
   - 把改好的两个文件放回本目录，更新 `VERSION.txt`。

## 回滚

```bash
cp Work/dsh-mobile-auth-patch/backup-<时间戳>/plugin.js      ~/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile/dist/
cp Work/dsh-mobile-auth-patch/backup-<时间戳>/relay-client.js ~/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile/dist/
systemctl --user restart dsh-web.service
```

## 附：这套东西里其它已确认的事实

- 手机配对凭据（`deviceId` / `deviceSecret` / `deviceToken` / `e2eeMasterKey`）持久化在
  `~/.dsh-remote/config.json`，**重启不会丢，不需要重新扫码**。
- 但重启会换掉 Web 访问 URL 里的 token，旧的 `?token=` 链接失效（cookie 会话另有 30 天寿命）。
- `relayConnection: "offline"` 在未配对时是**正常的**：`src/remote-access.ts` 的
  `initialize()` 只在已有 `deviceToken` 时才建中继连接。
- 判断「路由是否挂载」的基线：**空 body 的 404** 是 DSH 路由没接；有 body 的 404
  （如 `{"reason":"not_found"}`）是插件自己的处理器在应答。

## 第三个故障模式：网络路径（Clash fake-IP）

症状：手机有时进不去，访问会话记录里是**精确 10.00 秒**的失败，刷新几次又能进。

**先查这一条**，它比插件本身更常见：

```bash
getent ahostsv6 relay.dshmobile.online    # 出现 fdfe:dcba:9876::/108 就是 Clash fake-IP
getent ahostsv4 relay.dshmobile.online    # 正常应是真实 Cloudflare（104.21.x / 172.67.x）
ss -tn | awk '{print $5}' | grep -cE '^198\.18\.|^fdfe:dcba:9876'   # 应为 0
```

若命中的是 fake-IP：**Clash 没开 TUN 时，fake-IP 段没有东西去接**，常驻 WebSocket
会在代理层丢帧/卡顿——表现就是中继"写了但插件收不到"。修法是在 Clash 里让它直连：

```yaml
rules:
  - DOMAIN-SUFFIX,dshmobile.online,DIRECT
  - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
```

2026-09-25 实测：修之前 `ws_open` 大量失败，修之后 **6/6 全成**。

### 两条排查纪律（都是踩过的）

1. **短请求的成功率不能代表长连接的稳定性。** 曾用「连续 6 次打 `/health` 全成功、
   连接 4ms」断定"中继网络没问题"——而故障恰恰在常驻 WebSocket 上。
2. **加了检测手段却没触发，是数据、不是沉默。** 为 `handle()` 加了异常守卫后
   一条 `THREW` 都没有，这本身就否证了"插件内部抛异常"的假设。

### 兜底机制（已装载，可自愈）

- **存活看门狗**：中继连接静默超过 75 秒就强制重连。实测触发过一次：
  `relay silent for 82s; forcing reconnect`，随后自动恢复。日志里出现它属正常自愈行为。
- **`handle()` 异常守卫**：把"沉默的 10 秒"变成"有原文的报错 + 立即回 `device_close`"。
