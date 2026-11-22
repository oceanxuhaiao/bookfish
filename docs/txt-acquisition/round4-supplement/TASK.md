# 《BookFish TXT 获取模块第四阶段补充修复：身份真实性、Selection 终态与策略撤销闭环》

> **交付 Codex 的执行任务书｜2026-11-22**  
> 项目：《看书吧！大肥鱼》（BookFish）  
> 版本：0.63.0（不得据此推定远程 main 仍处于该版本）  
> 审核包：`BookFish-TXT第四阶段-第一阶段审核包-71cf8f3-20261121.zip`  
> 审核快照：`71cf8f3b517e141f6893341129f40a5a7b60b383`  
> 生产源码冻结点：`12d8a03dfbcc96e41f4ccc53d927a4c789d4818c`  
> 原分支：`codex/txt-acquisition-round4`  
> 工作性质：第四阶段第一阶段后的**定向补充修复**，不重做已通过的七项 P1。  
> 授权：在隔离工作区连续完成调查、最小修复、测试、文档与本地提交；**不授权推送、合并、生产部署、管理员系统改动**。

## 0. 核心指令（必须先读）

本轮只解决第四阶段独立审核发现的四个闭环问题：

1. **P1-8 身份真实性：** 直接 URL 的目标书名/作者不能冒充下载来源的独立身份声明。
2. **P1-9 获取终态：** TXT 发现、下载、校验、导入失败后，Selection 不能永久卡在 `acquiring`，重启后也不能卡死。
3. **P1-10 策略撤销：** 网络或自主找书开关关闭后，迟到的成功回调不得把 `deferred` 自动改成 reading / queued。
4. **P2-1 历史回执：** 未完成的 Selection 接入回执不能因为历史任务超过100条而被清理丢失。

这是**独立审计提出的代码风险和必要验证**，不是对所有触发场景均已完成真实宿主复现的结论。执行时先写能失败的回归测试，再进行最小修复；如测试推翻假设，保留证据并调整结论，不要为了符合报告强行改代码。

不得为了提高“测试通过率”重写 TXT 下载架构、收紧宽松导入、改变 SSM 阅读语义或移除防护。**文件入架成功 ≠ 作品身份确认 ≠ 进入阅读队列 ≠ 已读。**

## 1. 接力、范围与证据纪律

### 1.1 Git 基线

开始前执行并保存：

```powershell
git status --short --branch
git branch -vv
git log --oneline --decorate -20
git worktree list
git remote -v
git fetch origin --prune
```

必须比对：

| 比较范围 | 用途 |
|---|---|
| `71cf8f3 → 最终 HEAD` | 本轮补充修复全部改动（主审计范围） |
| `12d8a03 → 最终 HEAD` | 相对于上一生产源码冻结的行为变化 |
| `35e364a → 最终 HEAD` | 第四阶段累计修复 |
| `d5878f9 → 最终 HEAD` | 第三轮以来累计修复 |
| `40858d9 → 最终 HEAD` | 第二轮后续总体变化 |
| `08e0c7e → 最终 HEAD` | 整体安全加固 |
| `c440c03 → 最终 HEAD` | 0.63.0 集成全量及 SSM 保护范围 |

还要检查当前真实 `origin/main`，不得把历史 `c440c03` 错当最新 main。若正在使用的 worktree 有未提交工作，不得覆盖、重置、清理；优先在 `71cf8f3` 上创建独立 worktree/分支（建议 `codex/txt-acquisition-round4-supplement`，冲突时更名），不得碰其他 SSM 开发分支。

### 1.2 需要阅读的文件

先读 `AGENTS.md`、`docs/txt-acquisition/PROGRESS.md`、`docs/txt-acquisition/round4/TASK.md`、`round4/00-审核入口.md`、`round4/04-Selection状态恢复.md`、`round4/05-取消与放弃语义.md`、`round4/06-小说身份匹配.md`、`round4/12-SSM差异审核.md`、`round4/15-最终验收摘要.md`，再读实际代码及测试。报告只是索引，结论须由代码与实测支持。

优先检查以下**上一快照的1基行号**（最终修改后重新标注行号）：

- `src/txt-acquisition/acquisition.ts:468-487, 489-560, 591-661, 672-709, 805-820`
- `src/txt-acquisition/quality.ts:80-90`
- `src/txt-acquisition/link-discovery.ts:22-45, 69-82`
- `src/selection.ts:110-143, 230-250, 483-536, 539-609, 707-720, 780-840`
- `src/selection-types.ts`（Intent 状态/失败码/持久化验证）
- `src/txt-acquisition/records.ts:75-119`
- `src/txt-acquisition/types.ts:9-42, 112-135`
- `src/world.ts:81-89, 251-259`；`src/tool-schemas.ts:44-50`

本轮若必须修改其他文件，报告须解释原因。不得使用单元测试的 mock 结果冒充真实 Coopanion/MV3 验收。

## 2. P1-8：直接 URL 导入的身份真实性

### 2.1 需要修复的具体逻辑

当前 `importDirect()` 对文件名执行 `extractIdentity(filename)` 后，用 `identity.title ?? title` 和 `identity.author ?? input.author` 补充来源 metadata；其中 `title/author` 是**用户或模型的目标**，不是从下载来源独立取得的证明。随后 `quality.ts` 的 `identityMatch(wanted, declared)` 可能把双方相同误判为 `exact`。

**强制分离：**

- `wanted`：用户/大肥鱼提出的目标书名、作者。
- `declared`：独立来源实际声明的书名、作者（文件名、页面锚文本、允许使用的可信元数据）；缺失时保持缺失，不得从 wanted 回填。
- `identity`：仅表示已取得的独立 metadata 与目标匹配程度，不代表正文真伪、版权授权、完整性或官方版本认证。

对 `novel.txt`、`download.txt`、`123.txt`、纯哈希名、无独立作者、空锚文本、来源含糊等情况，不得得到虚构的 `exact`。显式声明了标题但缺作者时，通常为 `partial`；无独立有效标题时为 `unknown`。只在实际取得的**独立标题和作者**均满足规范化严格匹配时，才可能标 `exact`。若 metadata 由低可信来源提供，还须在报告中说明“exact 只是 metadata 一致”，不得声称正文已验真。

保持宽松入架：身份 `partial/unknown` 时**可以导入有效正文**，但自动选书的 `queueOnImport=false`、`awaiting_choice` 必须持续有效，直至有明确确认。不得强迫用户修复小瑕疵，也不得把错误身份文件直接自动排队。

### 2.2 最小必测

| 用例 | 预期 |
|---|---|
| `novel.txt` + 目标书名作者 | 来源身份不足，不能 exact |
| `download?id=...` 或纯数字文件名 | 不得由目标回填来源 |
| 文件名/页面只声明书名、无作者 | partial 或 unknown，不自动排队 |
| 来源声明书名和作者均完全匹配 | metadata exact 可以成立 |
| 来源标题不同、作者相同 | 非 exact |
| 来源同书名但为修订版/续作 | 不抹去版本差异 |
| 源声明与实际正文不一致 | 不能声称正文验真；缺证据时不自动排队 |
| 人工直接导入同一文件 | 入架但不创建自主承诺 |

验证直接 URL、发现候选两条路径，以及关闭/重开 Library 后仍不自动排队。

## 3. P1-9：TXT 任务与 Selection 终态一致

### 3.1 已识别的失配

`World` 为 TXT 任务配置 `onTaskCreated` 和 `onImported`，但没有与 TXT 失败/取消对应的持久终态同步。`runDiscovery()` 在没有链接或异常时将 TXT 任务置为 failed；`Selection.recover()` 遇到“仍可找到 TXT 任务记录”就跳过，可能让 Intent 永久保留 `acquiring`，从而阻断下一次自主找书。

### 3.2 修复契约

增加**统一、持久、幂等**的 TXT 状态协调机制（可使用 `onTaskTerminal`/`onTaskStateChanged`，或在恢复时以 taskId 查询；名称不限，但必须覆盖所有路径）。明确以下区别：

| TXT 事实 | Selection 预期 |
|---|---|
| 仍在发现/下载/处理 | acquiring，且关联正确 taskId |
| 成功入架，metadata exact | 若策略仍有效且 Intent 未终止，正常 fulfill/queue |
| 成功入架，partial/unknown | awaiting_choice、queueOnImport=false |
| 可恢复失败（含 no_candidates、网络异常） | 离开僵死 acquiring；保留相同任务重试机会和失败说明，不凭空换书 |
| 终止失败 | 记录明确失败；不继续占用 acquiring |
| 取消或放弃 | 保留取消/放弃终态，不自动恢复 |
| 任务存在但状态/文件损坏 | fail-closed；不得因记录存在就认为仍在执行 |
| 入架已成功、回执持久化失败 | 重启后幂等补偿，不重下载、不重复入架/排队 |

失败处理与已有自主选书轮次、冷却、最多三本等原则兼容。可恢复失败可由合法的显式 retry 恢复**同一作品同一任务**；不得因为任务失败就无授权自动更换作品，亦不能让失败任务无限占住“正在获取”门禁。

可以复用当前 `SelectionIntentStatus` 的 `deferred/failed` 及结构化 failure code；若确有必要引入 `awaiting_retry` 等新状态，必须给出持久化迁移与旧数据兼容测试，避免为一次修复不必要地扩大 schema。**恢复到自动排队须满足正确身份、当前策略许可和有效 Intent 三项条件**。

首次成功通知、失败通知、取消、重试、重启恢复都要保证 at-least-once 事件下的幂等性。不要依赖事件只来一次，也不要把异步通知异常回滚成已成功的入架失败。

### 3.3 用户/模型可用的结束操作

检查 `bookfish_acquire` 当前仅有 `resolve/find/start/status/plan`，缺少取消与放弃动作。以最小暴露面补齐**可实际调用**的取消/放弃路径（优先扩展既有单工具，不引入多个新常驻工具）；同步 `tool-schemas.ts`、`world.ts`、`describe.json`、必要提示词及上下文预算测试。不得只实现一个没有入口的内部 `Selection.cancel()`。

区分用户明确取消与大肥鱼在既有规则内自主放弃；任何操作都要针对准确 intentId，不能全局取消其他无关任务。模型不得声称未收到成功回执的取消已经执行。

### 3.4 必测

- 无 TXT 候选、候选过期、404、下载中断、导入/编码拒绝、磁盘异常：TXT 终态同步到 Selection，不永久 acquiring。
- 失败后同一任务 retry 成功、失败后用户选择放弃、失败后重新选另一本。
- TXT 状态为 `failed_recoverable` 或 `failed_terminal`，但记录仍存在时，关闭并重开 Library/World 两次；不得跳过终态协调。
- 消息先到、后到、重复到、回调抛异常、记录写盘失败、进程在提交间隙退出，不能重复承诺或错误入队。
- 人工导入 `origin=manual` 或没有 intentId：不改变 Selection。
- 至少一项通过模型可见工具调用取消/放弃的端到端处理测试；不止直接调用内部函数。

## 4. P1-10：策略撤销后的迟到回调不得复活

### 4.1 待验证竞态

`Selection.onConfigChanged()` 把 `searching/awaiting_choice/acquiring` 置为 `deferred`，但 `deferIntent()` 不必然关闭 `queueOnImport`；`onExternalImport()` 对 `deferred` 没有与取消同等级的拒绝自动排队保护。

可能发生：文件已入架 → 回执前等待 `dropRaw()` → 用户关闭网络或自主找书 → Intent 变 deferred → 迟到 exact `onExternalImport()` 重新 fulfill/queue。此交错需以 Barrier 测试**复现或推翻**，不能仅由推断宣称已复现。

### 4.2 修复原则

- 明确保存策略撤销原因/时间或等价的**持久撤销栅栏**，防止旧 attempt 的迟到事件绕过新策略。
- 策略关闭导致的 deferred 必须禁止自动排队和自动阅读选择；必要时 `queueOnImport=false`。
- 可以登记已经不可逆地提交的 `bookKey`，但不能改变被撤销的意图决定；已入架书保留，`confirmedChars=0`。
- 重新启用网络/自主获取开关**不等于重新授权旧 Intent**；如果产品允许继续，必须有明确、可追溯的恢复动作和幂等条件。
- 已有 `abandoned/cancelled/completed/failed` 终态保护不能被这次修复破坏；不要把所有 deferred 不加区分地永久封死，也不能在没有策略许可时自动恢复。

### 4.3 必测（真实异步交错）

```text
TXT 文件已经成功入架
→ Barrier 暂停 dropRaw 或 Selection 回调前的等待点
→ 关闭网络权限 / 关闭自主找书（分别测试）
→ Intent 持久化 deferred，自动排队许可撤销
→ 释放 Barrier，迟到 exact onExternalImport 抵达
→ 书籍保留、Intent 不变成 reading、队列仍空、confirmedChars=0
→ 重启两次，仍保持上述结果
```

再补：关闭策略发生在最后一个字节之前、刚入架之后、回执持久化失败时、取消与策略关闭竞争、重新开关后重复旧回调。不修改生产阅读队列语义，不以直接删除已入架书籍解决。

## 5. P2-1：历史清理不能丢失未完成 Selection 回执

当前 `AcquisitionRecords.trim()` 主要依据 `isTerminal`、`!file?.retained` 和 preserveId 决定历史淘汰，未保护 `task.selection?.status === pending/failed`。当 clean 文件释放原件、任务数量超过100时，可能清理掉仍需重放的 Selection 回执。

### 修复要求

1. 未完成（pending/failed）的 Selection 接入回执及其重放依据必须被保护，或者先完成另一个**可证明可靠的持久补偿记录**再淘汰任务。
2. 区分**100个活跃任务硬上限**与**历史记录软上限**；不能为了保持100条总数硬删除待补偿数据。
3. 超限时应可观察、可诊断；若选择有界 tombstone/补偿队列，必须证明重启仍可恢复。
4. 确认成功回执持久化后，满足安全条件的旧记录可被清理；不得无限增长而没有容量策略。
5. `resumeSelection()` 需要能拿到所有未完成回执，不能只依赖未被 trim 的偶然历史。

### 必测

- 创建超过100条终态历史，夹杂 clean、无原件、Selection pending/failed 项，执行 trim；待补偿项不丢失。
- 注入 Selection 回调成功但保存 receipt 失败；重启两次后最终唯一完成。
- 回调重复、Selection 不可用、书已删除、无 intent、人工导入无 Selection receipt。
- 历史被允许淘汰后仍不产生重复书架项/队列项。
- 模拟任务数量持续增加时，证明容量/溢出状态可观测。

## 6. 横向不变式与必须保留的旧成果

本轮改动后以下行为必须仍成立：

- 宽松导入：少量乱码、缺章、标题不规则、广告或疑似截断仍以 warning/partial 优先；不把身份不确定变成文件硬拒绝。
- 原始下载字节和 SHA-256、retained 原件、retry/repair、流式解码、100MiB 上限、书籍版本隔离仍有效。
- 分页索引与原文一致；`confirmedChars=0`，不伪造已读 Receipt、Episode、Persona Memory，不改变 Story Index 的证据原则。
- `Library.importFile` 严格入口、原有书源引擎、SSM 主链、NovelFetch 的既有行为不回退。
- Node DNS 全答案检查、固定 socket、重定向防护和 MV3 4MiB 分块/ACK/租约/Attempt/Consumer/迟到上传保护保持不变。
- `controllerReady=false`、`browserReady=false` 在没有正式控制器时持续 fail-closed；不要为测试向正式 World 注入永久 true Guard。
- 用户已取消、放弃或因策略撤销暂停时，后续下载或回调不得自动复活承诺；成功入架的书籍不应因后续队列错误被删除。

如改动 `selection-types.ts`/`world.ts`/`tool-schemas.ts`/`describe.json`/提示词，应重跑工具预算和冻结契约检查；如改动 `library.ts`，必须专项检查旧书、不同 revision、阅读进度和 SSM。

## 7. 测试顺序与验收门槛

### 阶段 A：复现和最小修复（立即授权）

依次完成 P1-8、P1-9、P1-10、P2-1。每项先创建**修复前失败**的可执行测试，记录失败输出；修复后验证通过。可以在本阶段内部连续修复，不必每个小点都询问用户。若现有架构与建议处理方式冲突，先报告影响而非盲目扩展 schema。

### 阶段 B：针对性集成回归（立即授权）

至少在非生产隔离数据目录中验证：

1. direct URL → import → quality identity → Selection → queue 的全链路。
2. no_candidates/下载失败 → TXT 终态 → Selection → 两次重启 → retry / abandon。
3. 书已提交 → 策略关闭 → 迟到回调 → 重启。
4. terminal clean + pending/failed receipt → 100+历史 trim → 恢复。
5. 既有旧版7项P1和SSM阅读边界回归，禁止退化。

使用 fake/mock 仅验证代码逻辑，真实本机 HTTP 测试仅证明对应 Node 通路；不得据此宣称真实浏览器或 Coopanion 已验收。无需再重复昂贵的 WFP/VM 实验。

### 阶段 C：全面工程检查与冻结（立即授权）

按 `AGENTS.md` 的真实命令执行；至少包括：

```powershell
npm test
npm run typecheck
npm run build:webui
npm run verify:runtime
npm run verify:world
npm run check:ssm
```

在适当的 Cortico 根仓库再执行适用的 `pnpm describe:extension` / `pnpm check:extension`（参数遵循本仓库说明）；验证生产 bundle、工具 schema 和 `describe.json` 同步。

- `verify:world` 必须把**完整模式**与 `--no-fetch` 分开汇报，不能用 no-fetch 替代；若合法候选缺失，保留 FAIL，并说明拒绝错书符合预期。
- 重新记录真实通过/失败/skip数量，不能沿用旧版 `908` 作本轮声称。
- `check:ssm` 需要同时比较 main历史基线与本轮最新提交；`blocked=0, review>0` 仍为“待独立审核”，**不得执行 `--accept-review`**。
- 如果未修改流式算法，无需把旧性能基准重跑当作先决条件；但若身份、终态改动改变完整入架耗时，记录差异并说明，不声称 Token 收益。

冻结代码，提交本地修复提交与最后审核快照，输出从 `71cf8f3` 到最终 HEAD 的独立 diff、完整测试日志和真实已知限制。**不推送远程，不合并 main。**

## 8. 暂缓的真实宿主与系统级工作

### 8.1 `round3-host.mts`：现在不运行

用户已明确决定：在代码修复、自动化回归、冻结和独立审核之前，**不要求用户运行** `round3-host.mts`，不创建新普通账户，不以管理员终端强行运行。此脚本不能证明浏览器 DNS 隔离，不可作为本轮代码缺陷修复的替代。

本轮完成后仅提交“是否已经具备一次性普通权限隔离宿主验收条件”的报告；**未经用户下一次明确安排，不直接要求用户执行命令**。如将来授权，必须先核验脚本路径、隔离数据目录、不读取生产书架且不需要管理员权限，运行一次并记录完整日志。

### 8.2 正式浏览器控制器：不授权实施

Windows 共享 `Dnscache` 代发 DNS 的强制边界未解决。保持 `controllerReady/browserReady=false`。不得实施 WFP 持久规则、管理员服务、全机 DNS/代理/防火墙变更、Hyper-V/VM 启用、浏览器安装、日常浏览器 Cookie 读取或生产部署。WFP 与 VM 的技术路线另行由用户决定。本轮最多记录不影响本地安全状态的设计建议。

## 9. 停止条件与变更管理

触及以下情况停止对应工作并报告：修改生产书架或 SSM受保护语义；需改变自主选书产品决策（例如默认自动换书、默认确认身份、自动重启旧意图）；需要管理员权限或系统网络规则；发现无法恢复的书籍丢失风险；需要清除未知工作树文件；需要绕过 controllerReady；测试可能使用真实用户登录凭据。

只暂停受影响部分，继续完成其他已授权的独立项。不得自动把“新状态/新工具”引发的常驻 token 增长合理化；必须测量工具 schema/提示词差异并优先最小化新增面。

## 10. 必须交付的审核包

建议目录 `docs/txt-acquisition/round4-supplement/`，文件至少：

| 文件 | 内容 |
|---|---|
| `00-独立审核入口.md` | HEAD、基线、已读/未读、证据索引、权限边界 |
| `01-身份真实性.md` | 修复前反例、来源字段血缘、direct/候选路径测试 |
| `02-获取终态与恢复.md` | TXT→Selection 状态映射、失败/重试/两次重启/模型可见操作 |
| `03-策略撤销与迟到回调.md` | Barrier 复现、撤销栅栏、入架后回调不排队 |
| `04-历史回执保留.md` | 100+历史裁剪、pending/failed 保护、容量上限与恢复 |
| `05-全量与SSM回归.md` | 全部命令、运行环境、真实 PASS/FAIL/BLOCKED/skip、SSM review |
| `06-版本差异与安全边界.md` | 七条Git比较范围、未修改模块、安全保护不变说明 |
| `07-最终验收摘要.md` | 逐项 PASS/PARTIAL/FAIL/BLOCKED/NOT_TESTED；未闭环项、建议下一步 |
| `evidence/` | 原始日志、测试输出、修复前后断言、可复现脚本（脱敏） |

每个结论附实际代码路径和**最终快照的1基行号**、触发条件、最小验证与结果；不能把报告文字、单元测试或局部实验视为实际宿主的验收证据。不要打包 Cookie、token、浏览器 profile、真实用户小说全文或生产书架数据。

## 11. 最终验收表（由 Codex 填写并交独立审核）

| 验收项 | 必须成立 |
|---|---|
| 目标/来源身份 | 无独立声明就不可能 exact；仍可宽松入架 |
| 选书队列 | partial/unknown 及 awaiting_choice 不自动入队，重启后保持 |
| 获取失败 | no_candidates/下载/导入异常不会永久占用 acquiring |
| 失败恢复 | 合法 retry 同任务幂等；不自动换书、不复活取消意图 |
| 可用结束操作 | 模型或用户能可靠取消/放弃准确 intent，工具声明与实现一致 |
| 策略撤销 | 迟到 exact 回调不能突破 deferred/撤权边界 |
| 已入架但撤权 | 书籍保留、无队列、confirmedChars=0 |
| 历史回执 | pending/failed 不被100条历史淘汰，恢复后恰好一次接入 |
| 数据正确性 | 原件哈希、版本、索引、分页、阅读进度及原7项P1不退化 |
| SSM | blocked=0 仍须独立 review；无 accept-review |
| 真实宿主 | 本轮继续未测试，不把 FakeHost 冒充真实验收 |
| 浏览器控制器 | 无正式控制器时持续 fail-closed |
| 合并发布 | 不推送、不合并、不部署，须另行批准 |

**验收状态必须显式标记**：PASS / PARTIAL / FAIL / BLOCKED / NOT_TESTED。全部代码项达到可独立复核状态后，提交审核包；本轮完成**不自动授权**下一阶段、真实宿主操作、WFP/VM 实施或生产发布。

---

### 给 Codex 的最后指令

**连续自主执行本轮定向修复，但只在明确边界内行动。先复现、后修复、再回归；遵守“入架宽松、身份谨慎、状态可靠、撤权生效、历史可恢复”的统一产品语义。冻结后提交完整审核包，不要再让用户现在运行 `round3-host.mts`。**
