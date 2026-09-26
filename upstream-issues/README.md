# 已向上游提交的 issue

| # | 标题 | 链接 | 状态 |
|---|---|---|---|
| 2 | 插件拿不到 DSH 的浏览器签名 cookie，手机端只能看到 `dsh web authentication required` | https://github.com/april-jk/dsh-mobile-plugin/issues/2 | open |
| 3 | 中继连接半死时插件永远自报 connected，手机侧失败恰好 10.00 秒且无法自愈 | https://github.com/april-jk/dsh-mobile-plugin/issues/3 | open |
| 4 | 单个 WebSocket 帧超过中继 4 MiB 上限会打死整条设备连接 | https://github.com/april-jk/dsh-mobile-plugin/issues/4 | open |

正文对应本目录 01/02/03 三份 Markdown（提交内容与文件一致，仅去掉 Markdown 首行标题）。

**上游修复后怎么判断能不能升级**（在目标版本上跑，200 才算过了授权那一关）：

```js
import { RelayClient } from '<plugin>/dist/relay-client.js';
const headers = RelayClient.prototype.upstreamHeaders.call({ config: { dshPort: 3080 } }, {});
const res = await fetch('http://127.0.0.1:3080/', { headers, redirect: 'manual' });  // 期望 200
```
