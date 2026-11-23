# 阅读足迹看板 V1：实施与验收报告

- 日期：2026-11-23
- 分支：`codex/footprint-browse-v1`
- 工作树：`cortina/state/packages/bookfish-footprint-v1`（由 `50cf2de` 新建，未触碰 `round3` 工作树）
- 提交：见文末 SHA-256 清单与 `git log`
- 性质：只读浏览功能；**新增模型调用 0 次**

---

## 1. 结论

**已完成并已测试通过**

- 跨书足迹浏览（全部书籍 / 指定书籍），服务端聚合与分页。
- 双向游标翻页：上一页 / 下一页 / 回到最新，两种排序都成立。
- 书籍关键词搜索选择器（只列有足迹的书，显示作者与版本前缀、条数）。
- 排序：最新在前（默认）/ 最早在前；切换排序回到新顺序第一页（最早在前显示最早记录；R2 修正，见提交 `285f0b6`）。
- 每页 5 / 10 / 20 / 50，默认 10；服务端支持 50。
- 浏览位置持久化：书籍筛选、排序、每页数量、记录锚点、滚动位置；面板重挂载后恢复。
- 新足迹提醒（真实 COUNT）与临时预览；预览不改变历史页数据、页码、滚动位置；整体收起后才推进高水位。
- 新增索引 `history_sequence`，并给出迁移与回滚说明。

**已测试通过**

- 全量测试：99 个文件、1086 项通过、1 项跳过、0 失败（`evidence/full-tests-final.log`）。
- 新增测试：Library 层 10 项 + jsdom 面板 9 项。
- `tsc --noEmit`（主配置与 web 配置）均 0 错误。
- SSM 保护闸门：`blocked=0 review=3 allowed=11`，review 已登记理由（`evidence/ssm-guard.log`）。
- 帮助内容检查：`help content ok`。
- 合并验证：补丁干净应用到本机 0.66.0 工作树（含未提交 TXT WIP），两侧 typecheck 0 错误，48 项测试通过（`evidence/mergecheck-0.66.0.json`、`mergecheck-tests.log`）。
- 真实宿主验收：正式 Coopanion 上试用安装、6 次重启、Edge 驱动界面、回滚复验；默认值/筛选/排序/每页/翻页/持久恢复/提醒/预览/收起/回滚全部通过，并修复了真机暴露的 asc“回到最新”只显示 1 条问题（`HOST-ACCEPTANCE.md`）。

**未完成 / 未验证**

- 真实宿主中"大肥鱼自己写下一条新足迹 → 提醒"：验收窗口内她处于午餐作息（13:00 后才继续阅读），手动阅读被作息阻止；改用"调低持久化水位"验证了真实 probe → 预览 → 收起的完整链路。详见 `HOST-ACCEPTANCE.md`。
- 窄屏/触屏布局与 Coopanion 内嵌 WebView 的滚动差异：只在桌面宽屏 Edge 验证。
- 跨设备同步：按任务书明确不做。

**存在风险**

- 基线版本号不一致：git HEAD 是 0.65.1，0.66.0 是本机未提交的 TXT WIP。见第 2 节与第 10 节。
- 书籍聚合 `journalBooks` 是 O(n) 全表 GROUP BY：10k 条实测 29.5 ms，按线性外推 100k 条约 300 ms；只在进入面板/出现新足迹提醒时调用。
- 预览批次上限 50 条：若两次检测之间新增超过 50 条，`truncated` 为真，收起时高水位仍推进到批次最大值（更早的未展示记录会被视为已展示）。正常节奏（2 秒）下不会发生。
- 旧 `legacy` 手账节点保留但隐藏，仍每 2 秒渲染 5 条到隐藏 DOM（可忽略，后续可清理）。
- 真机验收暴露过"最早在前时回到最新只显示 1 条"的锚点对齐问题，已修复并补测试；最终构建在真实宿主复测通过。

**需要用户决策**

- 是否把该分支并入 0.66.0 TXT 线，以及是否升版本号/发布（涉及 `announcements.json` 与发布规范，本任务未做）。
- 是否接受"每本书首次查看时以当前最新序号建立该书的提醒基线"（避免把历史误报为新增；代价：首次查看前产生的新足迹不会单独提醒）。

---

## 2. 基线复核（阶段 0）

| 检查项 | 结果 |
| --- | --- |
| git HEAD | `50cf2de760012ea88950ed1d852ed3e3793f1054` |
| HEAD 的 `package.json` | **0.65.1**（不是 0.66.0） |
| 0.66.0 来源 | `bookfish-txt-acquisition-round3` 工作树中未提交的 TXT 改动（18 个已跟踪文件修改 + 4 个未跟踪文件） |
| 本机运行版本 | `0.66.0`（`local-extensions/bookfish-txt-0651-4ba8df5`） |
| 足迹数据层差异 | `journal.ts`、`history.ts`、`webui/legacy.ts`、`protocol/journal.md` 在 0.65.1 与 0.66.0 工作树之间逐字节一致 |
| 现有 trail 渲染链路 | 与只读盘点一致：`client.ts` 的 `readingPanel` + `legacy.ts` 的 `renderJournal` |
| 分页 SQL / 索引 | 与盘点一致；`before` 为排他上界，`history_page_episode` 覆盖单本查询 |
| 浏览器持久化 | `ctx.memo` = `localStorage`（`cortico.panel.` 前缀，页面/面板命名空间），写入失败退回内存，不抛错 |
| 可见性边界 | `trail` 已允许通过书籍下拉查看任意一本书的 `journal`；新接口只返回 `journal.items` 已有字段 + 书名/作者/版本，不扩大可见范围 |

**结论**：任务书写的是"0.66.0，HEAD 50cf2de"，实际 0.66.0 只存在于未提交工作树。为避免覆盖他人 WIP，本次从 `50cf2de` 新建独立工作树实现，并把改动以补丁形式验证可干净应用到 0.66.0 工作树（第 9 节）。

---

## 3. 实际修改文件清单

| 文件 | 类型 | 目的 |
| --- | --- | --- |
| `src/journal-browse.ts` | 新增 | 浏览接口的参数解析/校验、游标窗口计算、条目映射、类型定义 |
| `src/webui/footprint.ts` | 新增 | trail 内的浏览组件：选择器、排序、每页、分页、提醒、预览、持久化、滚动恢复 |
| `src/history.ts` | 修改 | 新增 `after/upTo/downTo` 过滤；`windowRows/countRows/sequenceExtremes/bookAggregates`；新增 `history_sequence` 索引。既有 `positions` 语义不变（仅重构成共用 `clauses()`） |
| `src/library.ts` | 修改 | 新增 `journalBrowse/journalBooks/journalProbe/journalNew` 及私有查询适配（SQL 路径 + 老 schema 内存回退）；未改任何既有方法 |
| `src/world.ts` | 修改 | trail/status/shelf 面板新增 4 个只读 invoke 方法；未动模型工具与 story 路由 |
| `src/webui/client.ts` | 修改 | trail 页挂载浏览组件；旧单本手账移入隐藏容器；页切换激活/停用；"查看阅读足迹"/"聊聊这一段"改为切换浏览范围；卸载时释放组件 |
| `src/webui/style.ts` | 修改 | 浏览组件样式（工具条、提醒、预览、固定高度滚动列表、分页） |
| `src/webui/style.ts` 之外无视觉重构 | — | 复用现有卡片/按钮/详情样式 |
| `tests/journal-browse.test.ts` | 新增 | 10 项：跨书分页、双向游标、锚点、空洞、删书、规模、非法参数、probe/new 批次 |
| `tests/webui/footprint.test.ts` | 新增 | 8 项：默认值、书籍搜索、翻页、持久恢复、损坏回退、提醒/预览/收起、失败不推进、按书作用域 |
| `scripts/bench-footprint-browse.mts` | 新增 | 可复现性能测量（合成 + 真实库只读 SQL + 索引实验） |
| `docs/footprint-browse-v1/*` | 新增 | 设计、报告、证据 |
| `lib/webui.js`、`lib/webui-txt-builtin-bing-0651.js` | 重新构建 | 与源码一致的面板产物 |

未修改：`src/journal.ts`、`src/status.ts`、`src/protocol/*`、`src/story/*`、`src/config.ts`、`src/tool-schemas.ts`、`describe.json`、`CHANGELOG.md`、备份/恢复/删书逻辑。

---

## 4. 新增接口契约

四个方法都注册在 `status` / `shelf` / `trail` 面板的 `invoke` 上，只读、不写库、不触碰模型工具。

### 4.1 `journal_browse`

```ts
journal_browse({
  scope?: 'all' | { bookKey: string },   // 默认 'all'
  order?: 'desc' | 'asc',                // 默认 'desc'
  limit?: 5 | 10 | 20 | 50,              // 默认 10
  cursor?: { edge: 'before' | 'after'; sequence: number },  // 排他
  anchorSequence?: number,               // 包含式；与 cursor 互斥
})
```

返回 `scope/order/limit/total/position{start,end}/page{count,firstSequence,lastSequence}/headSequence/tailSequence/hasPrev/hasNext/prevCursor/nextCursor/items[]`。

- `items[]` 字段 = 现有 `journal.items` + `bookKey/bookTitle/bookAuthor/bookRevision`；**不包含** `reason`、`priorJudgment`、`characters`、`questions`、引文原文（仍由 `episode(id)` 提供）。
- `total` 与 `position` 全部来自真实 `COUNT`；`hasPrev/hasNext` 由 `position` 与 `total` 推出。
- 游标方向与排序解耦：`edge` 表示"严格更早/更新"；desired order 与 SQL order 不同时结果反转。
- 错误：`limit must be one of 5, 10, 20, 50`、`order must be "desc" or "asc"`、`cursor.edge ...`、`cursor and anchorSequence are mutually exclusive`、`Book revision is not in the library`、`scope must be "all" or {bookKey}`。

### 4.2 `journal_books`

```ts
journal_books() → { total, books: [{ bookKey, id, revision, title, author, count, lastSequence }] }
```

只返回 `count > 0` 的书，按 `lastSequence` 降序。一次 `GROUP BY bookKey`，不逐本调用 `journal`。

### 4.3 `journal_probe`

```ts
journal_probe({ scope?, since?: number | null }) → { total, headSequence, tailSequence, count }
```

`since` 为空时 `count = 0`（用于建立基线）；否则 `count = COUNT(sequence > since)`。

### 4.4 `journal_new`

```ts
journal_new({ scope?, since: number, order?, limit? })
  → { count, maxSequence, items: BrowseItem[], truncated }
```

`maxSequence` 为点击时 scope 内的最大序号（批次边界）；`items` 最多 50 条，按当前排序；`truncated = count > items.length`。

### 4.5 兼容性

`get` / `journal` / `episode` / `timeline` / `search` / `bookfish_lookup` / `bookfish_record_reflection` / `bookfish_finish_reading` 的签名与返回**未改动**；`tests/journal.test.ts`、`tests/history.test.ts`、`tests/library.test.ts`、`tests/webui/client.test.ts` 全量通过。

---

## 5. 索引与迁移

新增一条 schema：

```sql
CREATE INDEX IF NOT EXISTS history_sequence ON history(kind,sequence,n,v,until_v);
```

- **迁移**：`HistoryStore.open()` 中的 `CREATE INDEX IF NOT EXISTS`，旧库首次打开自动补建；不迁移数据、不改行、不改版本号。
- **回滚**：删除该索引不影响任何语义（只影响性能），可直接 `DROP INDEX history_sequence`；即使保留，旧代码也照常工作。
- **收益**（同机实测）：2000 条合成数据，全库首页 7.68 ms → 1.08 ms，连续 10 页 98.6 ms → 11.7 ms；真实库（871 条）在副本上 6.45 ms → 0.087 ms。无索引时执行计划出现 `USE TEMP B-TREE FOR ORDER BY`。
- **代价**：500 条合成数据下播种（每条一次提交）11.34 s → 11.83 s，约 +4.3%（含 fsync 与进程噪声，仅作指示）。
- 证据：`evidence/bench-2000-preindex.json`、`bench-2000-indexed.json`、`bench-10000.json`、`index-write-cost.json`。

---

## 6. 浏览状态持久化

存储：`ctx.memo`（框架封装 `localStorage`，键前缀 `cortico.panel.`，按 page:panel 隔离），本功能键 `browse-v1`。

```ts
{ v: 1,
  scope: 'all' | '<bookKey>',
  order: 'desc' | 'asc',
  limit: 5 | 10 | 20 | 50,
  anchor: number | null,          // 当前页第一条的 sequence
  scrollTop: number,              // 列表滚动容器
  lastPresented: { all: number | null, books: Record<bookKey, number> },
  savedAt: number }
```

- 读取严格校验：版本、枚举、类型、范围；任一不符或 JSON 损坏 → 整份丢弃用默认值（`all` / `desc` / `10` / 无锚点 / 0）。
- 写入：筛选/排序/每页/翻页/锚点变化立即写；滚动经 250 ms 去抖；`pagehide` 与卸载时 flush。
- 恢复：读状态 → 校验书籍是否仍存在（不存在回落 `all`）→ `journal_browse(anchorSequence)` → 渲染 → 设 `scrollTop`。
- 锚点失效：服务端"包含式锚点"返回最近更早（desc）或最近更晚（asc）记录；整页为空时前端回退首页，不修改任何历史记录。
- 不写 `history.sqlite` / `library.json`，不进备份，不做跨设备同步；与 Persona/SSM 完全无关。

---

## 7. 新足迹检测与预览

- 进入 trail：立即 `journal_probe`；之后复用现有 2 秒节奏，**仅在 trail 可见时**发请求，in-flight 去重，不新增全量 `get` 轮询。
- 基线：`since = null` → 用 `headSequence` 建立 `lastPresented`，历史不误报。
- 每个 scope 独立水位：看 A 书不推进 `all` 或其他书；切到从未看过的书时以该书当前 heads 建立基线。
- 提醒数量 = `journal_probe.count`（真实 COUNT，受 scope 限制）。
- 点击"查看新增" → `journal_new`，返回的 `maxSequence` 固定为本批边界；预览插在列表上方独立容器，**不修改列表数组/页码/滚动**。
- "整体收起" → `lastPresented[scope] = 批次 maxSequence` 持久化；预览 DOM 移除；列表不动。
- 预览期间新增：探测暂停、边界不推进，收起后下一次探测会报告剩余。
- 预览失败：不推进水位，显示错误，可重试。
- 预览未收起就关闭：水位未推进，重新进入会再次提醒。
- 不建立逐条已读、红点、未读统计。

---

## 8. 测试与验收

### 8.1 实际执行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | 0 错误 |
| `tsc --noEmit -p tsconfig.web.json` | 0 错误 |
| `vitest run`（全量） | **99 文件 / 1086 通过 / 1 跳过 / 0 失败** |
| `vitest run tests/journal-browse.test.ts` | 10/10 |
| `vitest run tests/webui/footprint.test.ts` | 8/8 |
| `check-ssm-protected.mts --base 50cf2de --accept-review ...` | `blocked=0 review=3 allowed=11`，放行理由已记录 |
| `check-help-content.mts` | `help content ok` |

### 8.2 任务书验收项对照

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 默认全部书籍 | ✅ | UI 测试 1 |
| 搜索书名、只列有足迹的书、可切回全部、无匹配提示 | ✅ | UI 测试 2 |
| 切换书籍保留排序与每页数量、进入新范围起始页 | ✅ | UI 测试 2、4 |
| 最新在前 / 最早在前 | ✅ | Library 测试 + UI 测试 |
| 默认每页 10；5/10/20/50 | ✅ | UI 测试 1、2；Library 测试 limit 50 |
| 上一页 / 下一页 / 回到最新，边界禁用 | ✅ | UI 测试 3；Library 双向游标测试 |
| 跨书与单本分页正确、无重无漏 | ✅ | Library 遍历测试（两种排序） |
| 翻页期间新增不改旧页 | ✅ | Library 测试 + UI 预览测试 |
| sequence 空洞、删书后分页正确 | ✅ | Library 空洞测试 |
| 不用最大 sequence 推算数量 | ✅ | 代码使用 COUNT；空洞测试断言 position |
| 每页 50 服务端正常 | ✅ | Library 测试；UI limit 选择 |
| 恢复筛选/排序/每页/锚点/滚动 | ✅（面板重挂载） | UI 测试 4 |
| 删除锚点记录合理回退 | ✅ | 服务端最近邻语义 + UI 回退首页 |
| 存储损坏安全回退 | ✅ | UI 测试 5 |
| 新记录提醒、历史页不自动跳 | ✅ | UI 测试 6 |
| 预览不改历史页/页码/滚动 | ✅ | UI 测试 6 |
| 收起恢复原浏览位置 | ✅ | UI 测试 6 |
| 预览期间新增留到下一批 | ✅ | Library 测试 + 机制说明 |
| 查询失败不推进边界 | ✅ | UI 测试 7 |
| 首次启用不误报历史 | ✅ | UI 测试 6、8 |
| 切书提醒按范围 | ✅ | UI 测试 8 |
| 无逐条已读状态 | ✅ | 无该字段/接口 |
| 面板关闭无轮询 | ✅（框架 interval 随卸载停止；非 trail 页不请求） | 代码 + UI 测试卸载 |
| 重开发现关闭期间新增 | ✅（进入即 probe） | 逻辑 + UI 测试 6 |
| 原有数据/证据/进度不变 | ✅ | 全量回归；本功能无写路径 |
| 备份/恢复、MVCC 完整性 | ✅ | 全量回归（未改相关代码） |
| 真实宿主数据未修改 | ✅ | 仅只读连接 |

### 8.3 真实宿主验收（2026-11-23 11:49–12:10）

在正式 Coopanion 上做了试用安装 → 多次重启 → Edge（CDP）驱动界面 → 回滚，完整结果见 [`HOST-ACCEPTANCE.md`](HOST-ACCEPTANCE.md) 与 `evidence/host/*.png`。要点：

- 首次打开：全部书籍 / 最新在前 / 10 条；书籍搜索只列有足迹的书；切书保留排序与每页数量。
- desc 的上一页/下一页/回到最新正常；**asc 的"回到最新"在真机暴露出只显示 1 条的问题，已修复并复测为完整末页**。
- 正常关闭浏览器 + 重启宿主后：书籍筛选、排序、每页数量、页码、滚动位置全部恢复（两轮独立验证）。
- 新足迹：把持久化水位调到 885 后，真实 `journal_probe` 返回 1 条，出现"大肥鱼新增了 1 条足迹"；预览 1 条且历史页/页码/滚动不变；整体收起后水位推进到 886。
- 按书范围提醒：西游记内 1 条、切到全部后不再提醒。
- trail 切到书架后 6 秒内没有 `journal_probe` 请求；回到 trail 后恢复 2 秒节奏。
- 回滚后旧版 0.66.0 正常加载，新界面不出现。
- **未覆盖**：真实手机/窄屏、用户自己常用的浏览器配置文件、内嵌 WebView 的滚动惯性；以及"宠物自己写新足迹"的实机时刻（她当时在午餐作息）。

### 8.4 未覆盖/需真实宿主确认

- 窄屏/触屏布局与 Coopanion 内嵌 WebView 的滚动差异：只在桌面宽屏 Edge 验证。
- 用户自己常用的浏览器配置文件（本次用独立 Edge 配置；持久化机制同为 localStorage）。

---

## 9. 性能实测

环境：Node v24.14.1，Windows 10 19045，同一台机器；数据为临时目录合成库与真实库只读副本/只读连接。

| 场景 | 数据量 | 中位数 | p95 |
| --- | --- | --- | --- |
| 全库首页 desc/10（无索引） | 2000 | 7.68 ms | 8.01 ms |
| 全库首页 desc/10（有索引，最终构建） | 2000 | 0.57 ms | 0.68 ms |
| 连续 10 页（无索引） | 2000 | 98.6 ms | — |
| 连续 10 页（有索引，最终构建） | 2000 | 6.42 ms | — |
| 锚点定位（中间，对齐页，最终构建） | 2000 | 0.72 ms | 0.81 ms |
| 全库首页 desc/10 | 10000 | 2.98 ms | 4.24 ms |
| 单本首页 | 10000 | 0.88 ms | 3.72 ms |
| 锚点定位（中间） | 10000 | 3.33 ms | 3.46 ms |
| 每页 50 | 10000 | 3.11 ms | 5.64 ms |
| 10 连续页合计 | 10000 | 29.8 ms | — |
| `journalProbe` | 10000 | 3.54 ms | 3.93 ms |
| `journalNew` | 10000 | 2.97 ms | 3.68 ms |
| 书籍聚合 `journalBooks` | 10000 | 29.5 ms | 31.1 ms |
| 真实库首页（只读 SQL） | 871 | 6.45 ms | 8.73 ms |
| 真实库 COUNT | 871 | 0.16 ms | 0.76 ms |
| 真实库聚合 | 871 | 6.94 ms | 9.01 ms |
| 真实库首页（副本 + 索引） | 871 | 0.087 ms | 0.21 ms |

- 合成库落盘：2000 条 ≈ 4.5 MB；10000 条 ≈ 22 MB（含索引，平均 2.2 KB/条）。
- 每次翻页只取 `limit+1` 行 + 两次 COUNT，**不加载全量足迹**；书籍选择器一次聚合查询，**不逐本拉取**。
- 新足迹检测每次只取 3 个数（total/count/head），不返回记录内容。
- 真实库计时受宿主同时阅读影响（会话期间宿主自己从 866 条增长到 871 条），因此偏保守；本次只读连接未写入任何数据。
- 证据：`evidence/bench-2000-preindex.json`、`bench-2000-indexed.json`、`bench-10000.json`、`index-write-cost.json`。

### 9.1 环境事件（已修复，不影响交付物）

做 0.66.0 合并验证时临时建了一个带 `node_modules` junction 的 worktree；在 Windows 上移除该 worktree 时，递归删除顺着 junction 把 `round3` 的 `node_modules` 清空了。该目录不受版本控制、可重建；已用仓库里原有的 `node_modules.pre-round3-junction` 恢复，并在恢复后的环境**重跑全量测试：99 文件 / 1086 通过 / 1 跳过**。`round3` 的已跟踪文件与未提交 WIP 未受影响（`git status` 改动数仍为 32）。

---

## 10. 与 0.66.0 基线的差异与合并验证

本分支从 `50cf2de` 新建，差异仅限第 3 节列出的文件；0.66.0 的 TXT 改动不在本分支内。

合并验证（不改动 `round3` 工作树）：

1. `git stash create` 取 0.66.0 WIP 的已跟踪改动快照 `4586100`，建临时 worktree；
2. 补入 4 个未跟踪 WIP 源文件；
3. 应用本分支补丁（仅 `src tests scripts docs`，122,975 字节）→ **`git apply` 退出码 0，无冲突**；
4. 两侧 typecheck 0 错误；`journal-browse` + `footprint` + `client` 三个测试文件 **48 项全部通过**。

证据：`evidence/mergecheck-0.66.0.json`、`evidence/mergecheck-tests.log`。临时 worktree 已删除，`round3` 保持原状。

建议合并方式（由用户执行）：先在 `round3` 提交 TXT WIP，再 `git cherry-pick <本分支提交>`；或在 `round3` 中 `git merge codex/footprint-browse-v1`。冲突面应为零（新增方法与新文件，共享文件改动位置不同）。

---

## 11. 隐私与数据真实性门禁核对

| 门禁 | 结论 |
| --- | --- |
| 不声称已有私密/公开分类 | 未声称；文档明确 `visibility` 不存在 |
| 不把 kind 当权限 | 未做；kind 只用于文案 |
| 不补 visibility | 未加字段 |
| 不把未来私人日记加入跨书列表 | 无新数据源；只读现有 `ReadingEpisode` |
| 不用前端隐藏代替服务端过滤 | 服务端只返回既有可见字段；无新增可见范围 |
| 跨书查询不扩大现有可见范围 | 现有 trail 已可逐本查看任何书的 `journal`；新接口返回其字段超集（仅加书名/作者/版本） |
| 无可见性证明时暂停 | 已核实：`journal()` 无任何可见性过滤，trail 的书籍下拉已列出全部书 |
| 不补造心情/理由 | 无写路径；UI 显示"未记录当时理由" |
| 不标"已验证解释" | 未添加任何验证标记 |
| 不读未确认正文 | 查询只含 `sequence`/`bookKey` 过滤，不返回正文 |
| 不改证据/修订关系 | 未改 |
| 不修改既有记录 | 无 UPDATE/DELETE 足迹的代码 |

---

## 12. 回滚方案

1. **代码回滚**：`git revert <本分支提交>` 或切回 `50cf2de`。本功能不写业务数据，回滚后用户足迹、进度、备份完全不变。
2. **数据回滚**：无需迁移，唯一 schema 变化是 `history_sequence` 索引。旧代码不认识该索引也能正常读写；如需彻底清除，`DROP INDEX history_sequence`。
3. **浏览器状态**：`browse-v1` 键只影响浏览位置；删除该 localStorage 键即回到默认（全部书籍 / 最新在前 / 10 条）。旧代码不读取该键。
4. **安装回滚**：真机验收做过一次可回滚的试用安装（备份 `data/extensions/package.json`、junction 指向 trial 副本、结束时恢复并复验旧版 0.66.0）；trial 目录已删除，原安装未被覆盖。详见 `HOST-ACCEPTANCE.md`。

---

## 13. 证据与校验

| 文件 | 内容 |
| --- | --- |
| `HOST-ACCEPTANCE.md` | 真实宿主验收：安装/回滚、逐项结果、真机发现的问题与修复 |
| `evidence/host/*.png` | 真机截图（默认值、筛选、恢复、提醒、预览、收起、回滚后） |
| `evidence/full-tests-final.log` | 全量测试输出（99 文件 / 1086 通过） |
| `evidence/mergecheck-0.66.0.json` | 0.66.0 工作树合并验证事实 |
| `evidence/mergecheck-tests.log` | 合并后 48 项测试输出 |
| `evidence/ssm-guard.log` | SSM 保护闸门结果与放行理由 |
| `evidence/bench-*.json` | 性能实测原始数据 |
| `evidence/index-write-cost.json` | 索引写放大的 A/B |
| `evidence/SHA256SUMS.txt` | 本次改动文件与产物的 SHA-256 |

> 真实宿主数据全程只读；会话期间库从 866 条增至 872 条，是宿主自己继续阅读造成的。验收中一次"继续读"被作息拦下（提示午餐至 13:00），未触发模型阅读，也未写任何用户数据。

---

## 14. 需要用户决策的问题

1. **并入哪条线**：本分支基于 0.65.1 提交；0.66.0 是本机未提交 WIP。建议先提交 WIP，再 cherry-pick 本分支。
2. **是否发版**：若发版，按仓库规范需升版本、更新 `announcements.json` 与内置发布记录；本任务未做。
3. **每本书的提醒基线**：首次查看某书时以当前最新序号为基线，避免历史误报；是否接受？
4. **`journalBooks` 的上限策略**：10 万条时约 300 ms（估算，未压测）；是否需要缓存或分页选择器。
