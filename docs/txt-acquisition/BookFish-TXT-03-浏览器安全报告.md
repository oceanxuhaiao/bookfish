# BookFish TXT 获取模块 · 03 浏览器安全报告

覆盖：CDP 连接、标签页隔离、URL 与 IP 策略、DNS 与重定向、网络权限、落地页复检。全部条目都有自动化测试。

## 一、CDP 连接

| 要求 | 实现 | 测试 |
|---|---|---|
| 只连明确配置的端口 | `BrowserClient` 构造即校验：必须是 1024–65535 的整数，`browserDebugPort=0` 时 `TxtAcquisition` 直接报 `browser_unavailable` | `only accepts a dedicated port in the user range`、`requires an explicit browser debug port instead of probing for one` |
| 不扫描 9222/9223/9224 | 代码中不存在端口列表，唯一的端点构造是 `http://127.0.0.1:${port}/json/version` | 同上 |
| 只接受本机 WS | 拿到 `webSocketDebuggerUrl` 后过 `isLoopbackWs(url, port)`：必须是 `ws:`、无 userinfo、端口等于配置端口、主机只能是 `127.0.0.1`/`::1`/`localhost` | `refuses a WebSocket that is not loopback on the configured port` |
| 不把 CDP 当普通 HTTP 用 | 只发 `Target.*`、`Page.*`、`Runtime.*` 白名单方法，无任意 URL 请求 | 代码审计 + `drives its own tab, waits for load, and closes only that tab` |

## 二、标签页隔离

- `createPage()`：`Target.createTarget({url:'about:blank', background:true})` → `Target.attachToTarget({flatten:true})`；**任何一步失败都直接抛错**，代码里没有「取已有页」的分支。
- 只记录自建 target，`closeTarget` / `disconnect` 只关闭这些 target；`PageSession.close()` 关的是自己的会话。
- 任务结束（成功、失败、取消、页面读取异常）都在 `finally` 里关页并断开。
- 不用固定 900ms：`navigate()` 等 `Page.loadEventFired`，miss 时用 `document.readyState` 兜底，最终必须是 `complete`/`interactive`，否则 `timeout`。

对应测试：
- `fails instead of adopting an existing tab when it cannot create one`（断言只发了 `Target.createTarget`，没发 `getTargets`/`attach`，自建集合为空）
- `drives its own tab, waits for load, and closes only that tab`
- `falls back to document.readyState when the load event is missed`
- `reports a timeout when the page never becomes interactive`
- `closes a tab it created when attaching fails, and never leaves it behind`

## 三、URL 与地址策略

`checkUrl(raw, { allowNetwork, resolve })`：

1. 网络权限关闭 → `policy_blocked`，**不做 DNS 解析**。
2. 必须是可解析的绝对 URL；仅 `http:` / `https:`（`file:`、`javascript:`、`data:` 等一律拒绝）。
3. 剥离 URL 中的 `username`/`password`，不把凭据带进日志或记录。
4. 主机名：命中 `BLOCKED_HOSTNAMES`（`localhost`、`metadata`、`metadata.google.internal`、`instance-data` 等）或后缀（`.localhost`、`.local`、`.internal`、`.lan`、`.home.arpa` 等）即拒绝；单标签主机名视为内网。
5. 字面量 IP 用 `ipaddr.js`：`isBlockedAddress` 先查云元数据精确地址（`169.254.169.254`、`169.254.170.2`、`100.100.100.200`、`fd00:ec2::254`），IPv4-mapped IPv6 递归检查其 IPv4 地址，其余要求 `range() === 'unicast'`（loopback/private/linkLocal/uniqueLocal/carrierGradeNat/reserved/unspecified/multicast/broadcast 全部阻断）。
6. 域名解析：`dns.lookup(host, { all: true, verbatim: true })`，**任一**答案落在被阻断的段即拒绝（防 DNS 重绑定与混合答案）。

对应测试（`tests/txt-acquisition-url.test.ts`，11 例）：`accepts public http and https addresses and strips credentials`、`refuses every non-HTTP protocol`、`refuses loopback, private, link-local and metadata addresses given literally`、`refuses a public hostname when DNS answers with an internal address`、`refuses to resolve anything when the world has no network permission`、`classifies address ranges with ipaddr.js`。

## 四、重定向

`download.ts` 逐跳处理：`redirect: 'manual'`，每次 301/302/303/307/308 都重新解析 `Location` 并再次 `checkUrl`；最多 5 跳。

对应测试：`re-checks every redirect hop and follows a normal chain`、`refuses a redirect that points at a loopback or metadata address`、`stops after five redirects`。

## 五、浏览器落地页复检（超出补丁的关键修正）

浏览器会**自行跟随重定向**，初始 URL 通过策略并不代表最终页面合规。因此 `defaultPageLoader` 在 `page.navigate(url)` 之后：

```ts
await verifyLandedUrl(await page.evaluate<string>('location.href'), { allowNetwork: options.allowNetwork, resolve: options.resolve });
```

只有落地地址再次通过 `checkUrl` 才读取 `document.documentElement.outerHTML`。落地地址为空或不是字符串同样拒绝。

对应测试（4 例）：`re-checks where the tab actually landed, not only the address it was given`、`refuses a page that redirected into a local, private or metadata address`（含 `169.254.169.254`、`10.0.0.5`、`file:///C:/Windows/win.ini`）、`refuses a landing address whose DNS answers only non-public ranges`、`refuses to read a page when the browser reports no landing address or network is off`。

## 六、本地文件与暂存目录

- 工具接口**不提供任意本地路径参数**（补丁的 `path` 已删除）。
- 原件与工作文件只能在 `data/bookfish/txt-acquisition/` 之下；`staging.resolveInside(relative)` 校验 resolve 结果必须等于根或位于根之下，防目录穿越。
- 不跟随符号链接逃逸：原件路径由模块自己生成（`<sha256>.txt|.md`），不接受外部提供路径。
- 只接受 TXT/Markdown 语义：链接发现阶段按扩展名筛选，导入阶段 `buildBook` 再校验扩展名与大小。

## 七、网络权限与访问边界

- `worlds.bookfish.allowNetwork=false` 时：`discover` 直接抛 `policy_blocked`/`network access is disabled`，`downloadFile` 在发请求前拒绝。
- 先规范化参数再统一检查，不存在「空格字符串绕过」的窗口。
- 只做「读取用户本就有权访问的页面/文件」：不提交表单、不点击、不注入脚本、不携带或被要求提供 Cookie/Authorization，不绕过登录、付费墙、验证码或 DRM。下载到的正文不上传、不分享。

对应测试：`refuses to reach the network when the world has no network permission`、`refuses to touch the network when the world has network access disabled`、`refuses to discover while the feature is disabled`。
