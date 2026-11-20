# BookFish 0.63.0 浏览器辅助 TXT 自主获取模块 · 方案书

- 版本基线：BookFish 0.63.0（= origin/main c440c03，已与 `bookfish-0.63.0/` 逐文件核对一致）
- 开发分支：`feature/txt-acquisition`（从 origin/main 切出，不在 main、不触碰生产）
- 接口：Cortico World API 6
- 性质：新增独立获取引擎，原有书源引擎、Library.importFile、SelectionCoordinator、SSM 全部保留

## 1. 结论先行

三条硬要求的技术落点：

1. **原始字节**：浏览器侧按 48 KiB 分块读 `ReadableStream`，每块在页面内做 base64，经 CDP `Runtime.addBinding` 事件送回 Node，Node 立即 `Buffer.from(b64,'base64')` 写盘并更新 SHA-256；全程不做 UTF-8 字符串转换。
2. **宽松导入有真实代码**：在 `stream-import.ts` 新增 `canonicalizeBestEffort` + `importFileBlobBestEffort`，放宽 `detectEncoding`/`repairBudget`/控制字符/末尾坏字符等硬门槛，单独走 `BookStorage.importFileBestEffort` → `Library.importFileBestEffort`；严格入口 `importFile` 一行不改。
3. **失败可补救**：`data/bookfish/txt-acquisition/` 持久化任务记录与原始字节（`files/<sha256>.bin`），任务状态区分 `failed_recoverable`/`failed_terminal`，提供 status/retry/repair 三个动作；重启后 `recover()` 把未完成任务标成可恢复而**不删文件**。

## 2. 基线与补丁兼容

- 群友补丁 `bookfish-txt-import-patch.zip` 仅作原型参考，**不整文件覆盖**，尤其不覆盖 `src/world.ts`（补丁版删除了 0.63.0 的 `chapters`/`set_start` 面板分支 world.ts:442-453）。
- 已逐文件 diff：`tool-schemas.ts`（+7 行工具声明）、`definition.ts`（+1 行）、`ENV_PROMPT.md`（+7 行）、`describe.json`（+31 行）可增量移植；`txt-import.ts` 重写；`world.ts` 只增量接入。
- 禁止运行补丁里的 `install.ps1`。

补丁缺陷与本方案的修复：

| 补丁缺陷 | 本方案 |
|---|---|
| 端口 9222/9223/9224 无差别探测 | 只连配置项 `browserDebugPort` 指定端口，`0`=禁用；端点必须回环 |
| 建页失败回退到已有页面 | `Target.createTarget` 失败直接抛 `BrowserUnavailableError`，绝不接管已有页 |
| `setTimeout(900)` 当加载完成 | `Page.loadEventFired` + 超时 + `document.readyState` 轮询 |
| `toString('utf8')` 提前转码 | base64 分块 → `Buffer`，落盘原始字节 |
| 任意本地 `path` 导入 | 只接受模块暂存目录内的文件与真实路径校验 |
| `if(!args.path)` 才查网络权限 | 先规范化参数，再对任何联网动作统一查 `allowNetwork` |

## 3. 目录与职责

```
src/txt-acquisition/
  types.ts          任务/状态/质量报告/候选类型与状态机校验
  url-policy.ts     URL、协议、IP 段、DNS 解析与钉扎、重定向校验（ipaddr.js）
  browser-client.ts CDP 连接（仅回环+指定端口）、建页/导航/求值/绑定式分块下载、只关自建页
  link-discovery.ts cheerio 提取 TXT/MD 链接、绝对化、去重、限量、候选命名
  download.ts       文件 sink、实时字节上限、SHA-256、取消、超时、失败清理
  quality.ts        二进制/登录页/可读性/章节结构/广告/截断判定与分级
  repair.ts         BOM、UTF-8/GB18030/UTF-16LE/BE 识别、坏字节、换行、控制字符、尾部残字
  records.ts        任务与原始文件持久化、容量上限、清理、重启恢复
  staging.ts        暂存目录、文件名净化、真实路径校验、符号链接防逃逸
  acquisition.ts    编排：discover/import/status/retry/repair + Library + Selection 接入
  index.ts          统一出口
```

改动（增量）：

- `src/stream-import.ts`：新增 `canonicalizeBestEffort()` 与 `importFileBlobBestEffort()`，严格路径保持原样。
- `src/book-storage.ts`：新增 `importFileBestEffort(file, metadata)`。
- `src/library.ts`：新增 `importFileBestEffort(metadata, file)`，返回 `{ book, report }`；`importFile` 不变。
- `src/config.ts`：新增 `txtAcquisitionEnabled`（默认 true）、`browserDebugPort`（默认 0=禁用）、`txtAcquisitionRetentionMb`（默认 512），只进 advanced 组。
- `src/selection-types.ts`：`SelectionIntent.acquisitionKind?: 'source'|'file'`，校验向后兼容。
- `src/selection.ts`：新增 `onExternalImport()`，复用 `fulfill()`/`recordFailure()`；不新建队列。
- `src/world.ts`：构造 `TxtAcquisition`，注册 `bookfish_import_txt`，`start()` 恢复记录，`stop()` 收尾；`chapters`/`set_start` 原样保留。
- `src/tool-schemas.ts` / `src/definition.ts` / `src/ENV_PROMPT.md` / `describe.json`：工具声明、描述、提示词与自描述。

## 4. 数据流

```
想看的书
  → discover：自有标签页打开资源页（URL 策略校验）→ cheerio 提取候选
  → import：ticket=候选（服务端 candidateId，30 分钟有效）或直接 http(s) 地址
      → 新标签页 → 分块下载原始字节到暂存 → SHA-256
      → 二进制/空/登录页判定（拒绝则保留文件 + failed_*）
      → 宽松解码/补正 → 质量报告
      → Library.importFileBestEffort → bookKey
      → 人工：入架即止；自主：SelectionCoordinator.onExternalImport
  → 失败：failed_recoverable（文件保留）→ retry（重下/重处理）/repair（换编码策略）
```

## 5. 安全边界

- 协议只允许 http/https；`file:`/`javascript:`/`data:` 等拒绝。
- IP 段默认拒绝：回环、私有、链路本地、CGNAT、保留、组播、未指定、云元数据 `169.254.169.254`、IPv6 ULA/链路本地/映射地址等（`ipaddr.js` 判定 + 映射地址解包）。
- 主机名黑名单：`localhost`、`*.localhost`、`*.local`、`*.internal`、`metadata.google.internal` 等。
- DNS：解析全部 A/AAAA，任一为受限地址即拒绝；首次通过的解析结果做**钉扎**，后续同主机必须落在钉扎集合内（DNS 重绑定缓解）。
- 重定向：浏览器侧由 `Fetch.requestPaused` 逐请求校验（含子资源），最多 5 跳；直连下载路径手动跟随并逐跳校验。
- CDP：只允许 `127.0.0.1`/`::1` 且端口等于配置值；`/json/version` 返回的 `webSocketDebuggerUrl` 也必须是回环同端口；不扫描、不复用用户标签页、只关闭本任务创建的 target。
- 本地文件：只读 `txt-acquisition/` 暂存目录；`realpath` 检查前缀、拒绝符号链接、只接受 `.txt`/`.md`、校验大小上限。
- 网络权限：`allowNetwork=false` 时 discover/download 直接拒绝（参数规范化之后统一判定）。
- 访问边界：只用浏览器已有登录态访问用户有权访问的公开下载；不绕登录/付费墙/验证码/DRM/反爬；不上传、不传播。

## 6. 宽松导入分级

- **拒绝**（`failed_terminal`/`failed_recoverable`，仍留文件与记录）：空文件、全空白、二进制（NUL/控制字符为主）、无法解码、登录/验证码/错误页、超过 100 MiB、违反 URL 策略、存储不可用。
- **导入+警告**：少量乱码/坏字节、章节编号跳号、标题格式不一、重复章节、少量广告、目录不全、无章节标题、疑似截断、疑似部分正文、书名作者偏差。
- **自动补正**：BOM、GBK/GB18030、UTF-16LE/BE、换行规范化、少量坏字节替换、尾部残字安全截断、控制字符清理、连续空行压缩。
- 可能改变正文含义的操作（大范围删广告/重复章/整段）**不自动执行**，只记警告。

质量报告：`{ quality:'clean'|'warning'|'partial', warnings[], repairs[], encoding, readableChars, totalChars, truncated, suspectedPartial }`。

## 7. 状态机

`queued → discovering → candidate_ready → downloading → validating → needs_repair → repairing → importing → completed | completed_with_warning | failed_recoverable | failed_terminal`

失败原因代码：`network`、`policy_blocked`、`browser_unavailable`、`download_failed`、`too_large`、`empty_file`、`binary_file`、`unreadable_text`、`not_a_book`、`import_failed`、`disk_unavailable`、`cancelled`、`restart_interrupted`。`recoverable` 由代码表决定。

## 8. 人工 vs 自主

- 人工（`origin:'manual'`）：导入即入架；不选书、不动当前书、不推进度、不建承诺、不写队列。
- 自主（`origin:'autonomous'`）：必须带有效 `intentId`（status 属 acquiring/proposed），成功后调用 `SelectionCoordinator.onExternalImport`；身份完全匹配 → `fulfill()`（唯一队列入口）；身份不匹配 → 只入架 + intent 回 `awaiting_choice`，绝不自动排队。
- 获取成功 ≠ 阅读成功：回执/进度/Episode 一律走原有 SSM 通道，新模块不写 Persona Memory、不写 Story Index。

## 9. 测试矩阵

- 单元：`url-policy`（U06-U09 + 重定向 + DNS 钉扎 + 端口/协议）、`link-discovery`（U01-U05）、`browser-client`（U10、端口唯一、拒绝外部 ws、拒绝接管/关闭已有页、加载事件超时）、`download`（U11 取消清理、分块、上限、超时、SHA）、`repair`（UTF-8/BOM/GBK/GB18030/UTF-16LE/BE/坏字节/尾部残字/混合/二进制拒绝）、`quality`（登录页、空文件、无章节、重复章、广告、截断、部分正文）、`records`（R01-R08、容量清理、重启恢复、重复导入）、`acquisition`（端到端 fake browser：discover→import→警告/拒绝/补正、网络关闭拒绝、人工不改队列）、`selection`（SSM 回归：不推进度、不产生回执、队列只建一次、身份不匹配不排队）。
- 集成：`world.test.ts` 增补工具注册与 `chapters`/`set_start` 保留；`ssm-guard` 回归。
- 命令：`npm test`、`npm run typecheck`、`npm run build:webui`、`npm run verify:world`、`npm run check:ssm`。

## 10. 交付物

源码改造包、补丁兼容报告、浏览器安全测试报告、TXT 容错报告、补正机制报告、SSM 回归报告、构建测试报告、版本差异报告、部署说明、最终审核摘要（全部落在 `bookfish-governance/`）。

## 11. 已知限制（在实现中持续更新）

- 宿主 Cortico 目前没有现成的浏览器控制接口，因此浏览器能力只能通过**用户显式配置的本地 CDP 端口**接入；未配置时 discover/浏览器下载不可用，但「已下载文件的补正/重试」仍可用。
- 网页链接提取不是搜索引擎：资源页仍需模型用宿主已有搜索能力或用户给出地址。
- 无头浏览器环境不做真实 CDP 集成测试；用可注入的 CDP 传输层覆盖协议与安全问题，真实浏览器测试在阶段 4 手工执行并记录。
- 浏览器登录态只能用于正常授权下载；模块不做任何规避访问控制的行为。
