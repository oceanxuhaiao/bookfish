# 08 · SSM 变更说明与门槛执行（v1.5）

对应任务书第 8 节。

---

## 1. 结论

```
结论: blocked=0 review=2 allowed=202
check_ssm_exit=1
```

- 未执行 `--accept-review`；
- 未修改保护清单 `scripts/ssm-protected-paths.json`、未修改检查器 `scripts/check-ssm-protected.mts`；
- 未触碰 `src/story/**`、Persona Memory、SSM 读写语义；
- 2 个 REVIEW 仍是 `src/library.ts` 与 `src/world.ts`，按实际变更范围如实提交审核。

原始输出：`evidence/check-ssm.log`。

## 2. `src/world.ts`：本轮零改动

```bash
$ git diff a2f0397 -- src/world.ts
（空）
```

它仍在 REVIEW 里，是因为守卫按"分支 vs `origin/main` 的最终树"判定，v1.2 已提交的 `plan` / `importBatch` 分发差异仍在，属于 v1.2 的待确认范围，本轮不扩大也不回收。

## 3. `src/library.ts`：一行，在批量导入区段

```diff
@@ -784,6 +784,7 @@ export class Library {
           tooLarge: [...extra.tooLarge ?? [], ...result.tooLarge],
           overBudget: [...extra.overBudget ?? [], ...result.overBudget],
           overflow: result.overflow,
+          overflowNames: result.overflowNames,
         });
         return result;
       });
```

性质：**把新增的 `overflowNames` 传给 `recordRejected()`**，使超 100 本时报告能给出具体书目名单而不只是数字。位于 `// batch import` 区段的原子提交内部，不涉及 story 相关字段（`storyMemoryEnabled` / `captureStory` / story 快照分支）。

这是本轮唯一的保护文件改动，1 行插入、0 行删除。

## 4. 逐项确认（任务书"不允许"清单）

| 项 | 状态 |
| --- | --- |
| 修改 StoryStore | ❌ 未改（`src/story/store.ts` 零改动） |
| 修改 Story Index | ❌ 未改 |
| 修改 Persona Memory | ❌ 未改 |
| 修改 SSM 读写语义 | ❌ 未改 |
| 修改 SSM 业务语义 | ❌ 未改 |
| 修改保护清单 | ❌ 未改（`git diff --stat a2f0397 -- scripts/ssm-protected-paths.json` 为空） |
| 使用 `--accept-review` 自行放行 | ❌ 未使用 |
| 把 REVIEW 改成"通过" | ❌ 如实保留 2 项，exit 1 |
| 接 WAL v2 | ❌ 未接 |
| 启用 GC | ❌ 未启用 |
| 改 Token 优化策略 | ❌ 未改 |
| 改大肥鱼 Persona | ❌ 未改 |
| 重写 ReadingScheduler / ReadingPlan / PlanCoordinator | ❌ 未改 |

验证命令：

```bash
git diff --name-only a2f0397 -- . | grep -iE "story|persona|ssm|token"
# 输出为空
```

## 5. 为什么 REVIEW 与 allowed 数字是这样的

- **`review` 始终为 2**：这两个文件在"分支 vs `origin/main`"的最终树里含 SSM 共享区段的改动，与本次改了多少行无关。v1.2 至今一直是 2。
- **`blocked` 始终为 0**：没有改动保护清单里标记为 blocked 的语义区段。
- **`allowed` 随改动面变化**：v1.4 为 150（另有审核包文档在 diff 里），本轮为 **202**。这个数字只是"本次 diff 涉及的非保护文件数"，不反映保护强度；它还会受临时目录（如 `.vitest-tmp/` 探针产物）是否存在于工作区影响——本轮已在打包前清理，因此该数字对应最终提交状态。
- **`exit` 始终为 1**：`review > 0` 即非零退出，这是设计意图，不是失败。

## 6. 复现

```bash
cd E:/项目/桌面宠物/扩展/cortina/state/packages/bookfish-reading-plan
npm run check:ssm
# 预期：blocked=0 review=2，exit 1，PASS 行 202

git diff --stat a2f0397 -- scripts/ssm-protected-paths.json scripts/check-ssm-protected.mts
# 预期：空

git diff --name-only a2f0397 -- . | grep -iE "story|persona|ssm|token"
# 预期：空
```