# 06 · SSM 变更说明（供 SSM 负责人审阅）

**结论先行**：本轮保留现有保护机制，`check:ssm` 仍报 2 个 `REVIEW`（`src/library.ts`、`src/world.ts`），**未使用 `--accept-review` 自行放行**。请 SSM 负责人确认后再决定是否放行。证据：`evidence/check-ssm.log`（`blocked=0 review=2 allowed=68`，exit 1）。

---

## 1. 保护机制现状

判定来源 `scripts/ssm-protected-paths.json`（manifest v1，baseline `0.62.1`），由 `scripts/check-ssm-protected.mts` 执行，比较"工作区 + 未跟踪文件 vs origin/main"。

| 类别 | 含义 | 本轮涉及 |
| --- | --- | --- |
| `blocked` | 禁止 Bugfix 修改：`src/story/`、`src/protocol/story.md`、`tests/story-core/store/e2e/library/scale.test.ts`、`tests/predeploy-ssm-isolation.test.ts`、`tests/fixtures/kill-restore.ts`、`tests/security/untrusted-book-content.test.ts` | **blocked = 0**，一个都没碰 |
| `review` | 共享文件中的 SSM 区段，需负责人确认：含 `src/library.ts`、`src/world.ts`、`src/config.ts`、`src/tool-schemas.ts`、`src/stream-index.ts`、`src/paged-book.ts`、`src/stream-import.ts`、`src/history.ts`、`src/journal.ts`、`src/retrieval.ts`、`describe.json` 等 | `src/library.ts`、`src/world.ts` 触发 REVIEW |
| `namePatterns` | 路径含 `story` / `ssm` 的新文件默认受保护 | 本轮新增文件名不含这些模式 |
| `exempt` | 检查器自身与文档 | 无关 |

**重要**：该检查器是**文件粒度**判定，不是行粒度。只要 `library.ts` / `world.ts` 有任何改动，就会报 REVIEW——与改动是否触及 SSM 逻辑无关。v1.1 也是同样的两个文件、同样的原因。

## 2. 两个文件的实际差异（本轮完整 diff）

### `src/library.ts`（3 处，共 +25 / -1）

| hunk | 内容 | 归属 |
| --- | --- | --- |
| `@@ -18,0 +19` | 新增 `import { PLAN_ARCHIVE_LIMIT } from './reading-plan.ts'` | 阅读计划 |
| `@@ -852,+854 / -855,+866 / -856,+873` | `planView()`：新增由 `selected` 派生的 `reading`（含 `inPlan`、真实进度、章节）；`completedCount` 改取 `plan.stats.completed`，并新增 `completedKept / skippedCount / removedCount / truncatedCount / archiveLimit / archiveKept` | 阅读计划视图 |
| `@@ -1172,+1189` | `updatePlanAction()` 的 `remove` 分支透传 `keepReading: input.keepReading === true` | 阅读计划操作 |

### `src/world.ts`（1 处，+1）

| hunk | 内容 | 归属 |
| --- | --- | --- |
| `@@ -487,0 +488` | 在 `import_batch_*` 工具分发区新增 `if (method === 'import_batch_zip_reselect' && args.length === 1) return this.transfers.batches.zipReselect(...)` | 批量导入 |

## 3. 哪些代码位于 SSM 共享保护区域

`library.ts` 中确实存在 SSM 相关代码，但**都不在本轮改动行段内**：

| SSM / story 相关代码 | 行号 | 本轮是否改动 |
| --- | --- | --- |
| `import { StoryStore } from './story/store.ts'`、`validateStoryChanges`、`normalizeName` | 23–25 | 否（本轮 import 在 19 行，是 `PLAN_ARCHIVE_LIMIT`） |
| `private story?: StoryStore`、`history: HistoryStore` 字段 | 219–220 | 否 |
| `storyCleanupFile`、`new StoryStore(...)`、`storyMemoryEnabled` 初始化 | 235–238 | 否 |
| 备份/恢复路径中的 `StoryStore.validateSnapshot`、`story-backup.sqlite`、`story.clear()` | 483、1850–1913 | 否 |

本轮 hunk 落在 **19、854–873、1189–1193** 行，全部是 `planView()` / `updatePlanAction()` 的计划视图与计划操作区域。`world.ts` 中未出现任何 `StoryStore` / `story` 符号，改动行 488 属于 `import_batch_*` 分发区。

## 4. 是否触及 StoryStore / Story Index / Persona Memory 的行为

| 项 | 判定 | 依据 |
| --- | --- | --- |
| StoryStore（故事记忆存储、快照、清理） | **未触及** | 未改 `story/` 目录、未改 23–25 / 219–238 / 483 / 1850–1913 行；`check:ssm` blocked=0 |
| Story Index（故事索引 / 检索） | **未触及** | 未改 `src/stream-index.ts`、`src/retrieval.ts`、`src/history.ts`、`src/journal.ts`；本轮 diff 不含检索/索引代码 |
| Persona Memory（人格记忆） | **未触及** | 未改 Persona 相关文件与 `src/protocol/story.md`；计划页文案明确声明"改顺序不会改动正文、进度、手账、读后感或故事记忆" |
| SSM 业务逻辑 / 语义 | **未改变** | 任务书第 11 节明令禁止；本轮只改计划/导入相关视图与分发 |

`check:ssm` 中 `tests/story-scale.test.ts`（SSM scale isolation）、`tests/plan-*.test.ts` 等全部 `[not-protected] ok`，故事相关测试本轮继续通过（见 `evidence/test-full.log`：SSM scale isolation 2 例绿）。

## 5. 为什么仍然报 REVIEW、以及等待什么

因为 `library.ts` / `world.ts` 整文件在 `review` 清单里，任何改动都会触发。这是**流程闸门，不是代码问题**；v1.1 已就同样两个文件留下同一条待确认项。

本轮需要 SSM 负责人：

1. 复核上述两个文件的实际差异（可直接 `git diff 5759bb4 -- src/library.ts src/world.ts`）。
2. 确认这些改动不落在 SSM 共享区段、不改变 StoryStore / Story Index / Persona Memory 行为。
3. 明确授权后，由负责人执行 `corepack pnpm check:ssm --accept-review "已获得 XXX 同意：<范围与理由>"`。

**本轮没有、也不会自行执行该命令。** 在得到明确授权前，`check:ssm` 保持 exit 1 / 2 REVIEW 状态，作为未闭合项写入 `09-最终验收摘要.md`。
