# dsh-mobile 手机端修复手册

把 `@april-jk/dsh-mobile`（手机端 DSH Remote：手机 App ↔ 公网中继 ↔ 本机 DSH Web）
在真实使用中踩到的**四类故障**整理成「症状 → 根因 → 判据 → 修法 → 验证」，
每一条都带可复制的命令和**可证伪的判据**。面向「人和人的 agent 直接照做」。

- 基线：`@april-jk/dsh-mobile@0.1.5`、DSH Web 由 systemd 用户服务 `dsh-web.service` 提供、
  中继 `relay.dshmobile.online`、DSH 只绑 `127.0.0.1:3080`
- 上游现状（2026-09-26 核对）：最新发布 `0.1.9`，`dist/plugin.js` 结构已重构，
  **本手册的三个补丁在上游都不存在**；补丁脚本按"字符串定位 + 插入"写成，便于向新版本移植
- 所有路径默认 `PKG=~/.dsh/profiles/web/node_modules/@april-jk/dsh-mobile`

## 症状速查

| 手机上的表现 | 插件自报 | 故障 | 看哪节 |
|---|---|---|---|
| 能看到对话列表，点进去只有一行 `dsh web authentication required` | 正常 | A：DSH 签名 cookie 缺失 | §A |
| 根本进不去（连列表都没有），失败会话**恰好 10.00 秒** | 一直 `connected` / `online`（在撒谎） | B：中继长连接半死 | §B |
| 点历史对话永久"载入历史"，之后**连发消息**都 `Failed to fetch` | 正常 | C：单帧超中继上限被 1009 关连接 | §C |
| 历史/文件载入不出来，报 `fetch failed` / "无法访问网络" | 正常 | D：本机 DNS/代理环境（Clash fake-IP） | §D |

**共同陷阱**：`GET /dsh-mobile/api/state` 里 `relayConnection:"connected"`、`dsh:"online"`
**在这四类故障里都可能是假的**——它只反映"插件自己以为"。别拿它当判活依据。

---

## §A `dsh web authentication required`

### 症状
手机配对成功、能看到计算机名和对话列表，但打不开 DSH 界面，页面只有一行：
`dsh web authentication required; reopen the URL printed by dsh web.`

### 根因
DSH 对**每个浏览器请求**都要求一枚**签名 cookie**，且没有旁路：

| 事实 | 位置 |
|---|---|
| 未授权时返回的那句话 | `@deepseek-ai/dsh-client-connection/lib/index.js`（`isAuthenticated()` / `authorizeIndex()` 附近） |
| 唯一合法取得途径：用 `/?token=<本进程 launchToken>` 换 cookie | 同上 |
| `trustedHosts` **不能**绕过鉴权（它只管 Host/Origin 反 DNS-rebinding 的 403 围栏） | 同上 `requestRejection()` |
| 插件原本只**透传**手机带来的 cookie，而手机永远没有这枚 cookie | 插件 `dist/relay-client.js` 的 `upstreamHeaders()` |

### 判据
```bash
curl -s http://127.0.0.1:3080/dsh-mobile-authprobe
# 期望 {"status":200,"verdict":"PASS: DSH accepted the forwarded request",...}
# 该探针走的是中继代理实际用的那套转发头，PASS 等价于手机侧会通过
```

### 修法
`01-dsh-web-auth/apply.sh`：把权威副本 `plugin.js` / `relay-client.js` 覆盖进 `dist/`，
补丁做两件事（主路径 + 冗余路径，去重后只带一枚 cookie）：

1. 进程内取 `connection` 服务（`ctx.get("connection")`），调 `connection.authenticatedUrl()`
   拿带 token 的 URL、内部请求一次换回签名 cookie，附到每条转发请求的 `cookie` 头；
2. 运行时给 `RelayClient.prototype.upstreamHeaders` 打补丁，注入同一枚 cookie。

同时注册健康检查路由 `/dsh-mobile-authprobe`。

### 两个必须处理的坑
- **`ctx.get(name)` 默认 strict**：provider fiber 未 ACTIVE 时返回 `undefined` ⇒ 铸造必须**重试**（补丁 5 秒一次）。
- **`patchReload:"live"` 只重建 loader 条目、不重新导入 ESM 模块**：改完 `dist/` **必须重启进程**
  （实测：禁用→启用条目回来了，但新代码的日志与路由都不出现）。

### 验证
```bash
bash 01-dsh-web-auth/apply.sh
node 01-dsh-web-auth/watchdog-test.mjs          # 离线验证看门狗
systemd-run --user --on-active=40 --unit=dsh-restart systemctl --user restart dsh-web.service
curl -s http://127.0.0.1:3080/dsh-mobile-authprobe    # 期望 PASS
```

---

## §B 中继长连接半死（失败恰好 10.00 秒）

### 症状
手机**根本进不去**（连对话列表都没有）；中继侧访问记录里是一串**精确 10.00 秒**的失败会话。
插件却一直自报 `relayConnection:"connected"`。

### 根因
| 环节 | 事实 |
|---|---|
| 插件心跳 | `auth_ok` 之后每 25 秒发一次 `ping` |
| 中继会回 `pong` | `dsh-relay/src/server.ts`（`if (msg.type === "ping")` 分支） |
| **插件不消费 `pong`** | `handle()` 里没有 `pong` 分支；心跳"发出去就不管" |
| 于是 | `authenticated` 只在 socket 的 **`close`** 事件里置回 false，**半开连接永不触发 close** ⇒ 永远自报 connected |
| 中继这侧 | 手机开 WebSocket 时起 `setTimeout(() => ws.close(1013, "tunnel timeout"), 10_000)` 等插件回 `ws_open_ok` ⇒ **那个精确的 10 秒** |
| DNS 环境 | fake-IP 透明代理下"只断单向、收不到 FIN"的半开连接很常见 |

### 判据
- 手机侧失败时长**精确 10.00 秒**（不是 3 s、不是 30 s）→ 指向中继的 tunnel timeout，而非 App 超时；
- 日志出现 `relay silent for 8Xs; forcing reconnect` 说明看门狗已生效（补丁后）。

### 修法
`plugin.js` 的 `patchRelayClientLiveness()`：包装 `RelayClient.prototype.connect`，
在 socket 上记录 `__dshMobileLastInboundAt`，每 10 秒检查——**OPEN 但 >75 秒无任何入站帧**就
`socket.terminate()`，借既有 close 流程自愈（`authenticated=false` + 退避重连）。

指标干净的前提：**中继平时不主动下发任何帧**，唯一规律入站就是对 ping 的 pong。

### 验证
`01-dsh-web-auth/watchdog-test.mjs`：用"只接受连接、不完成 WS 握手"的 TCP 服务器把真实 socket
钉在 CONNECTING(0)，再换成假 socket 标记为静默 10 分钟，看下一个 tick 是否调 `terminate()`。

### 复用手法：不重启进程强制重建中继连接
改 profile patch 里插件条目 `disabled: true` → 等 8 秒 → 改回 false。
**副作用**：会向手机会话发 `device_close`，把手机踢下线；排查时别反复做。

---

## §C 历史载入卡死 + 之后全部 `Failed to fetch`（单帧超中继上限）

### 症状
点侧边栏某个历史对话 → 永久"载入历史"；**随后新对话、发消息也全废**：
`client api: session/prompt failed: Failed to fetch (gateway/internal)`。
看起来像"所有对话都打不开"，实际不是。

### 根因（一条链，逐环有判据）
1. **会话首页是单个 WebSocket 帧**：客户端开会话走 `session/follow`，首次 `yield` 就是整个快照；
   分页参数 `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`
   （`@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/session.js`），
   切片包含区间内**全部事件**（工具输出也在内）。
2. **插件把帧放大 ×1.778**：`relay-client.js` 的 `ws_frame.dataB64` 先 base64，E2EE `seal()`
   再整体 base64url（AES-256-GCM 只加 16 B tag）。
3. **中继单帧上限 4 MiB**：`dsh-relay/src/server.ts` 的 `MAX_WS_PAYLOAD_BYTES` 默认
   `4 * 1024 * 1024`，`new WebSocketServer({ maxPayload })` 且 **`/device` 与浏览器共用同一个 `wss`**
   ⇒ 设备方向的超限帧被 `ws` 库以 **1009** 关闭。
4. **插件反应过度**：设备连接一 close，`relay-client.js` 的 close 处理器调 `closeAllSessions()`，
   把所有手机隧道一起拆。
5. **App 不自愈**：之后每个请求都 `Failed to fetch` ⇒ "长的短的全不行"。

**阈值**：DSH 帧 > **2.25 MiB**（= 4 MiB ÷ 1.778）就会触发。

### 判据（三条，可独立复现）
```bash
# ① 量真实首页帧大小（需本机 launchToken，见 web.log 的 "dsh web: http://.../?token=" 行）
DSH_TOKEN=<token> node tools/measure-frame.mjs <token> session-<uuid>     # 打印 firstFrameMiB
# ② 算外发帧（双 base64 恒定 ×1.778）
node tools/exact-outer.mjs 5330920                                       # -> 9.039 MiB > 4 MiB
# ③ 验证中继上限（用**假凭据**，不碰真设备会话；首帧即发大帧）
node tools/relay-limit-probe.mjs 5    # 5 MiB -> CLOSED code=1009
node tools/relay-limit-probe.mjs 3    # 3 MiB -> 走到鉴权，4003 auth failed（即未超限）
```

### 修法（两条同时做才完整）
1. **压小首页**（`02-history-page-cap/apply.sh`，宿主侧一行 clamp，需重启 dsh-web）：
   在 `@deepseek-ai/dsh-api-session-controller/lib/index.js` 与 `lib/types/history.js` 的
   `paginate()` 开头加：
   ```js
   maxMessages = Math.min(maxMessages ?? 50, 40);
   if (turnWindow) turnWindow = { minMessages: Math.min(turnWindow.minMessages, 8), minTurns: 1 };
   ```
   实测效果：最坏会话外发帧 **9.02 → 2.21 MiB**；全 22 个会话全部落回 4 MiB 以内。
2. **打死之后要能救**：卡死态不会自恢复，必须在手机侧把 App **从最近任务划掉重开**。
   （想彻底免掉这一步，就得让大帧不再出现：自建中继调大 `MAX_WS_PAYLOAD_BYTES`，
   或让插件对超限帧做大帧分片。）

### 验证
重启后重跑 `tools/measure-frame.mjs`，首页帧应 ≤ ~2.2 MiB；再点最重的对话，手机能正常载入。

### 排查中容易犯的错
- **"短对话也打不开 ⇒ 不是大帧问题"**：错。卡死态让**任何**请求失败。判据：卡死期间在中继前
  挂代理抓包（`tools/relay-proxy.mjs`），插件外发帧只有几十 KB ⇒ 请求根本没到 DSH。
- **按 `web.log` 里 `Relay disconnected` 的计数判断中继不稳**：该文件跨重启 **append**，
  必须先按最后一次 `dsh web: http://...` banner 切段再统计。
- **把 `state` 的 `connected` 当判活**：见 §B。

---

## §D 环境类：`fetch failed` / Clash fake-IP / 假 IPv6

### 症状
手机端历史载入不出来、点文件/新建对话报 `fetch 无法访问网络`；本机 DSH 调工具时也常见。

### 根因与判据
- **`fetch failed` 必须看 `error.cause`**，真身通常是
  `ECONNRESET: Client network socket disconnected before secure TLS connection was established`。
- **假 IPv6 无路由**：Clash 下发 `fdfe:dcba:9876::/108`，WSL 无该路由 ⇒ 客户端一旦优先选 IPv6 必失败。
  判据（地址族对照）：
  ```bash
  curl -4 -s -o /dev/null -w '%{http_code}\n' https://relay.dshmobile.online/health   # 200
  curl -6 -s -o /dev/null -w '%{http_code}\n' https://relay.dshmobile.online/health   # 000
  ```
- **长连接被 fake-IP 代理丢帧**：常驻 WebSocket 别走代理节点。

### 修法
在 Clash 的 `profiles/` 扩展文件（**不要改运行态 `clash-verge.yaml`，必被覆盖**）里：
```yaml
dns:
  fake-ip-filter:
    - "+.dshmobile.online"
    - "+.trycloudflare.com"
prepend:
  - DOMAIN-SUFFIX,dshmobile.online,DIRECT
  - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
```
判据：`getent hosts relay.dshmobile.online` 从 fake-IP 变成真实 Cloudflare IP（`104.21.x` / `172.67.x`）。

---

## §E 另一条通路：`@linxin666/dsh-remote-web-ui`（浏览器方式）

不走 App/中继，用 Cloudflare 隧道把 DSH Web 暴露给手机浏览器。要点与代价：

| 项 | 值 |
|---|---|
| 装 | `dsh plugin --profile web add @linxin666/dsh-remote-web-ui`，**必须** `allowBuilds: cloudflared` |
| 默认通路 | 三个通路默认全关（`lan-required`），装完配不了任何设备；选 `loopback + autoTunnel` |
| `relay:false` 的代价 | 二维码退回**临时 `trycloudflare` 域名，每次 `dsh web` 重启都变** ⇒ 手机 cookie 绑的是原 origin，**必须重新扫码配对**，书签失效 |
| 若开 `relay:true` | 有稳定 origin，但 TLS 在作者 Worker 终止 ⇒ **明文过作者基础设施**，返回方向还能改写发给手机的 JS，而页面持有全权配对凭据 |
| 优点 | 无 E2EE 二次 base64 ⇒ **没有 4 MiB 单帧悬崖**，大历史也能载入 |

---

## 目录

```
01-dsh-web-auth/        §A + §B：cookie 注入 + pong 看门狗 + handle 守卫 + 探针（权威副本 0.1.5）
02-history-page-cap/    §C：宿主 paginate 首页上限（幂等 apply/revert）
tools/
  measure-frame.mjs       量「DSH 侧真实首页帧」（本地 mux ws 回放，只读）
  exact-outer.mjs         算「插件外发帧」（双 base64 + GCM tag + 信封）
  relay-limit-probe.mjs   量「中继单帧上限」（假凭据，不碰真设备会话）
  relay-proxy.mjs         中继前置代理，记录每帧大小与双向关闭码（插件 relay 指向它）
  verdict.mjs             扫本地会话，列出哪些对话会超限
```

## 安全说明（发布/使用前必读）

- `01` 的做法是**给配对设备注入 DSH 的浏览器签名 cookie**，等价于中继代理的行为。
  它只在「手机 ↔ 插件」有 E2EE、且手机是已配对设备时安全；**不要**把它用到多用户或不可信中继上。
- `02` 只影响分页大小，无安全含义。
- 本目录**不含任何凭据**：设备 token / E2EE master key 在 `~/.dsh-remote/config.json`，不要提交。

## 许可与出处

- 本仓库：MIT（见 `LICENSE`）。
- `01-dsh-web-auth/` 下的 `plugin.js` / `relay-client.js` 是 **`@april-jk/dsh-mobile`
  （MIT，Copyright (c) 2026 dsh-mobile contributors）的修改副本**，改动处均带 `local patch` 注释；
  上游：<https://github.com/april-jk/dsh-mobile-plugin>。
- 中继源码与文档引用自 <https://github.com/april-jk/dsh-relay> 与
  <https://github.com/april-jk/dsh-mobile-suite>（MIT）。
- 本仓库**不含任何凭据**（设备 token / E2EE master key 在 `~/.dsh-remote/config.json`）。

## 维护

- `01` 的权威副本是**整文件拷贝**，只对 `0.1.5` 成立；换版本请按 §A 的两个坑**重新移植**，
  不要直接覆盖（`apply.sh` 有版本一致性检查）。
- `02` 改的是 `node_modules`，**`npm install` / DSH 升级会覆盖**；升级后重跑 `apply.sh`（幂等）。
