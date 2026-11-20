> **2026-11-21 第二轮审查更正：** 本文件是上一轮历史报告。当前安全门槛未通过；事后 URL 检查不能阻止请求发生。第二轮真实浏览器与 Coopanion 验收尚未进行，不能按旧勾选项宣布可发布。以 [第二轮基线与安全阻断报告](ROUND2-BASELINE-AND-BLOCKER.md) 为准。

# BookFish TXT 获取模块 · 11 浏览器扩展通道（Edge / Chrome）

分支：`D:\学习\项目\bookfish` → `feature/txt-acquisition`　基线：`origin/main` = `c440c03` = 0.63.0
本报告对应新增需求（用户 m01117）：**装了扩展的 Edge/Chrome 用户可以直接使用本功能**。

## 1. 为什么不能直接用 CDP

| 方案 | 现实约束 |
|---|---|
| 连接用户日常浏览器的调试端口 | 用户日常启动的 Edge/Chrome **默认不开放** `--remote-debugging-port`；想用 CDP 必须关掉浏览器、改启动参数再开，登录态页面也会一起关掉 —— 与「装好扩展就能用」相悖 |
| 由本模块自己启动一个受控浏览器 | 那只是另一个干净浏览器，没有用户的登录态，回到「要登录/要付费墙」的老问题 |
| 无差别探测 9222/9223/9224 | 属于群友补丁的缺陷，且会把别的调试会话当成本扩展的资源，已在 03 号报告里明确废弃 |

因此本轮采用 **MV3 扩展 + 世界进程内 loopback 桥**：桥在 `127.0.0.1` 上开一个小端口，扩展主动轮询取任务，用**用户自己浏览器的 cookie 和 TLS** 抓页面与文件；世界只负责派活和收原始字节。Edge 与 Chrome 同为 Chromium，一份 `extension/` 通用。

CDP 通道没有被删除：`browserDebugPort > 0` 时仍按 03 号报告的规则连接**唯一指定的回环端口**，只作为扩展不可用时的备用路径。

## 2. 结构

```
扩展 service worker ──GET /bridge/jobs（长轮询 25s）──▶ 世界 127.0.0.1:47823
        │                                                   │
        │◀── job {kind:'page'|'file', url, maxBytes} ────────┘
        │
        ├─ page：fetch(url, credentials:'include') → POST /jobs/:id/page {html, finalUrl}
        └─ file：流式读 body → 每 4MiB POST /jobs/:id/chunk（裸字节）→ POST /jobs/:id/done
                                （失败→ POST /jobs/:id/fail {code, message}）
```

- 桥由 `src/txt-acquisition/bridge.ts`（401 行，Node 原生 `node:http`）实现，**没有新增任何依赖**（WebSocket 服务端方案被否决：要自己实现 RFC6455，收益为零）。
- `TxtAcquisition` 侧：`ensureBridge()` 按配置启停；`runDiscovery` 优先用桥取页面，`runPipeline` 优先用桥取文件；两条路都只拿**原始字节**，解码仍在 `stream-import` / `repair` 里做，没有提前转码。
- 扩展只搬运字节：判断、补正、导入、质量报告全部留在世界侧。

## 3. 安全边界

| 面 | 做法 | 证据 |
|---|---|---|
| 监听范围 | `server.listen(port, '127.0.0.1')`，默认 47823，可配置；不监听 `0.0.0.0` | `tests/txt-acquisition-bridge.test.ts` ① |
| 配对 | `bridge.json` 里 48 字符 base64url 令牌；`Authorization: Bearer` 或 `x-bookfish-token`，`timingSafeEqual` 比对，缺失/不符 401 | ② |
| 来源 | 无 `Origin` 放行（扩展 SW 的请求）；有 `Origin` 时必须 `chrome-extension://…` / `moz-extension://…`，网页来源一律 403；**不返回 CORS 头**，网页无法读取响应 | ② |
| 令牌不外泄 | 令牌只经 WebUI 面板（`txt_bridge`）返回，不进工具参数、不进模型上下文、不进日志 | `src/world.ts` 设置面板分支 |
| 标签页 | 完全不接管、不关闭、不读取任何标签页；后台 `fetch`，不弹窗 | `extension/background.js` |
| 落地地址 | `page` 与 `done` 都再跑一次 `checkUrl`：即使浏览器自行 302 到内网/云元数据地址也会被拒 | ④、`verifyLandedUrl` |
| 内容类型 | `done` 校验 `text/plain`、`text/markdown`、`application/octet-stream` 等；`text/html` 明确拒绝（「返回的是网页不是文件」） | ⑥ |
| 体积 | 页面正文 8 MiB、单块 4 MiB、原文件仍受 `MAX_BOOK_BYTES` 100 MiB；累计超限立刻 `too_large` 并清理 | ⑤、代码 |
| 字节完整 | 桥一边追加一边累计 SHA-256，`done` 可带 sha256 复核，不符即 `download_failed`（The bytes changed in transit） | ⑤ |
| 网站边界 | 只用用户已有登录态访问**他有权访问**的页面；不登录、不付费、不绕过验证码/DRM；拿到的文件不上传、不传播 | `extension/README.md`、`src/ENV_PROMPT.md` |

## 4. 代码改动清单

新增：

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/txt-acquisition/bridge.ts` | 401 | 回环 HTTP 桥：长轮询派活、分块收字节、落地校验、令牌/来源校验、`Settled` 式结算 |
| `extension/manifest.json` | 17 | MV3，`storage`/`alarms` 权限，`http://127.0.0.1/*` + `<all_urls>` |
| `extension/background.js` | 174 | 轮询、抓页面、流式下载分块、错误码映射、alarms 保活 |
| `extension/popup.html` / `popup.js` | 30 / 36 | 端口与令牌输入、状态显示、支持整段粘贴「端口 / 令牌」 |
| `extension/README.md` | 22 | 安装、配对、安全说明、故障排查 |
| `tests/txt-acquisition-bridge.test.ts` | 206 | 桥的 8 个用例 |

修改（相对 `5e4cd49`）：

| 文件 | 增/删 | 内容 |
|---|---|---|
| `src/txt-acquisition/acquisition.ts` | 99/15 | `ensureBridge`、`bridgeInfo`、`stop`、`restartBridge`，发现/下载分流，`BridgeError` 归类 |
| `src/txt-acquisition/download.ts` | 3/3 | `ALLOWED_CONTENT` 导出为 `TEXT_CONTENT_TYPE` 供桥复用 |
| `src/config.ts` | 18/2 | `browserBridgeEnabled`、`browserBridgePort`（默认 false / 0，进「高级」组，端口 0 或 1024–65535） |
| `src/world.ts` | 5/1 | 设置面板 `txt_bridge` / `txt_bridge_restart`；`stop()` 释放回环端口 |
| `src/webui/settings.ts` | 16/2 | 「现成的 TXT 文件」卡片：两个开关、两个端口、配对信息与复制按钮 |
| `package.json` | 1/0 | `files` 加 `extension`，随包发布 |
| `tests/txt-acquisition-flow.test.ts` | 54/0 | 端到端：调试端口与直连都被禁用，页面与文件全部经扩展完成 |
| `tests/webui/settings.test.ts` | 19/0 | 开关持久化 + 配对信息显示 |
| `lib/webui.js` | 69/1 | `npm run build:webui` 重建产物 |

## 5. 验证结果

| 命令 | 结果 |
|---|---|
| `npm test` | **71 文件 / 745 测试通过**（新增 8 个桥用例、1 个端到端、2 个设置用例） |
| `npm run typecheck` | exit 0 |
| `npm run build:webui` | exit 0（Built lib/webui.js 等） |
| `npm run verify:world` | exit 1，缺 `output/novel-runtime/…zip`；已在未改动基线上复现同一 ENOENT，属环境缺失（见 07 号报告） |
| `npm run check:ssm` | `blocked=0 review=7 allowed=66`；7 个 review 文件与上一轮相同，需 SSM 负责人确认；`src/txt-acquisition/*`、`extension/*`、新测试均 not-protected |

桥的 8 个用例覆盖：回环绑定与令牌持久化、401/403 鉴权、page 回传、落地到内网 IP 被 policy 拒绝、GBK 原始字节逐字节保留 + SHA-256、HTML 内容类型拒绝、`permission_missing` 映射为不可恢复的 `policy_blocked`、`stop()` 时挂起任务收敛。

端到端用例（`tests/txt-acquisition-flow.test.ts`）刻意把 `pageLoader` 与 `fetchImpl` 都设成抛错：只要还有一丝走到调试端口或直连网络的路，这个用例就会失败。它证明「页面 → 候选 → 下载 → 宽松导入 → 入架」整条链路确实由扩展承载。

## 6. 未完成 / 已知限制

1. **没有在真实 Edge/Chrome 里跑过**：本环境没有可自动化的浏览器实例，也没有扩展签名与商店发布。桥与扩展协议由伪扩展（测试里的轮询客户端）逐字节验证，真实浏览器的手工验收需要你在自己机器上做一遍（步骤见下）。
2. **扩展是「加载解压缩的扩展」**：未上架 Edge 加载项商店 / Chrome 应用商店，因此没有自动更新，版本随世界包一起升级。
3. **令牌是本地明文**：`data/bookfish/txt-acquisition/bridge.json`（扩展侧在 `chrome.storage.local`）。本机进程本来就能读数据目录，故未再加密；删除该文件并重启世界即轮换令牌。
4. **扩展需要 `<all_urls>` 主机权限**：它必须能访问你指定的任意资源站；这一点在安装时会明确告知。
5. **单任务串行**：桥同时最多 4 个等待任务，扩展 SW 一次处理一个 job（够用，但批量下载不会并行加速）。
6. **`verify:world` / `verify:runtime` 仍因缺运行时 ZIP 阻塞**（与本次改动无关，环境缺失）。

## 7. 手工验收步骤（真实浏览器）

1. `npm run build:webui`，按 09 号报告的方式挂载世界，设置里打开「允许获取现成的 TXT 文件」与「用 Edge/Chrome 扩展取文件」，保存；卡片应显示「等待扩展连接（端口 47823）」和一段令牌。
2. `edge://extensions` 或 `chrome://extensions` → 开发者模式 → 加载解压缩的扩展 → 选 `extension/`。
3. 点扩展图标，把卡片上复制的「端口 / 令牌」整段粘进任一输入框 → 保存并连接；应显示「已连接」。
4. 让大肥鱼找一本公开且可下载的书，观察：任务状态从 `discovering` → `candidate_ready` → `downloading` → `importing` → `completed(_with_warning)`；书架出现新书，阅读进度仍为 0。
5. 反向验证：关掉扩展 → 任务应在超时后以 `browser_unavailable` 失败，并且文件与任务记录保留，可用 `retry` 重来。

## 8. 回滚

- 关掉「用 Edge/Chrome 扩展取文件」并保存，或在设置里把 `browserBridgeEnabled` 置 false：桥停止监听，扩展轮询失败即静默等待，功能回到只有调试端口/无浏览器的状态。
- 完全回滚到 `5e4cd49`（上一轮 TXT 模块）或 `c440c03`（0.63.0）：`git revert` 对应提交即可；`extension/` 与 `bridge.ts` 是纯新增，删除不影响既有书架、进度与 SSM。
- 桥的残留：停止世界时会释放端口；`bridge.json` 可安全删除（下次启动重建令牌，扩展需重新配对）。
