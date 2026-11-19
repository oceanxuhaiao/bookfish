# BookFish SSM 临时保护清单（PROVISIONAL PROTECTED PATHS）

**任务编号：** BF-DSH-GIT-20261119
**生成时间：** 2026-11-19
**生成机器：** 新电脑（独立 Bugfix 环境）
**代码基线：** GitHub `main` = `0.62.1` = `ea9b45be7eda6d63f0f1172a76585d794dbdb01f`
**状态：** ⚠️ **临时（PROVISIONAL）** —— 只代表 GitHub 当前代码，**不代表原电脑尚未提交的 SSM 成果**。

---

## 0. 效力边界（先读这一节）

| 问题 | 答案 |
|---|---|
| 这份清单能不能证明原电脑的 SSM 成果安全？ | **不能。** 它只描述 GitHub 已发布的代码面。 |
| 原电脑未提交的改动会出现在这里吗？ | **不会。** 那些文件只在原电脑本地，本机看不到。 |
| 那它有什么用？ | 让新电脑的 Bugfix 在**已知代码面**上不误伤 SSM；并把"未知即受保护"变成可执行规则。 |
| 什么时候失效？ | 原电脑完成阶段一备份并产出权威清单后，本文件降级为历史快照，以权威清单为准。 |

**判定方向永远是"宁可误拦，不可漏放"**：归属不明 → 受保护。

---

## 1. 分析方法

不是按文件名猜，顺序是：

1. `git ls-files` 全量清点（255 个跟踪文件）；
2. 以 `src/story/` 为根，追实际 `import` 边（`src/story/{core,store}.ts` 被谁引用）；
3. 以开关 `storyMemoryEnabled` 为线索，追所有读写该配置的位置；
4. 以数据文件 `story.sqlite` 为线索，追所有建库 / 快照 / 清理 / 恢复路径；
5. 反向检查测试：哪些测试在断言 SSM 行为或 SSM 关闭语义；
6. 对"共享文件里夹着 SSM 区段"的情况单列 `review`，而不是整文件禁止。

关键证据（实际 import 边，非推测）：

```text
src/library.ts   → ./story/store.ts（StoryStore）、./story/core.ts（validateStoryChanges、normalizeName）
src/library.ts   → ./history.ts、./journal.ts、./retrieval.ts
src/world.ts     → 工具路由 action="story" / storyChanges；Library 构造传 storyMemoryEnabled
src/journal.ts   → ./history.ts
src/retrieval.ts → ./history.ts、./journal.ts
src/history.ts   → ./journal.ts（仅 type ReadingEpisode）
src/paged-book.ts → ./stream-index.ts（canonical segment index 校验）
src/stream-import.ts → ./stream-index.ts
```

`src/history.ts` 与 `src/retrieval.ts` **不 import story 模块**，但它们是 SSM 的上游契约：
SSM 记录的 `bookRevision` / `contentVersion` / `frontier` 取自 Task/Episode 序列，
"原文回查"走 `retrieval.ts` 的证据带。改它们不一定改 SSM 代码，但会改变 SSM 的输入语义 → `review`，不是 `blocked`。

---

## 2. 阻断级（blocked，8 条）

**禁止 Bugfix 修改。命中即停止、撤回，不得"顺手改一下"。**

| # | 文件或目录 | 状态 | 所属模块 | 允许 Bugfix 修改 |
|---|---|---|---|---|
| 1 | `src/story/`（目录，覆盖其下 `core.ts`、`store.ts` 及未来新增文件） | 现有模块 | SSM 故事记忆：纯函数层 + SQLite 存储层 | 否 |
| 2 | `src/protocol/story.md` | 现有模块 | 故事记忆协议（工具回执、版本绑定、分页、实体解析） | 否 |
| 3 | `tests/story-core.test.ts` | 现有模块 | SSM 纯函数层回归（38 项） | 否 |
| 4 | `tests/story-store.test.ts` | 现有模块 | SSM 存储层回归（18 项） | 否 |
| 5 | `tests/story-e2e.test.ts` | 现有模块 | SSM 端到端回归 | 否 |
| 6 | `tests/story-library.test.ts` | 现有模块 | Library 侧车生命周期 / 归档恢复 / 崩溃恢复（16 项） | 否 |
| 7 | `tests/story-scale.test.ts` | 现有模块 | 规模隔离（350+ 段长篇不进入未完成骨架流程） | 否 |
| 8 | `tests/predeploy-ssm-isolation.test.ts` | 现有模块 | **SSM 关闭隔离契约**：不建库、不写库、不删库、不阻断普通阅读 | 否 |

---

## 3. 需确认级（review，18 条）

**不是"随便改"，是"默认失败，拿到 SSM 负责人书面同意后才放行"。**

### 3.1 SSM 接线与共享数据契约（12 条）

| # | 文件 | 受保护的具体区段 | 为什么危险 |
|---|---|---|---|
| 1 | `src/library.ts` | `story` 字段、`storyMemoryEnabled` 构造、`storyStatus`、`captureStory`、`putStoryPack`、`listStoryPacks`、`storyOverview`、`storyEvidence`、`createStoryEntity`、`bindStoryEntity`、`storyEntityCandidates`、`cleanupStoryBook`、`storyCleanupFile` 墓碑、归档/恢复中的 story 快照分支 | 40+ 处触点；改错直接破坏 SSM 读写或"关闭时不动 story.sqlite"的契约 |
| 2 | `src/world.ts` | `action="story"` 路由、`storyChanges`、构造处的开关透传 | 工具面对外契约 |
| 3 | `src/config.ts` | `storyMemoryEnabled` 默认值（false）、设置项文案、高级设置分组 | 默认值改成 true 会改变全部用户行为 |
| 4 | `src/tool-schemas.ts` | `storyChange` schema、`action` 的 `story`、`storyAction`、`storyChanges` | 模型可见的接口定义 |
| 5 | `src/ENV_PROMPT.md` | "故事记忆"流程入口 | 影响模型何时进入 SSM |
| 6 | `describe.json` | 故事记忆工具描述（9 处） | 生成物，手改会与 `corto.api` 契约漂移 |
| 7 | `src/stream-index.ts` | 规范化分段算法 | **segment id 是 SSM 证据锚点**，改算法 = 历史证据全部错位 |
| 8 | `src/paged-book.ts` | `Canonical segment index mismatch` 校验 | 同上 |
| 9 | `src/stream-import.ts` | 导入期分段生成与哈希 | 同上 |
| 10 | `src/history.ts` | Task/Episode 序列、`HistoryRef` 版本、可见性过滤 | SSM 的 `frontier` / `episodeWatermark` 输入 |
| 11 | `src/journal.ts` | Episode 证据结构、`evidenceView` | SSM 证据与"真实阅读"红线的共同底座 |
| 12 | `src/retrieval.ts` | 原文回查、证据带、片段与引用的区别 | 回查错误 = 伪造阅读证据 |

### 3.2 SSM 关闭语义与数据生命周期测试（4 条）

| # | 文件 | 受保护的具体区段 |
|---|---|---|
| 13 | `tests/predeploy-data-lifecycle.test.ts` | 删除单本/清空书架时的 story 行清理、BOOKFISH5 拒绝静默丢弃 |
| 14 | `tests/scope-r2.test.ts` | `storyMemoryEnabled` 默认 false、关闭时不建 `story.sqlite` |
| 15 | `tests/closeout-data-recovery.test.ts` | BOOKFISH2/3/5 归档往返、9 个恢复故障注入点中的 story 阶段 |
| 16 | `tests/world.test.ts` | 侧车默认不挂载、开启后捕获事实、不推进阅读 |

### 3.3 SSM 相关夹具与安全断言（2 条）

| # | 文件 | 受保护的具体区段 |
|---|---|---|
| 17 | `tests/fixtures/kill-restore.ts` | 崩溃恢复夹具（被 `story-library.test.ts` 调用） |
| 18 | `tests/security/untrusted-book-content.test.ts` | 以 `storyMemoryEnabled=false` 断言不可信正文不得变成指令 |

> 第 13–18 条是本次按依赖关系**扩展**出来的：任务书只点名了 `tests/story-*.test.ts` 与 `predeploy-ssm-isolation.test.ts`，但这 6 个文件同样断言 SSM 行为，改了等于改契约。

---

## 4. 新文件兜底规则

清单永远追不上新文件，所以机器闸门按命名兜底：

```json
"namePatterns": ["(^|/)story([-._]|$)", "(^|/)ssm([-._]|$)"]
```

- 命中 → 按 `blocked` 处理（如 `src/story/recall.ts`、`src/story-index.ts`、`tests/ssm-e2e.test.ts`）。
- 例外（保护机制自身，可自由改）：`scripts/ssm-protected-paths.json`、`scripts/check-ssm-protected.mts`、`tests/ssm-guard.test.ts`、`docs/dev/` 下的文档。
- 归属实在判断不了的**其他**文件：先按受保护处理，问用户。

---

## 5. 机器闸门（怎么用）

```powershell
npm run check:ssm                      # 工作区 + 未跟踪文件 vs origin/main
npm run check:ssm -- --staged          # 提交前（推荐）
npm run check:ssm -- --json            # 机器可读
npm run check:ssm -- --staged --accept-review "已获得 SSM 负责人同意：<范围与理由>"
```

- `exit 1` + `BLOCKED` → 停手，撤回。
- `exit 1` + `REVIEW` → 未授权；拿到书面同意后用 `--accept-review` 放行（理由会打印）。
- 与本文档同源的数据：`scripts/ssm-protected-paths.json`；两者不得漂移（`tests/ssm-guard.test.ts` 会检查）。

---

## 6. 原电脑完成阶段一之后怎么替换

1. 原电脑运行 `phase1-preserve-ssm.ps1`，产出权威 `BookFish-SSM-PROTECTED-PATHS.md`（含**未提交改动**清单）。
2. 把其中"已修改 / 未跟踪"的 SSM 路径并入 `scripts/ssm-protected-paths.json` 的 `blocked`（或 `review`）。
3. 用权威清单重写本文件，并把标题改为 `PROTECTED PATHS`（去掉 PROVISIONAL）。
4. 跑 `npm test` 确认闸门测试仍通过，再合并到 main。
5. 在那之前：**本清单不得被当作"SSM 已安全"的证据**。

---

## 7. 本清单未覆盖的部分

| 未覆盖 | 原因 | 谁补 |
|---|---|---|
| 原电脑未提交的 SSM 文件 | 本机不可见 | 原电脑阶段一脚本 |
| 原电脑新增的 `src/story/*` 之外的模块 | 同上 | 原电脑权威清单 |
| SSM 的运行时数据（`story.sqlite` 实际内容） | 属用户数据，不进仓库 | 永不入库 |
| Cortico 宿主侧的 `describe:extension` 校验 | 本机无 Cortico 仓库 | 发布前在宿主环境跑 |
