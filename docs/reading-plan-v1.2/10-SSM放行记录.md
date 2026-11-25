# 10 · SSM 放行记录（审核包冻结之后的后续事件）

**结论**：2026-11-25 15:08（UTC+8），ocean 在会话中明确指令「放行」。已按守卫规定的 `--accept-review` 流程登记书面理由并执行：

```
结论: blocked=0 review=2 allowed=83
已登记 review 放行理由：已获得 ocean 同意：……
exit=0
```

v1.2 的 SSM 待确认项由此闭合。原始输出见 `evidence/check-ssm-release.log`；机制完好性复核原文已逐字内嵌于本记录第 6 节。

---

## 1. 本记录的效力边界（先读这一节）

| 问题 | 答案 |
| --- | --- |
| 已交付的 v1.2 审核包 zip 改了吗？ | **没有。** `BookFish-ReadingPlan-v1.2-最终安全整改审核包-20261125-140204.zip`（582,260 字节）及其 `.sha256` 旁文件字节不变，包内 `SHA256SUMS` 36 项继续有效。 |
| 那 00–09 里写的「未放行 / 等待 SSM 负责人确认」还算数吗？ | 那是**放行前**的真实状态，作为历史快照冻结保留，不改写。当前状态以本记录为准。 |
| 本记录在哪？ | 工作区新增 `docs/reading-plan-v1.2/10-SSM放行记录.md` + 两份 evidence 日志，随一次本地提交入库。 |
| 为什么不把放行记录塞进原 zip？ | 重打包会让全部 36 项哈希与旁文件失效，且会出现两个同名交付版本，制造审核歧义。放行是**审查流程事件**，不是代码整改产物，独立落档 + 独立证据更干净。 |

## 2. 授权与执行

| 项 | 内容 |
| --- | --- |
| 授权人 | ocean（会话明确指令「放行」） |
| 授权时间 | 2026-11-25T07:08:05Z（15:08 UTC+8） |
| 授权范围 | **仅** v1.2 对 `src/library.ts`、`src/world.ts` 的改动，不扩展到其他变更或其他轮次 |
| 依据 | `06-SSM变更说明.md` 的逐行差异核对（4 处 hunk 全部落在计划视图/操作与批量导入分发区，未触及 SSM 区段） |
| 命令 | `corepack pnpm check:ssm --accept-review "<书面理由>"` |
| 结果 | `blocked=0 review=2 allowed=83`，**exit 0**，理由由守卫打印登记 |

书面理由全文（与执行命令一致）：

> 已获得 ocean 同意：v1.2 阅读计划整改在 `src/library.ts`（`planView` / `updatePlanAction` 计划区段，行 19 / 854-873 / 1189-1193）与 `src/world.ts`（`import_batch_zip_reselect` 分发行 488）的改动均不触及 SSM 共享区段，StoryStore / Story Index / Persona Memory 行为与语义未改变（依据 `06-SSM变更说明.md`；授权时间 2026-11-25，范围仅限本轮 v1.2 改动）

## 3. 放行的真实语义：按次授权，不是永久关闸

**这是最容易误读的一点，必须写清。** 守卫 `scripts/check-ssm-protected.mts` 的 `exitCodeFor()` 只依据本次进程的参数决定退出码，`--accept-review` **不写入任何状态文件、不修改清单、不持久化**。因此：

- 本次运行带理由 → `exit 0`，书面理由被登记打印，v1.2 审核流程中的 SSM 待确认项闭合；
- 之后任何人重跑不带理由的 `corepack pnpm check:ssm` → **仍为 `exit 1` / 2 REVIEW**。

这是**设计如此**：闸门要求"每次改动都重新确认"，而非一次性开关。已复核确认（复核命令与原始输出逐字内嵌于第 6 节）：

| 复核项 | 结果 |
| --- | --- |
| 不带理由的 `check:ssm` | `结论: blocked=0 review=2 allowed=83`，`plain_check_exit=1` |
| `tests/ssm-guard.test.ts` | **21/21 passed** |
| `git diff -- scripts/ssm-protected-paths.json scripts/check-ssm-protected.mts` | `manifest_diff_bytes=0`（清单与检查器零改动） |
| `src/story/` 及 SSM 业务代码 | 零改动，`blocked=0` |

**放行没有削弱任何保护。** 若后续需要 CI / 提交闸门自动变绿，只有两条路：每次运行显式带同一书面理由；或由 SSM 负责人修改 `ssm-protected-paths.json` 将这两个文件移出 `review`（或改为按 hunk 判定）。后者属于**保护清单语义变更**，v1.2 任务书第 11 节明令禁止，本轮未做，也不建议顺手做——它会永久降低闸门强度。

## 4. 仍未闭合（本次放行不影响）

1. **真实宿主验收**：全部 `not_observed`，11 步清单见 `08`。放行只代表代码审查流程就绪，不代表宿主验收通过。
2. **两个口径判定**（`00` 中标注）：产品预算是否算变更、历史策略是否算变更，仍需审核方裁定。
3. **独立审核与发布批准**：本次放行**不构成**发布批准。分支仍停在 `feat/reading-plan-v1`，仅本地提交，**未 push / 未 merge / 未发布 / 未部署 / 未操作正式用户数据**。

## 5. 复现

```bash
cd E:/项目/桌面宠物/扩展/cortina/state/packages/bookfish-reading-plan

# 本次放行（带书面理由，exit 0）
corepack pnpm check:ssm --accept-review "已获得 ocean 同意：<范围与理由>"

# 机制完好性（不带理由，预期 exit 1 / 2 REVIEW）
corepack pnpm check:ssm
corepack pnpm exec vitest run tests/ssm-guard.test.ts
git diff -- scripts/ssm-protected-paths.json scripts/check-ssm-protected.mts

# 冻结审核包仍然可独立核对
sha256sum -c docs/reading-plan-v1.2/evidence/SHA256SUMS   # 在解压根目录
sha256sum -c docs/BookFish-ReadingPlan-v1.2-最终安全整改审核包-20261125-140204.zip.sha256
```

## 6. 附：放行后机制完好性复核（原始日志逐字内嵌）

该复核最初落在独立文件 `evidence/ssm-guard-integrity.log`。v1.3 整改期间发现：该文件名以 `ssm` 开头，会命中守卫 `ssm-protected-paths.json` 中 namePattern 兜底规则 `(^|/)ssm([-._]|$)`（"文件名以 ssm 开头的按 blocked 处理"），导致 v1.3 提交前的 `check:ssm` 误报 `blocked=1`。**守卫规则本身未动、也不应动**；处置方式是移除该独立日志文件、把内容逐字内嵌于本节——证据保全、守卫语义零改动、历史提交（`d392abd`）仍可考。以下为原文（未删改一字，含 ANSI 转义原样）：

```
# 放行后机制完好性复核
generated: 2026-11-25T07:09:00Z

$ corepack pnpm check:ssm  (不带 --accept-review，应仍为 2 REVIEW / exit 1)
结论: blocked=0 review=2 allowed=83
停止：上述 review 文件含 SSM 共享区段，需要 SSM 负责人确认。
确认后使用：--accept-review "已获得 XXX 同意：<范围与理由>"
[ELIFECYCLE] Command failed with exit code 1.
plain_check_exit=1

$ corepack pnpm exec vitest run tests/ssm-guard.test.ts

 [32m✓[39m tests/ssm-guard.test.ts [2m([22m21 tests[22m[2m)[22m[90m 75[2mms[39m

[2m Test Files [22m [1m1 passed[39m [22m([1m[4m1[22m[24m[39m[22m)[22m
[2m      Tests [22m 21 passed[39m [22m([1m21[22m[39m[22m)[22m
[2m   Start at [22m 15:09:03
[2m   Duration [22m 1.57s [2m(transform 58ms, setup 0ms, collect 70ms, tests 75ms, environment 0ms, prepare 160ms)[39m


$ git diff -- scripts/ssm-protected-paths.json scripts/check-ssm-protected.mts  (应为空)
manifest_diff_bytes=0
```
