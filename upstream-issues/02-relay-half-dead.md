# Issue 2 — 中继连接半死时插件永远自报 connected，手机侧失败恰好 10.00 秒且无法自愈

## 现象

- 手机**根本进不去**（连对话列表都没有）；
- 中继侧访问记录里是一串**精确 10.00 秒**的失败会话，间隔约 14 秒重试；
- 插件 `/dsh-mobile/api/state` 与日志却一直报 `relayConnection: "connected"`、`dsh: "online"`；
- 只有手动重建中继连接（禁用/启用插件条目或重启 DSH）才能恢复。

## 根因

| 环节 | 位置 | 事实 |
|---|---|---|
| 插件心跳 | `src/relay-client.ts:247` | `auth_ok` 之后每 25 秒 `sendOuter("ping", {})` |
| 中继回应 | `dsh-relay/src/server.ts` | 收到 `ping` 回 `pong` |
| **插件不消费 pong** | `src/relay-client.ts:239` `handle()` | 没有 `pong` 分支，心跳"发出去就不管" |
| 状态只在 close 重置 | `src/relay-client.ts:173` | `ws.on("close")` 里才 `authenticated = false` |
| 中继这侧 | `dsh-relay/src/server.ts:1099` | 手机开 WebSocket 时 `setTimeout(() => ws.close(1013, "tunnel timeout"), 10_000)`，等插件回 `ws_open_ok` |

于是：**半开连接（本机 DNS 走 fake-IP 透明代理时很常见，收不到 FIN）永不触发 `close`** ⇒
`authenticated` 永远为 true ⇒ 插件继续把手机的 `ws_open` 投给一条已经死掉的 socket ⇒
手机等不到 `ws_open_ok` ⇒ 被中继在 **10.00 秒**时以 1013 关掉。那个精确的 10 秒就是中继的
tunnel timeout，不是 App 侧超时。

## 建议修法（二选一或都做）

1. **消费 `pong`**：在 `handle()` 里加 `pong` 分支，记录 `lastPongAt`；
2. **入站静默看门狗**（本机采用，效果确定）：包装 `connect()`，在 socket 上记录
   `lastInboundAt`（中继平时不主动下发任何帧，唯一规律入站就是 pong），每 10 秒检查一次，
   **OPEN 但 >75 秒无任何入站帧**就 `socket.terminate()`，借既有 `close` 流程自愈
   （`authenticated = false` + 退避重连）。

本机实测：修好后日志出现 `relay silent for 8Xs; forcing reconnect`，约 85 秒内自愈，不再需要人工干预。

## 附：诊断 / 复用手法

- **强制重建中继连接而不重启进程**：把 profile patch 里插件条目 `disabled: true` → 等 8 秒 → 改回。
  副作用：会向手机会话发 `device_close`，把手机踢下线，别反复做。
- 若需要离线验证看门狗：用一个"只接受连接、不完成 WS 握手"的 TCP 服务器把真实 socket 钉在
  CONNECTING(0)，再换成假 socket 标记为静默 10 分钟，看下一个 tick 是否调用 `terminate()`。

## 环境

- 插件 0.1.5 / 0.1.9（两版代码在这一处相同）
- 中继 `relay.dshmobile.online`（`dsh-relay` 0.1.9）
