# 08 · SSM 变更说明与门槛执行（v1.4）

对应任务书第 9 节。

---

## 1. 结论

```
结论: blocked=0 review=2 allowed=150
check_ssm_exit=1
```

- 未执行 `--accept-review`；
- 未修改保护清单 `scripts/ssm-protected-paths.json`、未修改检查器 `scripts/check-ssm-protected.mts`（`manifest_diff_bytes=0`）；
- 未触碰 `src/story/**`、Persona Memory、SSM 读写语义；
- 2 个 REVIEW 是 `src/library.ts` 与 `src/world.ts`，按实际变更范围提交审核。

原始输出：`evidence/check-ssm.log`（含 `HEAD: 02db1bc…` 与时间戳）。

## 2. `src/world.ts`：本轮零改动

```
$ git diff 7f5b4da 02db1bc -- src/world.ts
（空）
```

它仍在 REVIEW 里，是因为守卫按"分支 vs origin/main 的最终树"判定，v1.2 已提交的 `plan` / `importBatch` 分发差异仍在，属于 v1.2 的待确认范围。

## 3. `src/library.ts`：两处，均在批量导入区段

```diff
-import { addBatchItems, trimBatches, validateBatches, type BatchAddResult, ... } from './import-batch.ts';
+import { addBatchItems, recordRejected, trimBatches, validateBatches, type BatchAddResult, ... } from './import-batch.ts';
...
-  addImportBatchItems(batchId: string, inputs: readonly BatchItemInput[]): BatchAddResult {
+  addImportBatchItems(batchId: string, inputs: readonly BatchItemInput[],
+    extra: { tooLarge?: readonly string[]; overBudget?: readonly string[] } = {}): BatchAddResult {
     ...
-      return addBatchItems(batch, inputs, this.now());
+      const result = addBatchItems(batch, inputs, this.now());
+      recordRejected(batch, { unsupported: result.unsupported, duplicate: result.duplicates,
+        tooLarge: [...extra.tooLarge ?? [], ...result.tooLarge],
+        overBudget: [...extra.overBudget ?? [], ...result.overBudget], overflow: result.overflow });
+      return result;
```

性质：**把拒绝记录写进同一次原子提交**。位置是 `Library` 的批量导入方法，位于 `// batch import` 区段；不涉及 story 相关字段（`storyMemoryEnabled` / `captureStory` / story 快照分支等）。

## 4. 逐项确认（任务书"不允许"清单）

| 项 | 状态 |
| --- | --- |
| 修改 StoryStore | ❌ 未改（`src/story/store.ts` 零改动） |
| 修改 Story Index | ❌ 未改 |
| 修改 Persona Memory | ❌ 未改 |
| 修改 SSM 读写语义 | ❌ 未改 |
| 修改保护清单 | ❌ 未改（`manifest_diff_bytes=0`） |
| 使用 `--accept-review` 自行放行 | ❌ 未使用 |
| 把 REVIEW 改成"通过" | ❌ 如实保留 2 项 |

## 5. 为什么 REVIEW 数字变了（allowed 150）

`allowed` 统计的是"本次改动涉及的文件数"。v1.4 新增了 2 个测试文件、改了 6 个，加上 v1.3 的审核包文档仍在 diff 里，因此从 145 涨到 150。**`blocked` 始终为 0、`review` 始终为 2、`exit` 始终为 1** —— 计数只反映改动面，不反映保护强度。

## 6. 复现

```bash
cd E:/项目/桌面宠物/扩展/cortina/state/packages/bookfish-reading-plan
corepack pnpm check:ssm
git diff --stat origin/main -- scripts/ssm-protected-paths.json scripts/check-ssm-protected.mts
git diff --name-only 7f5b4da 02db1bc | grep -iE "story|persona|ssm"   # 预期为空
```
