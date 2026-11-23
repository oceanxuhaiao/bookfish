# TXT 开发线集成与终审收尾报告（2026-11-23）

> 状态：**阅读足迹看板已集成至未发布 TXT 开发线；内部验收通过；浏览器辅助 TXT 获取仍未完成；未公开发布。**

## 1. 基线与分支

| 项 | 值 |
| --- | --- |
| 提交态基线 | `50cf2de`（`package.json` 0.65.1） |
| TXT WIP | `bookfish-txt-acquisition-round3` 工作树：25 个已跟踪修改 + 4 个未跟踪源码文件（另有 3 个 artifacts 未跟踪，不入代码） |
| 看板分支 | `codex/footprint-browse-v1`，终审后新增 P1 修复，HEAD `242d729` |
| 集成分支 | `codex/footprint-txt-integration`：`e4a2c1a`（WIP 快照）→ `7f75581`（看板合并） |
| 内部安装 | `0.66.2`，`data/local-extensions/bookfish-0.66.2-footprint-int1` |

## 2. WIP 保留证据

- 快照提交 `e4a2c1a` 由 `round3` 工作树逐文件复制后提交：25 个修改 + 4 个新增，共 29 个源码/测试文件。
- 合并前逐文件 SHA-256 比对：**29/29 与 `round3` 工作树完全一致**。
- 合并后再次比对：26 个完全一致；3 个预期差异：
  - `src/world.ts`：WIP 内容 + 看板 4 个只读路由；
  - `lib/webui.js`、`lib/webui-txt-builtin-bing-0651.js`：由合并源码重新构建。
- 恢复命令：`git -C <repo> worktree add <dir> e4a2c1a`（或 `git show e4a2c1a:<path>`）可还原任一 WIP 文件；`round3` 工作树未被改写。

## 3. 合并方式与冲突

- 生成看板补丁：`git diff 50cf2de 242d729 -- src tests scripts`（112,893 字节）。
- 在集成工作树执行 `git apply --3way`：**退出码 0，0 冲突**。
- 未使用 `--theirs` 或旧版覆盖；`world.ts` 的 WIP 与看板路由按上下文合并。
- 构建：`node scripts/build-webui.mjs`；`tsc --noEmit` 主配置/web 配置均 0 错误。

## 4. P1：跨书足迹讨论上下文

**问题**：看板卡片的 `bookfish-discuss` 事件只带 `id/text`；面板监听器调用 `discuss(id,text)` 时默认当前阅读书籍，导致在“全部书籍”中讨论 B 书足迹时标题/上下文可能是 A 书。

**修复**：

- 事件携带 `bookKey/bookTitle`；监听器校验后显式传入 `discuss(id,text,bookKey,bookTitle)`。
- 讨论标题取自记录所属书籍；服务端仍以 `episodeId` 解析真实书籍（原有保证不变）。
- `discuss()` 不再调用 `selectScope()`：讨论不再改写持久化的筛选、排序、每页、锚点或滚动。

**自动化测试**（3 项新增）：

1. 正在读 A、全部书籍看板点 B 记录的“聊聊这一段” → 讨论 `bookKey` 为 B、`episodeId` 为该记录，当前阅读仍为 A，持久化浏览状态不变；
2. A=B 同书路径不变；
3. 新足迹预览中讨论 → 讨论归属为预览记录所属书籍。

**真机复核**：当前阅读《龙族》，在《西游记》筛选下点“聊聊这一段” → 聊天标题《西游记》，事件 bookKey 为《西游记》，筛选/页码/锚点均未变（见 `evidence/04-discussion-context.png`）。

## 5. 回归结果（均在最终集成工作树执行）

| 项 | 命令/范围 | 结果 |
| --- | --- | --- |
| 全量 Vitest | `vitest run` | **101 文件 / 1103 通过 / 1 跳过 / 0 失败** |
| 主 TS | `tsc --noEmit -p tsconfig.json` | 0 错误 |
| Web TS | `tsc --noEmit -p tsconfig.web.json` | 0 错误 |
| WebUI 构建 | `node scripts/build-webui.mjs` | 成功，产物含 TXT 与看板 |
| TXT 定向 | 12 个 TXT/浏览器辅助测试文件 | **172 通过** |
| 看板定向 | `journal-browse` + `footprint` + `client` | **52 通过** |

原始日志：`evidence/full-tests-integration.log`、`evidence/txt-targeted.log`、`evidence/footprint-targeted.log`。

## 6. 自然新足迹提醒（首次真机自然触发）

- 持久化水位为 886；12:20 后大肥鱼在午餐结束后自主写入 887–890（13:06/13:13/13:19/13:25）。
- 打开阅读足迹页立即出现“**大肥鱼新增了 4 条足迹**”，历史列表仍在第 1/88 页。
- 展开预览显示 4 条；整体收起后水位推进到 890；未调用任何模型。
- 截图：`evidence/01-natural-banner.png`、`02-preview.png`、`03-after-collapse.png`。

## 7. 索引 Schema 与旧版兼容

- 实际运行库已含 `history_sequence`（由内部试用打开时创建）。
- 在独立副本上去掉该索引后用新代码打开：自动补建索引，读取 875 条 / 最大序号 889 / 4 本书，`PRAGMA quick_check=ok`。
- 用 **看板前代码**（`e4a2c1a`）读取同一副本（含新索引）：计数 875 与 `$history.episodes` 一致。
- 结论：索引创建是打开数据库时的 Schema 写入，不改业务记录；旧代码可读；回滚不要求删除索引，删除也不影响正确性。

## 8. 真机截图（互不重复，均来自集成构建）

| 文件 | 内容 | SHA-256 前缀 |
| --- | --- | --- |
| `00-defaults.png` | 全新浏览器：全部书籍/最新在前/10 条 | 856dd0f2a5 |
| `01-natural-banner.png` | 自然新增 4 条提醒 | 433af63579 |
| `02-preview.png` | 预览 4 条，历史页不变 | ebc7a7df75 |
| `03-after-collapse.png` | 收起后滚动到列表中段 | c05684eb86 |
| `04-discussion-context.png` | 跨书讨论标题《西游记》 | 091050a6df |
| `05-scoped-banner.png` | 按《西游记》范围提醒 | 36e0f82ab3 |

## 9. 已知边界与未完成

- 50 条预览截断：**P2 已知限制，非本轮阻断**；UI 显示“本次新增 N 条，显示 50 条”，不声称全部已展示；收起仍推进到批次最大序号。
- `journal_new` 接受 `limit` 但固定最多 50 条：契约已注明，未改动以避免扩大面。
- 旧 `legacy` 手账仍渲染到隐藏 DOM：本地 IPC/DOM 开销，非本轮必改。
- `journalBooks` 为 O(n) GROUP BY：10k 条约 29.5 ms；100k 约 300 ms 为线性外推，未压测。
- 窄屏/触屏、内嵌 WebView 未验证。
- `visibility` 仍未落地；新查询只沿用现有足迹 UI 可读范围。
- 浏览器可能留下 `status`/`shelf` 命名空间下的空 `browse-v1` 键（组件在非 trail 面板挂载后停用时写入），只影响本地键数量，不影响恢复。

## 10. 内部试用与回滚

- 当前宿主安装 `0.66.2` 集成构建，manifest 为 `/assets/extensions/cortico-world-bookfish/0.66.2/webui-txt-builtin-bing-0651.js`。
- 备份：`data/extensions/package.json.before-footprint-int1-20261123-133339`、`pnpm-lock.yaml.before-footprint-int1-*`。
- 回滚：把 `node_modules/cortico-world-bookfish` junction 与 profile/lock 指回 `bookfish-txt-0651-4ba8df5`，重启宿主；删除 `history_sequence` 可选。
- 未发布、未上传市场、未改 `origin/main` 或 tag。
