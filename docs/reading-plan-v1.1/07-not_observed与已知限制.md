# 07 · not_observed 与已知限制

本文件的作用：**不要把"没看到"当成"已验证"**。

## A. `not_observed`（本阶段确实没有观察到，不得视为验收）

| # | 项 | 为什么没观察到 | 现有替代证据 |
| --- | --- | --- | --- |
| A1 | 真实 Cortico 桌面宿主里的计划页与批量导入页 | 自动化在 jsdom 中挂载真实 World + 真实 worker，但没有在已安装的桌面端里点过 | `tests/webui/plan-panel.test.ts`（9 例）、`tests/webui/batch-import.test.ts`（7 例），均走真实 `world.webUi('zh').invoke` |
| A2 | 真实系统文件选择器（多选 / 文件夹 / ZIP / 重选） | jsdom 无法打开原生对话框，测试用构造的 `File` + `webkitRelativePath` 注入 | 同上；`webkitdirectory` 的真实行为取决于宿主 webview |
| A3 | 硬杀进程（SIGKILL）后的恢复 | 用"改状态 + 关库重开"等价模拟，或注入提交失败，没有真的 kill 一个正在解析的进程 | `import-batch-run` 两个恢复用例；`plan-stop-atomic` 提交失败用例 |
| A4 | 用**真正的 v0.66.7 二进制**打开 schema 8 快照 | 离线 worktree 里没有旧构建产物 | `schema-downgrade` 逐行复刻了 v0.66.7 的两条判断（`hydrate` 的 `[4,5,6,7]` 映射 + `validateState` 的 `!==1/2/3` 抛错），并断言 8 被拒。这是**模拟**，不是真机验证 |
| A5 | macOS / Linux 上的路径与大小写行为 | 开发与测试环境是 Windows | 路径/文件名校验是纯字符串规则，有单测 |
| A6 | 真实用户库的升级 / 降级 | 所有测试库都是合成数据 | `schema-downgrade` 用"布局 6 + 删新字段"的真实快照形态验证升级路径 |
| A7 | ZIP 损坏/加密/炸弹拒绝**在批量入口**的端到端验证 | 批量路径复用 `zip-worker`，其拒绝分支由既有 `novel-runtime*` 测试覆盖；批量侧只测了"展开超预算 / 单条目超限 / 隐藏项 / 不支持扩展" | 复用即证明；恶意包的端到端未在批量入口单测 |
| A8 | EPUB / PDF 的批量导入 | 代码路径支持（`isSupportedNovel` 含 `.epub`/`.pdf`），端到端用例只用了 `.txt` | `tests/epub.test.ts` / `tests/pdf.test.ts` 覆盖单文件，批量与单文件共用 worker |
| A9 | 接近 100 本、单批接近 1 GiB 的真实内存/耗时曲线 | 预算用声明尺寸验证（不写真实 1 GiB），并发只到 3 本 | `import-batch-budget` 的边界用例 |
| A10 | 官方 `describe` / World check CLI | 该 worktree 未安装 `cortico` CLI，`describe.json` 由发布流程生成，本轮未改工具集，故未重跑 | `describe.json` 未变；`tests/context-budget.test.ts` 校验 tool 声明 16 项与实际一致 |
| A11 | 英文界面观感 | 文案已写（`say(zh, en)`），测试只断言中文 | — |

## B. 已知限制（设计取舍，不是缺陷）

| # | 限制 | 说明 |
| --- | --- | --- |
| B1 | **降级后旧版本打不开库** | fail-closed 的代价。回滚前必须用新版本导出备份（见 06 第 5 节） |
| B2 | 停止当前书必须有可读的下一本 | 没有就拒绝，避免"已移出计划却仍在读"。替代：`keepReading: true`，或先暂停阅读 |
| B3 | 计划页用按钮排序，不是拖动排序 | 原任务书的拖动排序由按钮组替代（上移/置顶/插到下一本/移到最后/组内上移下移）。**本轮未实现拖动**，文档不声称支持拖动 |
| B4 | `selection.queue` 是只读投影且过滤已完读条目 | 任何直接写 `draft.queue` 的旧代码会失效（仓库内已全部迁移） |
| B5 | 计划条目 200 / 归档 300 / 系列 100 | 超限进 `overflow` 上报，不静默丢弃 |
| B6 | 单批 100 项 / 1 GiB，单文件 100 MiB，ZIP 512 MiB | 出厂值；可通过 `ImportBatches` 的 `budget` 参数注入，生产不注入 |
| B7 | 队首被暂缓时自动交接直接停住 | 有意：尊重"这周先别读这本"。代价是后面的书也不会被自动跳到 |
| B8 | ZIP 解包后书名取条目文件名 | 与单文件导入一致（`detectImportMetadata`）；包内没有可信书名来源，不猜测 |
| B9 | 重选文件要求大小完全一致 | 只有这样才能确认是同一本书；不同文件请删掉该条目重新导入 |
| B10 | 批次记录最多保留 20 条（含未完成） | `trimBatches`；清理只删记录不删书 |
| B11 | `check:ssm` 需要 SSM 负责人确认 | `src/library.ts`、`src/world.ts` 含共享区段，任何改动都会触发；未自行 `--accept-review` |

## C. 待办（下一阶段候选，不在本次范围）

| # | 项 |
| --- | --- |
| C1 | 计划页补拖动排序（保留现有按钮） |
| C2 | 批量导入逐本改书名/作者 |
| C3 | 系列建议"自动确认"（当前一律需人工） |
| C4 | `src/protocol/reading.md` 的 `since` 标记随正式发版上移（本轮未发布，保持 `0.66.7`） |
| C5 | 用真实旧二进制验证降级拒绝（把 A4 从模拟提升为实测） |

## D. 环境噪声（非代码缺陷）

`vitest` 在 Windows + 受限沙箱偶发 `Unhandled Error: EPERM ... ssr/...`，汇总多一条 error 计数但 `exit code 0`、用例全绿。整改前后都存在。
