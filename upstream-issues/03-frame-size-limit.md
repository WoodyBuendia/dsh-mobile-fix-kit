# Issue 3 — 单个 WebSocket 帧超过中继 4 MiB 上限会把整条设备连接打死，手机端"点历史对话永久载入 + 之后全部 Failed to fetch"

## 现象

1. 手机点侧边栏某个历史对话 → 一直"载入历史"，永不结束；
2. **随后**新对话、发消息也全部失败：`client api: session/prompt failed: Failed to fetch (gateway/internal)`；
3. 看起来像"所有对话都打不开"，其实是**隧道已经被拆掉、App 不自愈**；把 App 从最近任务划掉重开才恢复。

## 根因链（每一环都有实测判据）

1. **会话首页快照是单个 WebSocket 帧**。客户端开会话走 `session/follow`，首次 `yield` 就是整个快照
   （DSH 侧 `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`，
   切片包含区间内全部事件，工具输出也在内）。
   实测：某会话首页帧 **5,330,920 B**（另一 3,340,479 B、2,812,916 B）。
2. **插件把它放大 ×1.778**：`src/relay-client.ts:496` 把 DSH 帧 `base64` 塞进
   `ws_frame.dataB64`，`src/relay-client.ts:201` 的 `cipher.seal()` 再整体 base64url
   （AES-256-GCM 只加 16 B tag）⇒ 5.08 MiB → **9.04 MiB**。
3. **中继单帧上限 4 MiB，且 `/device` 与浏览器共用同一个 `WebSocketServer`**：
   `dsh-relay/src/server.ts:76` `MAX_WS_PAYLOAD_BYTES` 默认 `4 * 1024 * 1024`，
   `:966` `new WebSocketServer({ maxPayload: wsPayloadLimit })`，
   `:1058` `if (url.pathname === "/device") wss.handleUpgrade(...)`。
   实测：向 `wss://<relay>/device` 首帧发 5 MiB → **关闭码 1009**；3 MiB → 未超限（走到鉴权，4003）。
4. **插件反应过度**：设备 socket 一 close，`src/relay-client.ts:173/176` 调
   `closeAllSessions()`（`:535`），把该插件**所有**手机隧道一起拆。
5. **App 不自愈** ⇒ 之后每个请求都 `Failed to fetch`。

**阈值**：DSH 侧帧 > **2.25 MiB**（4 MiB ÷ 1.778）就会触发。也就是"重对话必死、轻对话没事"。

## 建议

- **首选：分片**。内层协议给大帧加 `chunk` / `final`（或复用 `seq`）字段，接收端重组；
  这样任何大小的历史都能过。若 App 侧暂不支持，至少在插件里**检测单帧超限并回一条可诊断的错误**，
  而不是把整条设备连接交给中继 1009 关掉、连带 `closeAllSessions()`。
- **次选：文档写明上限**。README 里给出"外发帧 = DSH 帧 × 1.778、中继默认 4 MiB、阈值 2.25 MiB"，
  并说明症状是"隧道被拆 + 之后全 Failed to fetch"。
- 使用者侧的缓解（本机在做）：把 DSH 的历史首页压小（宿主 `paginate()` 限
  `maxMessages ≤ 40 / minMessages ≤ 8 / minTurns ≤ 1`），实测最坏会话外发帧 9.02 → 2.21 MiB。

## 环境

- 插件 0.1.5（在用）/ 0.1.9（`src/relay-client.ts:34-37` 的 `MAX_*` 与单帧转发逻辑未变）
- 中继 `relay.dshmobile.online`（`dsh-relay` 0.1.9）
- 判据与量测工具见 <https://github.com/WoodyBuendia/dsh-mobile-fix-kit>
  （`tools/measure-frame.mjs` 量 DSH 首页帧、`tools/exact-outer.mjs` 算外发帧、
  `tools/relay-limit-probe.mjs` 量中继单帧上限）
