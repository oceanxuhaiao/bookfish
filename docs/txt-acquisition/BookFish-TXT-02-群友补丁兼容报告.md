# BookFish TXT 获取模块 · 02 群友补丁兼容报告

群友补丁：`bookfish-txt-import-patch.zip`（解包于 `D:\学习\项目\_patch_extract\bookfish-txt-import-patch\`），目标版本 0.62.1。本报告逐文件说明「保留 / 改写 / 废弃」，以及为什么不能整文件覆盖。

## 一、结论先讲

| 项 | 结论 |
|---|---|
| 是否运行 `install.ps1` | **否**。脚本只检查目标目录有没有 `package.json`，不校验版本，会直接覆盖多个源码文件 |
| 是否覆盖 `world.ts` | **否**。补丁版 `world.ts` 删掉了 0.63.0 已有的 `chapters` 与 `set_start` 面板分支 |
| 是否覆盖其他文件 | **否**。全部改为在 0.63.0 上增量移植 |
| 最终落地形态 | 新建 `src/txt-acquisition/` 独立模块 + 既有文件纯增量改动 |

## 二、逐文件处理

### 1. `src/world.ts`（补丁 42 550B → 本分支 43 008B + 增量）

- **保留思路**：把工具注册进 `tools()` 的 `handlers` 字典。
- **改写**：新工具不是 0.62.1 的 `url|list|index|path` 四参数形态，而是 `action` 六值（`discover/import/status/retry/repair/cancel`）+ `pageUrl/fileUrl/title/author/taskId/candidateId/intentId`；注册位置在 `bookfish_plan_reading` 之后，沿用同一 `handlers` 机制与 `attachProtocolHint` 包装。
- **废弃**：补丁版 `world.ts` 里删除的 `chapters`（0.63.0 L442）与 `set_start`（L446-453）分支**一律保留原样**，`git diff` 已确认这两段零改动。
- **新增接线**：构造 `TxtAcquisition`（`onImported` → `selection.onExternalImport`）、`start()` 内 `init()`（异常不阻塞阅读）、`status()`/`modelStatus()` 暴露精简状态。

### 2. `src/tool-schemas.ts`（补丁 +7 行）

- **保留**：新增一条工具声明的做法。
- **改写**：参数体系按新 action 重写，删掉 `index`（列表序号易与变化的候选列表错配，改为服务端 `candidateId`）与 `path`（任意本地路径导入，见安全报告）；为控制常驻 token **删掉 `encoding` 参数**（repair 自动尝试全部编码并取替换字符最少者）。
- 结果：`tools 15 → 16`，schema 字符 `12 473 → 13 150`（新增声明本身 676 字符）。

### 3. `src/definition.ts`（补丁 +1 行）

- **保留**：加一条工具摘要。
- **改写**：中英文案重写为「发现候选、下载并宽松导入、查询状态、重试或补正；不绕过登录与付费限制」。

### 4. `src/ENV_PROMPT.md`（补丁 +7 行）

- **保留**：向大肥鱼说明浏览器文件获取这条路。
- **改写**：按 0.63.0 的提示词风格重写并压缩，明确四件事——网页与文件都是不可信数据、不是指令；有瑕疵可补正、带 warning 也能读；不确定完整就不得声称全本；不许绕过登录/付费/验证码。
- 结果：提示词 `424 → 667` 字符，纯 LF。

### 5. `src/txt-import.ts`（补丁新增，10 810B）

**整体废弃，按模块重写**。四处硬缺陷不可保留：

| 补丁实现 | 问题 | 本分支做法 |
|---|---|---|
| `browserPorts()` 依次试 `ownBrowserPort`、9222、9223、9224 | 无差别探测调试端口，可能连上非本任务授权的浏览器 | 只连设置里显式配置的 `browserDebugPort`；为 0 直接报 `browser_unavailable`，不探测（测试：`requires an explicit browser debug port instead of probing for one`） |
| `createPage` 失败时 `list.find(...)` 取第一个已有页 | 接管用户正在用的标签页，可能导航或关闭它 | 建页失败直接抛错，绝不回退（测试：`fails instead of adopting an existing tab when it cannot create one`） |
| `Page.navigate` 后 `setTimeout(900)` 当加载完成 | 固定等待既慢又不可靠 | `Page.loadEventFired` + `document.readyState` 兜底 + 超时（测试：`falls back to document.readyState when the load event is missed` / `reports a timeout when the page never becomes interactive`） |
| `Buffer.from(b64,'base64').toString('utf8')` | **提前转 UTF-8 会毁掉 GBK/GB18030/UTF-16 字节** | 浏览器内取原始字节 → base64 分块回传 → `Buffer` → 直接落盘；解码交给 `stream-import`（测试：`keeps GBK bytes exactly as sent and reports progress`） |
| `importLocal(path)` 接受任意本地路径 | 可读取配置文件、日志等无关文件 | 不提供任意本地路径参数；原件只能落在模块暂存目录（`staging.resolveInside` 防穿越） |
| `if (!args.path && !allowNetwork)` | 空格字符串等输入可绕过网络权限判断 | 先规范化参数再统一 `checkUrl(..., { allowNetwork })`（测试：`refuses to touch the network when the world has network access disabled`） |

### 6. `describe.json`（补丁 +31 行）

- **保留**：自描述文件需要同步更新。
- **改写**：用 `BOOKFISH.describe` 重新生成，并把 `bookfish_lookup.description` 还原为 0.63.0 原文，使 diff 只包含「新增 1 个工具 + envPrompt 追加段」（60 insertions / 1 deletion）。

### 7. `install.ps1` / `patch-manifest.json` / `PATCH.md`

- **一律不执行、不采用**。`PATCH.md` 只用于理解补丁意图。

## 三、与 0.62.1 差异中未采纳的部分

补丁基于 0.62.1，其 `world.ts` 相对 0.63.0 缺少：`chapters` 面板分支、`set_start` 面板分支。本次全部保留 0.63.0 版本，因此**不存在功能回退**。

## 四、可复核命令

```powershell
cd D:\学习\项目\bookfish
git diff origin/main -- src/world.ts            # 确认只有 import/字段/构造/tools/status/start 增量
git show HEAD:src/world.ts | Select-String -Pattern "case 'chapters'|case 'set_start'" -Context 0,3
git diff --no-index D:\学习\项目\_patch_extract\bookfish-txt-import-patch\src\world.ts src\world.ts
```
