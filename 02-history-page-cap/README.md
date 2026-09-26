# dsh-mobile 历史载入卡死 —— 会话首页上限补丁

## 结论速查

| 项 | 值 |
|---|---|
| 症状 | 手机 App 点侧边栏历史对话 → 一直"载入历史"；随后**新对话、发消息全部** `Failed to fetch` |
| 直接根因 | 会话首页快照是**一个** WebSocket 帧；插件把它二次 base64 密封（×1.778），公网中继的 `MAX_WS_PAYLOAD_BYTES`（默认 4 MiB）超限 → 中继以 **1009** 关闭 **/device 设备连接** → 插件 `closeAllSessions()` 拆掉手机所有隧道 |
| 为什么"长的短的全不行" | 首次超限后 App/WebView 不会自愈，之后**任何**请求（含短对话、`session/prompt`）都报 `Failed to fetch` |
| 补丁位置 | `node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` 与 `lib/types/history.js` 的 `paginate()` |
| 补丁内容 | `maxMessages ≤ 40`、`turnWindow.minMessages ≤ 8`、`minTurns ≤ 1` |
| 效果（离线复算） | 全 22 个会话的外发帧从最大 **9.02 MiB** 降到最大 **2.21 MiB**（限制 4 MiB） |
| 生效条件 | **必须重启 `dsh-web.service`**（补丁是被 require 的宿主代码） |
| 回滚 | `revert.sh`（备份在 `Work/backups/dsh-page-cap-<时间戳>/`） |

## 证据链

1. **实测 DSH 侧首页帧大小**（本地 mux ws 回放，`mobile-diag/measure-frame.mjs`）：
   5,330,920 B（文献阅读与复现）/ 3,340,479 B（K波段波导阵列）/ 2,812,916 B（SAR）/ 1,498,928 B。
2. **封装倍率 ×1.778**：插件先 `base64` 塞进 `ws_frame.dataB64`，E2EE `seal()` 再整体 base64url
   （`relay-client.js` + `e2ee.js`）。`mobile-diag/exact-outer.mjs` 逐字节复算，比例恒定 1.778。
3. **中继上限实测**：向 `wss://relay.dshmobile.online/device` 首发 5 MiB 帧 → 关闭码 **1009**；
   3 MiB 帧 → 走到鉴权，关闭码 4003 `auth failed`。上限在 3–5 MiB 之间，与源码
   `MAX_WS_PAYLOAD_BYTES` 默认 `4 * 1024 * 1024` 一致（`dsh-relay/src/server.ts:76,966`，
   同一 `WebSocketServer` 服务 `/device`，`server.ts:1058`）。
4. **真机时序**：15:17:35 手机点开 SAR 会话（预测外发 4.74 MiB）→ **15:17:36 插件日志
   `Relay disconnected`**；中继访问会话记录显示那条 access session 恰在 15:17:35 结束。
5. **反证**：15:30–15:37 前置代理抓包时，插件外发帧最大只有 **75 KB** ——
   说明那段时间手机根本没走到"取历史"，是隧道死后的卡死态（用户截图报 `Failed to fetch`）。

## 哪些对话会触发（补丁前）

| 会话 | 外发帧 | 判定 |
|---|---|---|
| 文献阅读与复现-A dual circularly polarized… | 9.02 MiB | ❌ 断开 |
| K波段波导阵列天线方案… | 5.65 MiB | ❌ 断开 |
| 无人机载SAR成像虚影分析… | 4.74 MiB | ❌ 断开 |
| 手机端又有问题查一下（本对话） | 4.10 MiB | ❌ 断开 |
| 其余 18 个 | ≤3.84 MiB | ✅ 可载入 |

阈值：DSH 帧 > **2.25 MiB**（= 4 MiB ÷ 1.778）就会把隧道打死。

## 用法

```bash
bash Work/dsh-mobile-page-cap/apply.sh     # 幂等；已打过会跳过
bash Work/dsh-mobile-page-cap/revert.sh    # 从最近一次备份还原
# 之后重启（会掐断 agent 自身，用延迟重启）：
systemd-run --user --on-active=40 --unit=dsh-page-cap-restart systemctl --user restart dsh-web.service
```

手机侧：**App 从最近任务里划掉再打开**（WebView 卡死态不会自己恢复）。

## 已知不足

- 补丁改的是 `node_modules`，**`npm install` / DSH 升级会覆盖**；升级后重跑 `apply.sh`。
- 只压小历史首页；若将来出现单个事件 >2.25 MiB（当前最大 0.61 MiB），仍会超限。
- 桌面端 GUI 首页消息数变少，向上滚动时多几次分页请求（协议本身支持 `prepend`）。
- 彻底方案是把中继自建并调大 `MAX_WS_PAYLOAD_BYTES`（或让上游插件做分片）。
