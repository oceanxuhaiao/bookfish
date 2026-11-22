# 《BookFish TXT 获取模块第四阶段最终收尾：导入身份展示、候选确认指引与失败操作边界》

**交付对象：** OpenAI Codex  
**项目：**《看书吧！大肥鱼》（BookFish）  
**当前审核对象：** 第四阶段补充修复审核包 `7332574`  
**生产源码冻结：** `77a5af8094d34ea728b5b731ddfabc6846a0ea00`  
**最终审核快照：** `73325749cc68b0611cba9becbfdae1ba117292ea`  
**上一补充修复基线：** `71cf8f3`  
**当前产品版本：** 审核候选仍为 0.63.0；不得假定远程 `main` 仍为 0.63.0  
**任务性质：** 最后一次小范围产品语义与工具指引收尾  
**执行模式：** 阶段授权、连续自主执行、阶段末交付审核包

---

## 0. 核心决定

第四阶段补充修复的四项核心工作（身份来源分离、TXT/Selection 终态协调、策略撤销栅栏、历史回执保护）已经完成定向回归。**本轮不重做这些工作，不重写 TXT 获取架构。**

本轮只处理上一次独立审核确认的两个问题：

1. **P1-11：`awaiting_choice` 的模型操作指引没有区分“搜索候选待选”和“TXT 已入架但身份不匹配待确认”。**
2. **P1-12：TXT 来源身份与目标身份不一致时，书架仍可能使用用户目标书名/作者作为实际作品显示身份，造成错书伪装成目标作品。**

同时，只检查并明确记录一个相邻边界：终止失败后的 `retry/repair` 是否可能违反自主选书协议。除非发现可复现的越权路径，不要顺手重构 retry 状态机。

本轮的产品原则：

- 文件成功入架，不等于作品身份确认。
- metadata exact 只代表来源元数据与目标匹配，不代表正文真伪、版权授权或版本真实性。
- 身份不匹配的有效 TXT 仍可宽松入架，但不得伪装成用户目标作品。
- 搜索候选待选与已入架作品待确认是两种不同状态语义，必须给大肥鱼不同的下一步指引。
- 不因本轮修复而收紧 TXT 正文质量门槛，不拒绝仅有小瑕疵的有效小说。
- 不自动推进阅读进度，不伪造 `confirmedChars`、阅读回执或 Persona Memory。

---

## 1. Git 接力与范围保护

### 1.1 开始前必须核实

执行并保存：

```powershell
git status --short --branch
git branch -vv
git log --oneline --decorate -25
git worktree list
git remote -v
git fetch origin --prune
```

必须确认：

- 当前分支、HEAD、工作区状态。
- `77a5af8` 和 `7332574` 的实际祖先关系。
- 当前真实 `origin/main`。审核包记录的 `origin/main=1fc504f`（0.65.1）只是当时快照，必须重新获取，不能假定仍是最新。
- 不覆盖其他 worktree、SSM 分支、未提交工作或用户数据。

优先从 `7332574` 的审核快照创建独立 worktree/分支。若仓库实际接力方式不同，先说明并保留原工作区，不得 reset、clean 或覆盖。

### 1.2 必须阅读

至少阅读：

- `AGENTS.md`
- `docs/txt-acquisition/PROGRESS.md`
- `docs/txt-acquisition/round4-supplement/TASK.md`
- `docs/txt-acquisition/round4-supplement/00-独立审核入口.md`
- `docs/txt-acquisition/round4-supplement/07-最终验收摘要.md`
- 本任务涉及的源码、工具 schema、协议和测试。

上一审核快照的关键位置（最终修改后重新标注行号）：

- `src/selection.ts:560-616`：`onExternalImport()` 的身份不匹配分支。
- `src/selection.ts:693-720`：`announce()` 对 `awaiting_choice` 使用统一 guidance。
- `src/selection.ts:976-997`：Selection summary/candidates。
- `src/selection.ts:816-862`：显式 queue/plan 逻辑。
- `src/txt-acquisition/acquisition.ts:479-499`：direct URL 来源 metadata。
- `src/txt-acquisition/acquisition.ts:604-645`：`importDecoded()` 的身份评估与实际入架 metadata。
- `src/stream-import.ts:150-187`：分页书籍的 title/author/id 构造。
- `src/books.ts:18-60`：书籍 ID 由规范化 title/author 构成。
- `src/library.ts:647-665`、`src/book-storage.ts:99-103`：宽松入架路径。

报告只是索引。必须以当前 checkout 的源码为准，重新定位并记录最终 1 基行号。

---

## 2. P1-11：区分两类 awaiting_choice，修复大肥鱼的操作指引

### 2.1 已确认的问题

当前 `Selection.onExternalImport()` 在 TXT 来源身份不是 `exact` 时：

- 将 Intent 设为 `awaiting_choice`；
- 保存 `bookKey` 和 `acquisitionTaskId`；
- 设置 `queueOnImport=false`；
- 写入 `identity_mismatch` failure；
- 调用 `announce(intent, 'awaiting_choice', 'import')`。

但 `announce()` 只根据 `status === 'awaiting_choice'` 选择 guidance，没有根据 `stage` 区分来源。

当前统一指引近似为：

> Search returned exact candidates. Call status for server candidate ids, then start with one id.

这只适用于搜索候选待选，不适用于 TXT 已经入架、但身份不匹配的情况。

TXT 导入产生的 Intent 不一定有 `SelectionCandidate[]`。大肥鱼照当前指引调用 `status` 后可能没有搜索候选，再调用 `start(candidateId)` 也无法完成“接受已入架作品”的决策。

### 2.2 必须实现的状态语义

至少区分：

| 条件 | 语义 | 大肥鱼下一步 |
|---|---|---|
| `status=awaiting_choice` 且 `stage=search` | 搜索产生多个候选，等待选择版本/来源 | `status` 查看候选，再 `start(candidateId)` |
| `status=awaiting_choice` 且 `stage=import` | TXT 已入架，但来源身份与目标不完全一致 | 查看获取任务和书架记录，向用户/自身说明差异；明确接受后才 `plan(queue)`，否则可放弃 |
| `status=awaiting_choice` 但 stage 缺失/未知 | 状态来源无法确认 | fail-closed，不得假定存在搜索候选，也不得自动排队 |

不得只根据 status 判断；应使用已有的 `stage`、`failure.code`、`acquisitionTaskId`、`bookKey` 等持久字段进行判别。若字段组合互相矛盾，应给出安全的诊断信息并停止自动动作。

### 2.3 TXT 身份待确认时的 guidance 契约

当 `stage=import` 且 `failure.code=identity_mismatch`：

1. 明确说明文件已经入架，但其来源书名/作者与原目标不完全一致。
2. 明确给出 `intentId`、`acquisitionTaskId`、`bookKey`（已有字段可提供时）。
3. 引导大肥鱼调用现有 `bookfish_acquire(action="status")` 查看该 TXT 获取任务和来源信息。
4. 说明不得把目标书名当作来源真实书名。
5. 不得调用搜索候选 `start(candidateId)` 流程。
6. 不得自动进入阅读队列。
7. 只有在确认这是用户/大肥鱼愿意接受的已入架作品后，才调用现有 `bookfish_acquire(action="plan", planAction="queue")`。
8. 如果不接受，可以按现有合法的 abandon 流程结束该自主选书意图；不得删除已入架书籍。
9. 如果来源信息不足，明确说“身份信息不足/待确认”，不能编造来源书名或作者。

### 2.4 实现约束

- 优先使用现有 `announce(intent,status,stage)` 的 `stage`，不要另建一套并行状态机。
- 可以抽取纯函数生成 guidance，便于单测。
- 如果 status 工具当前不能根据 `intentId` 返回关联 TXT task 详情，先检查现有 API；只做最小必要扩展，返回安全字段，不暴露签名 URL、Cookie、token 或其他秘密。
- `bookfish_acquire` 仍保持现有工具数量和主 schema 结构；不为此新增常驻工具。
- 不改变搜索候选的既有 `status → start(candidateId)` 流程。
- 不得把 `plan(queue)` 变成无需明确确认的自动动作。
- 不得让 partial/unknown 因模型再次调用 status 而变成 exact。
- 不得因为身份待确认而自动搜索或替换成另一本小说。

### 2.5 必须新增的测试

**A. 搜索候选等待：**

- 创建多个有效候选。
- 进入 `awaiting_choice, stage=search`。
- 触发通知。
- guidance 必须要求 status 查看候选，再 start 一个有效 candidateId。
- 不得出现“已入架”“plan queue”等 TXT 导入语义。

**B. TXT 身份不匹配等待：**

- 创建 autonomous TXT task 并关联 Intent。
- 导入有效正文，identity=partial/unknown。
- 书籍入架，Intent=`awaiting_choice`、`queueOnImport=false`。
- 触发 `stage=import` 通知。
- guidance 必须引导查看 TXT task 和 bookKey，再明确 plan(queue) 或 abandon。
- 不得要求 `start(candidateId)`。
- 队列保持为空，`confirmedChars=0`。

**C. 无来源元数据：**

- `novel.txt`、无标题/作者声明。
- guidance 只能说身份信息不足，不能生成虚构来源身份。

**D. 重复通知与重启：**

- 同一 awaiting_choice 通知重复触发。
- World/Selection 重启后恢复通知。
- guidance 仍然按 stage 正确区分，不重复排队。

**E. 终态和撤权保护：**

- 已 abandon/cancelled/deferred 的 Intent 不得因 guidance 刷新而重新激活。
- 只生成指导，不执行 plan 或 start。

---

## 3. P1-12：书架展示身份不得冒充用户目标身份

### 3.1 已确认的问题

当前 `importDecoded()` 已经通过 `assessText()` 得到 `declared` 并计算身份匹配，但调用 `Library.importFileBestEffort()` 时，传入的书籍 metadata 仍使用：

```ts
{
  filename,
  title: task.target.title,
  author: task.target.author
}
```

这导致：

- 用户目标是《海风》/小鱼；
- 文件来源声明为《另一部》/小鱼；
- 身份结果为 partial；
- 但书架仍可能显示《海风》/小鱼。

这样会把身份不匹配的作品展示成目标作品，后续书架浏览、阅读讨论和阅读足迹都可能误认作品。

### 3.2 必须分离三个身份概念

代码和数据流必须明确区分：

1. `wantedIdentity`：用户/大肥鱼原本想找的作品，来自 `task.target`，用于匹配和 Selection 意图。
2. `declaredIdentity`：下载来源独立声明的作品身份，来自实际文件名、发现页面元数据或其他现有来源证据；缺失字段必须保持缺失，不能从 wanted 回填。
3. `libraryDisplayIdentity`：书架实际展示的身份，必须忠实反映来源证据或明确标记未确认，不能假装等于 wanted。

不得将三个概念重新合并成一个 `title/author` 对象。

### 3.3 书架显示规则

按以下优先级执行：

**规则 A：来源有独立声明标题**

- 书架 title 使用来源声明标题，而不是用户目标标题。
- author 只使用来源实际声明的作者。
- 来源没有作者时，不得把目标作者填进去。
- 如果来源声明与 wanted 不一致，保留 `identity_mismatch`/待确认状态和关联任务信息。

**规则 B：来源没有独立有效标题**

- 不得将 wanted title 直接作为书架真实标题。
- 使用明确的中性占位展示名，例如“未确认作品（文件名）”。
- 若同名占位会导致不同来源作品被合并/误认为同一作品，必须使用稳定且非秘密的区分因子（例如内容 SHA-256 的短摘要）避免身份键碰撞；不要使用签名 URL、Cookie、token 或完整 URL。
- author 留空或使用明确的未确认显示状态，不得补入 wanted author。

**规则 C：来源标题与目标标题相同，但作者缺失或不匹配**

- title 可显示来源声明标题。
- author 只显示来源声明作者；缺失则留空。
- 身份仍为 partial/unknown，不能自动排队。
- 不得因为标题相同就补入目标作者并变成 exact。

**规则 D：metadata exact**

- 书架可显示独立来源声明的 title/author。
- 仍需在文档中说明 metadata exact 不等于正文真实性、版权授权、版本真实性或完整性证明。

### 3.4 不允许的做法

- 不允许把 wanted title/author 回填成 declared identity。
- 不允许在 `buildBook()` 前用目标字段覆盖来源声明。
- 不允许只修 UI 标签而让底层 `Book.title/author/id` 仍然冒充目标身份。
- 不允许因标题变化破坏已有书籍、历史版本、阅读进度或书架引用。
- 不允许覆盖已有不同 revision 的作品。
- 不允许把待确认作品自动合并到用户原本想找的作品。
- 不允许为了身份展示而修改 `Library.importFile` 严格入口。
- 不允许将身份不匹配升级为正文硬拒绝；有效 TXT 仍可入架。

### 3.5 兼容与最小改造要求

先检查 `Book`、`buildBook()`、`Library.importFileBestEffort()`、分页 blob key、revision、duplicate 判定和书架 UI 的现有约束。

优先采用**最小可兼容方案**：

- 仅调整 TXT acquisition 专用宽松导入路径传入的 display metadata；
- `task.target` 保持原样，继续用于 wanted identity 和 Selection；
- `CandidateRecord`/任务记录保留来源独立声明；
- 不修改严格导入入口；
- 不迁移或重命名历史书籍；
- 不修改已有书籍 revision 或阅读进度；
- 对无法安全生成稳定 display identity 的情况，先提交方案，不得自行大范围改 `Book` schema。

如果必须新增持久化字段（例如身份确认标记或来源声明快照），必须先证明仅靠现有 `Book.title/author` 和任务记录无法满足需求，并提供：
- schema 迁移方案；
- 旧数据兼容；
- 备份/回滚；
- 不影响已有 bookKey/revision；
- SSM 影响分析。

未经用户额外批准，不实施大范围 Library schema 迁移。

### 3.6 必须新增的测试

| 场景 | 目标身份 | 来源声明 | 预期书架显示 |
|---|---|---|---|
| 1 | 海风/小鱼 | 另一部/小鱼 | 另一部/小鱼，不得显示海风 |
| 2 | 海风/小鱼 | 海风/另一作者 | 海风/另一作者，partial，不自动排队 |
| 3 | 海风/小鱼 | 海风/作者缺失 | 海风/作者留空，partial/unknown |
| 4 | 海风/小鱼 | 标题、作者均缺失，文件 novel.txt | 中性未确认标题，不得显示海风/小鱼 |
| 5 | 海风/小鱼 | 海风/小鱼 | 海风/小鱼，metadata exact |
| 6 | 海风/小鱼 | 海风（修订版）/小鱼 | 保留修订版差异，不得抹平 |
| 7 | 两个不同内容 generic novel.txt | 无标题/作者 | 不得因相同占位名误合并 |
| 8 | 已有旧版海风 + 新导入错书 | 另一部/小鱼 | 旧书、revision、进度全部保留 |
| 9 | manual 导入 | 无 autonomous intent | 不创建 Selection 承诺，不改变现有行为 |
| 10 | retry 同一原件 | 来源声明不变 | display identity 稳定，不生成重复书籍 |

还必须验证：
- 书架 UI 展示名称与持久化 `Book.title/author` 一致；
- 任务 status 中仍能看到 wanted 与 declared 的区别；
- Selection 仍关联正确 `bookKey`；
- identity partial/unknown 时队列为空；
- `confirmedChars=0`；
- 同一原件 retry 不因 metadata 显示名改变而丢失原件或破坏引用。

---

## 4. 相邻边界：终止失败后的 retry/repair（只调查，不顺手重构）

上一审核发现 `Acquisition.retry()` 对 `failed_terminal` 仍保留显式 retry 能力，而自主选书协议要求终止失败后不能自动换源/换版本/恢复。

本轮只做以下核查：

1. 明确区分 autonomous TXT task 与 manual task。
2. 检查 `failed_terminal` 的 retry 是否需要明确用户动作。
3. 检查模型是否可能在收到终止失败 guidance 后自行调用 retry/repair，绕过“终止失败后不得自动重试”的产品约束。
4. 检查 repair 已入架但质量有瑕疵的原件是否仍允许用户主动修复。
5. 输出行为矩阵和测试结果。

如果发现 autonomous terminal failure 能被模型在没有明确用户/产品授权的情况下自动 retry、换源或换版本，增加最小保护和回归测试。

如果现有行为已经要求明确的用户/模型决策，且没有自动绕过路径，则只记录结论，不修改通用 retry/repair API。

不得禁用所有 `failed_terminal` repair；用户可能需要修复自己已有的原件。不得让大肥鱼因失败自动换成另一本书。

---

## 5. 横向不变式：必须全部保留

本轮不得破坏：

- 第四阶段补充修复四项已完成能力：
  - wanted/declared 身份分离；
  - TXT 失败与 Selection 终态协调；
  - 策略撤销栅栏；
  - pending/failed Selection receipt 历史保护。
- TXT 宽松导入：小瑕疵优先 warning/partial，不因身份不确定拒绝有效正文。
- 原始下载字节、SHA-256、retained 原件、retry/repair、流式解码和100MiB边界。
- 共享原件锁、配额保护、目录安全检查。
- `Library.importFile` 严格导入入口及现有书源引擎。
- 书籍 revision、重复导入、分页索引和旧书阅读进度。
- `confirmedChars=0`，不伪造阅读回执、Episode、Persona Memory。
- 大肥鱼独立阅读人格：不得自动替换目标作品，不得强制继续找书。
- Node DNS 全答案检查、固定 socket、重定向防护。
- MV3 原始字节、4MiB 分块、ACK、Lease、Attempt、Consumer 和迟到上传保护。
- 没有正式控制器时 `controllerReady=false`、`browserReady=false`，始终 fail-closed。

---

## 6. 测试与验收

### 阶段 A：先复现，再最小修复

每个问题先写修复前失败的测试并保留输出。

**P1-11 至少覆盖：**
- search awaiting_choice guidance；
- import identity_mismatch guidance；
- 缺来源元数据 guidance；
- 重复通知与重启；
- abandon/deferred/cancelled 不复活；
- status 返回 task/bookKey 的关联正确且不泄露秘密。

**P1-12 至少覆盖：**
- 来源 title/author 不同；
- 来源 title 存在、author 缺失；
- 来源 title 缺失；
- generic filename 内容不同；
- 旧书和不同 revision 并存；
- retry 稳定性；
- 书架 UI 与持久化 Book metadata 一致；
- manual import 不受影响。

### 阶段 B：集成回归

在隔离数据目录验证完整链路：

1. direct URL → 来源身份提取 → 质量评估 → 入架 display identity → Selection awaiting_choice → guidance。
2. 搜索候选 → awaiting_choice → status → start，确保旧路径不回归。
3. TXT 身份不匹配 → status → 明确接受 → plan(queue)，确认只有明确决策后入队。
4. TXT 身份不匹配 → abandon，确认书籍保留、队列为空。
5. 来源无身份 → 中性书架展示名 → status 能区分 wanted/declared。
6. 同名 generic filename 的不同内容不得错误合并。
7. 历史旧书、revision、阅读进度、严格导入和人工导入回归。
8. terminal failure retry/repair 边界验证。

### 阶段 C：工程检查与冻结

按仓库 `AGENTS.md` 执行。至少：

```powershell
npm test
npm run typecheck
npm run build:webui
npm run verify:runtime
npm run verify:world
npm run check:ssm
```

同时按项目实际要求运行扩展描述文件、工具 schema、bundle 检查。

要求：
- 完整 `verify:world` 与 `--no-fetch` 分开报告，不能互相替代。
- 如果完整模式因为无 exact 候选拒绝错书，保留 FAIL 并解释，不得放宽身份标准制造 PASS。
- 测试统计必须来自本轮最终冻结源码，不得引用旧版945/946作为本轮结果。
- 若修改 `Book`、`Library`、`stream-import.ts`、`world.ts`、`tool-schemas.ts`、`describe.json`，必须做 SSM 专项差异分析。
- `blocked=0, review>0` 仍然是待独立审核；禁止 `--accept-review`。
- 不声称模型 Token 收益，除非有真实调用测量。

### 阶段 D：交付冻结

生成最终本地提交和审核快照，提交：
- 修复前失败测试证据；
- 修复后测试日志；
- P1-11 guidance 状态矩阵；
- P1-12 wanted/declared/display 三身份数据流说明；
- 书架旧数据/版本/进度兼容报告；
- terminal retry/repair 边界结论；
- SSM 差异报告；
- 当前真实 `origin/main` 与候选分支差异；
- 剩余风险清单。

---

## 7. 权限边界与明确禁止事项

本轮授权 Codex 在隔离工作区内自主完成调查、最小修复、测试、文档和本地提交。

**不授权：**
- push；
- merge main；
- 发布或部署；
- 修改生产书架；
- 批量迁移或重命名历史书籍；
- 未经证明必要的大规模 `Book`/`Library` schema 迁移；
- SSM `accept-review`；
- 修改 Persona Memory、StoryStore、阅读进度或阅读确认语义；
- 修改系统 DNS、WFP、防火墙、代理；
- 安装管理员服务、Hyper-V/VM 或浏览器控制器；
- 安装/修改日常 Chrome/Edge；
- 读取 Cookie、token、浏览器 profile；
- 将 `controllerReady/browserReady` 改成 true。

**本轮不要求用户运行 `round3-host.mts`，不创建新 Windows 账户，不申请管理员权限。** 本轮完成后只报告是否具备未来一次性普通权限宿主验收条件；是否运行由用户另行决定。

---

## 8. 最终验收矩阵

| 项目 | 必须达到 |
|---|---|
| 搜索候选 awaiting_choice | 正确指引 status → start(candidateId) |
| TXT 导入 awaiting_choice | 正确指引 status → 明确接受后 plan(queue) 或 abandon |
| 未知 stage | fail-closed，不猜测候选 |
| 身份差异通知 | 同时明确 wanted、declared 和 bookKey/taskId |
| 书架显示来源标题 | 不以 wanted 冒充 declared |
| 来源无标题 | 中性未确认展示名，不伪造目标身份 |
| 来源无作者 | 不回填目标作者 |
| 同名 generic 文件 | 不错误合并不同内容 |
| 旧书/版本/进度 | 不覆盖、不迁移、不丢失 |
| manual import | 不创建自主 Selection 承诺 |
| terminal retry/repair | 不自动绕过自主选书终止规则；用户原件修复仍可用 |
| 队列 | partial/unknown 未明确接受前为空 |
| 阅读确认 | `confirmedChars=0`，无伪造回执 |
| 严格导入/书源 | 无回归 |
| SSM | 独立审核，禁止自动接受 |
| Git/发布 | 本地冻结，不 push、不 merge、不部署 |

---

## 9. 完成标准与下一步

本轮完成的标准不是新增大量测试，而是：

1. 大肥鱼能够正确区分“搜索候选待选”和“已入架作品身份待确认”。
2. 大肥鱼不会被错误 guidance 引导去调用不存在的 candidateId。
3. 用户看到的书架名称不会把来源不匹配的作品伪装成原目标。
4. 来源身份缺失时明确标为未确认，不伪造标题或作者。
5. 明确接受后才允许排队；放弃时保留已入架文件但结束承诺。
6. 旧书、revision、阅读进度和严格导入均无回归。
7. 所有新增行为有可复现测试和独立证据。

完成后交付独立审核包，等待审核。**不要自动宣布0.63.0可发布，也不要自动将该分支移植或合并到0.65.1及更新的 main。**

最终报告必须明确回答：

- 两种 `awaiting_choice` 是否已经拥有不同且正确的模型操作指引？
- TXT 来源身份与书架展示身份是否一致？
- 身份不明时是否仍然允许质量尚可的小说入架？
- 大肥鱼是否只能在明确确认后将待确认作品加入阅读队列？
- 旧书、不同 revision 和阅读进度是否完整保留？
- terminal failure 的 retry/repair 是否仍遵守自主选书边界？
- 当前候选是否具备进入一次性普通权限真实宿主验收的条件？

**本轮是第四阶段最后一次针对性产品语义收尾。除非发现新的可复现 P0/P1 数据安全问题，不要再扩张 TXT 获取模块的架构范围。**
