# Issue 1 — 插件拿不到 DSH 的浏览器签名 cookie，手机端打开界面只能看到 `dsh web authentication required`

## 现象

配对成功后，手机 App 能看到计算机名和**对话列表**，但点进去打不开 DSH 界面，只有一行：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

## 复现（在 0.1.9 上实测，不需要手机）

用插件自己的 `upstreamHeaders()` 原样转发一个请求到本机 DSH：

```js
import { RelayClient } from '<plugin>/dist/relay-client.js';
const headers = RelayClient.prototype.upstreamHeaders.call({ config: { dshPort: 3080 } }, {});
console.log(headers);                                   // => { host: '127.0.0.1:3080', 'x-dsh-mobile-remote': '1' }
const res = await fetch('http://127.0.0.1:3080/', { headers, redirect: 'manual' });
// status: 401
// body:   dsh web authentication required; reopen the URL printed by dsh web.
```

`headers` 里**没有任何 cookie** —— 这就是根因：

## 根因

DSH Web 对**每一个浏览器请求**都要求一枚**签名 cookie**（`@deepseek-ai/dsh-client-connection` 的
`isAuthenticated()`），且没有旁路：

- 唯一合法取得途径：用 `/?token=<本进程 launchToken>` 换 cookie（`authorizeIndex()`）；
- `trustedHosts` **不能**绕过鉴权（它只管 Host/Origin 反 DNS-rebinding 的 403 围栏）；
- 插件在 `src/relay-client.ts:205` 的 `upstreamHeaders()` 里只做 host/origin/referer 重写，
  **只透传手机带来的 cookie**，而手机永远没有这枚 cookie。

## 建议修法（本机已验证可用）

插件进程内能拿到 DSH 的 `connection` 服务（就是 `dsh web` 打印访问 URL 的那个服务）：

1. `const url = connection.authenticatedUrl()` 取到带 token 的 URL；
2. 请求一次，从 `set-cookie` 里拿到签名 cookie；
3. 在 `upstreamHeaders()` 里把这枚 cookie 合并进 `cookie` 头（HTTP 与 WebSocket 都走这里）。

本机实测：加上之后同一请求从 401 变成 200，手机端恢复正常。

### 两个必须处理的坑

1. **`ctx.get("connection")` 默认 strict**：provider fiber 尚未 ACTIVE 时返回 `undefined`，
   插件激活那一刻去取可能取不到 ⇒ **必须重试**（本机是失败每 5 秒重试，成功后 6 小时刷新一次）。
2. 若用 `patchReload: "live"` 热加载改动，**只重建 loader 条目、不重新导入 ESM 模块**：
   改完 `dist/` 必须重启进程才生效。

## 环境

- 插件：`@april-jk/dsh-mobile` 0.1.5（在用）与 0.1.9（本次实测）
- DSH Web：`dsh web`（`@deepseek-ai/dsh-client-connection` 等），Linux/WSL2
- 复现命令见上，全程本机，不需要手机

---

（正文由使用者整理；如需要我可以补一份最小 diff / 参考实现。）
