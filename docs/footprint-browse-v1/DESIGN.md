# 阅读足迹看板 V1：技术设计

- 基线：git `HEAD 50cf2de`（`package.json` 0.65.1）；本机运行的 0.66.0 是 `bookfish-txt-acquisition-round3` 工作树里未提交的 TXT 改动。足迹相关源码（`journal.ts` / `history.ts` / `webui/legacy.ts` / `protocol/journal.md`）在两者间逐字节相同，因此本设计对两者都适用。
- 分支：`codex/footprint-browse-v1`
- 工作树：`cortina/state/packages/bookfish-footprint-v1`
- 性质：只读浏览；不新增模型调用；不改 `ReadingEpisode`、阅读进度、SSM、Persona、备份与删书语义。

## 1. 现状约束（来自只读盘点）

- `trail` 是阅读面板的一个 tab，由 `readingPanel` 挂载，手账由 `legacy.ts` 渲染。
- 现有 `journal(bookKey, before, limit)` 只能单本、只向更早方向翻页，`limit ≤ 20`。
- `get` 只带当前书首页 5 条；没有跨书聚合。
- 面板靠 2 秒 `get` 轮询；宿主提供了 `ctx.stream`，扩展未使用。
- `ctx.memo` 是宿主框架提供的 localStorage 持久化（`cortico.panel.` 前缀），失败时退回内存。
- `ReadingEpisode` 无 `visibility`；现有 trail 已经把所有书的 `journal` 暴露给用户（书籍下拉里可以选任意一本），因此"跨书聚合"不扩大用户可见范围：新接口只返回现有 `journal.items` 已有的字段集合。

## 2. 接口契约（新增，只读）

四个方法都挂在 `status` / `shelf` / `trail` 面板的 `invoke` 上，只做查询。

### 2.1 `journal_browse`

```ts
journal_browse({
  scope?: 'all' | { bookKey: string },   // 默认 'all'
  order?: 'desc' | 'asc',                // 默认 'desc'（最新在前）
  limit?: 5 | 10 | 20 | 50,              // 默认 10
  cursor?: { edge: 'before' | 'after'; sequence: number },  // 排他
  anchorSequence?: number,               // 包含式锚点，与 cursor 互斥
  query?: string,                        // 关键词过滤：空白分隔，最多 8 个词、每词 40 字
})
```

`query` 只在足迹可读字段内做大小写不敏感的子串匹配（触发、感想、前判、理由、心情标签、人物名/别名、问题）；不搜证据引文。命中集合上的 total/position/cursor/anchor/order/limit 语义与无关键词时完全一致。

返回：

```ts
{
  scope: { bookKey: string | null },
  order: 'desc' | 'asc',
  limit: 5 | 10 | 20 | 50,
  total: number,                  // 真实 COUNT（scope 内）
  position: { start: number; end: number },  // 1 基；空页为 {0,0}
  page: { count: number; firstSequence: number | null; lastSequence: number | null },
  headSequence: number | null,    // scope 内最大 sequence
  tailSequence: number | null,    // scope 内最小 sequence
  hasPrev: boolean,
  hasNext: boolean,
  prevCursor: { edge; sequence } | null,
  nextCursor: { edge; sequence } | null,
  items: BrowseItem[],
}
```

`BrowseItem` = 现有 `journal.items[]` 的字段 + 书籍元数据：

```ts
{
  id; sequence; recordedAt; kind; revises; trigger; interpretation; mood;
  chapters: string[]; segmentIds: number[];
  bookKey; bookTitle; bookAuthor; bookRevision;
}
```

不返回 `evidence.quote`、`reason`、`priorJudgment`、`characters`、`questions`——这些仍由 `episode(id)` 提供，与现有详情一致。

**游标方向与排序解耦**：`edge` 表示"严格更早 / 严格更新"，与 `order` 无关。

- `edge: 'before'` → `sequence < s`，SQL `ORDER BY sequence DESC LIMIT n`；若 `order='asc'` 则结果反转后展示。
- `edge: 'after'` → `sequence > s`，SQL `ORDER BY sequence ASC LIMIT n`；若 `order='desc'` 则结果反转。
- 无 cursor、有 `anchorSequence`：锚点表示"包含该记录的那一页"，并按页大小对齐：
  - 先用真实 COUNT 算出锚点在显示顺序里的名次 `rank`，页序号 `floor((rank-1)/limit)`；
  - 从锚点向"页首"方向取 `(rank-1) % limit` 条邻居，得到该页第一条的 sequence `start`；
  - `desc` 用 `sequence <= start`、`asc` 用 `sequence >= start` 查询。
  - 保存的页锚点本身就是页首记录，因此恢复时 `rank` 落在页边界，回到同一页；"最早在前"的"回到最新"因此返回真正的最后一页，而不是只有一条的尾巴。
  - 锚点记录已被删除时，名次与邻居仍按 sequence 顺序计算，落回"它本该在的那一页"；邻居不足则退回"锚点即页首"的旧语义。
- 无 cursor、无 anchor → 首页：`desc` 从最大 sequence 开始，`asc` 从最小开始。

这样"上一页"永远是"当前页边界之外、相邻的那一页"：desc 的上一页取 `after=first` 的最近 N 条（SQL 升序），反转后仍是显示顺序。

**位置与边界**都用真实 COUNT：

- `total = COUNT(scope)`
- `start`：desc `= COUNT(sequence > first) + 1`；asc `= COUNT(sequence < first) + 1`
- `hasPrev = start > 1`，`hasNext = end < total`
- 页码由前端用 `total` 与 `limit` 计算，服务端不提供页码，也不从 sequence 推算。

### 2.2 `journal_books`

```ts
journal_books() → {
  total: number,                      // 所有足迹条数
  books: Array<{
    bookKey; id; revision; title; author;
    count;                            // 该书足迹数
    lastSequence;                     // 该书最大 sequence（=最近一条）
  }>,                                 // 只包含 count > 0 的书；按 lastSequence 降序
}
```

SQL：`SELECT bookKey, COUNT(*), MAX(sequence) FROM history WHERE kind='episodes' AND visibility GROUP BY bookKey`，再与 `state.books` 元数据合并。不逐本调用 `journal`。

### 2.3 `journal_probe`

```ts
journal_probe({ scope?, since?: number | null })
  → { total, headSequence, tailSequence, count }
```

`count = COUNT(scope AND sequence > since)`；`since` 为 `null/undefined` 时 `count = 0` 并返回 `headSequence`（首次启用建立基线的依据）。用于新足迹提醒，只取轻量聚合。

### 2.4 `journal_new`

```ts
journal_new({ scope?, since: number, order?: 'desc'|'asc', limit?: 5|10|20|50 })
  → { count, maxSequence, items: BrowseItem[], truncated }
```

- `count = COUNT(scope AND sequence > since)`
- `maxSequence = MAX(sequence) in scope`（点击那一刻固定的批次边界）
- `items`：`sequence > since` 且按显示顺序最多 `min(limit, 50)` 条；`truncated = count > items.length`
- 预览只读，不改任何边界。

## 3. SQL 与索引

新增查询全部走 `history` 表，条件 `kind=? AND v<=? AND (until_v IS NULL OR until_v>?)`，复用现有索引：

| 查询 | 索引 |
| --- | --- |
| 单本分页 | `history_page_episode(kind,bookKey,sequence,n,v)` |
| 全部书分页 | 新增 `history_sequence(kind,sequence,n,v,until_v)`（covering），排序不再落临时 B-Tree |
| 书籍聚合 | `history_page_episode` 的 `(kind,bookKey,sequence)` 前缀（GROUP BY 仍有一次小排序） |
| 新记录 COUNT | `history_sequence` 的 `(kind,sequence)` 前缀 |

`history_sequence` 是唯一的新增 schema。它在 `HistoryStore.open()` 里用 `CREATE INDEX IF NOT EXISTS` 建立：旧库首次打开时自动补建，不迁移数据、不改行；回滚时该索引可保留也可 `DROP INDEX`，两者都不影响正确性。实测收益（2000 条合成数据）见 `evidence/bench-2000-preindex.json` 与 `bench-2000-indexed.json`：全库首页 7.68 ms → 1.08 ms，连续 10 页 98.6 ms → 11.7 ms。不加索引时 `EXPLAIN QUERY PLAN` 明确出现 `USE TEMP B-TREE FOR ORDER BY`（`evidence/bench-10000.json` 的 live 部分）。

## 4. 浏览状态持久化

存储：`ctx.memo`（宿主框架的 localStorage，键 `cortico.panel.world:bookfishtrail` + 我们的键），与阅读数据完全分离。

```ts
interface FootprintBrowseState {
  v: 1;
  scope: 'all' | string;          // string = bookKey
  order: 'desc' | 'asc';
  limit: 5 | 10 | 20 | 50;
  anchor: number | null;          // 当前页第一条的 sequence
  scrollTop: number;              // 列表滚动容器的 scrollTop
  lastPresented: {
    all: number | null;
    books: Record<string, number>; // bookKey -> 已展示高水位
  };
  savedAt: number;
}
```

- 读取严格校验：`v !== 1`、字段类型/枚举不合法、JSON 损坏 → 整份丢弃并用默认值（`all` / `desc` / `10` / 无锚点 / 0 滚动）。
- 写入失败（隐私模式、配额满）由 `memo` 内部兜底为内存态，不抛错、不影响面板。
- 恢复顺序：读状态 → 校验书籍是否仍存在（否则回落 `all`）→ `journal_browse(anchorSequence)` → 渲染 → 设 `scrollTop`。
- 锚点记录被删：`anchorSequence` 的"或最近更早"语义自然回退；若查询为空，则回退到首页。
- 不写 `history.sqlite` / `library.json`，不进入备份，不做跨设备同步。

## 5. 新足迹提醒与临时预览

- 面板激活（进入 trail）立即 `journal_probe`；之后复用 2 秒节奏（与现有轮询同周期），仅在 trail 可见时发请求，带 in-flight 去重，不新增全量 `get` 轮询。
- 首次启用：`since=null` → 用 `headSequence` 建立 `lastPresented` 基线，历史记录不报"新"。
- 每个 scope（`all` 与每本书）独立维护水位；查看 A 书不推进 `all` 或其他书的水位。
- 新书首次切换：以该书当前 `headSequence` 为基线（避免把历史全部误报为新增）。
- 点击提醒 → `journal_new(since=水位)`；返回的 `maxSequence` 固定为本批边界；预览插在列表上方独立区域，列表数组、页码、滚动位置都不动。
- 整体收起 → `lastPresented[scope] = 批次 maxSequence` 并持久化；预览 DOM 移除，列表不动。
- 预览期间新增 → 因为边界已固定且水位未推进，下一次提醒会包含它们。
- 预览查询失败 → 不推进水位，提示可重试。
- 预览未收起就关闭浏览器 → 水位未推进，重新进入会再次提醒（不静默丢弃）。
- 不建立逐条已读、红点、未读统计。

## 6. UI 结构（trail 内，最小改动）

```
[搜索书籍输入] [书籍下拉：全部书籍 + 有足迹的书] [搜索足迹输入]
                                    [排序 ▾] [每页 ▾]   ← 右侧紧凑组，同一行
[提醒：大肥鱼新增了 N 条足迹  (查看)]
[预览区（可整体收起）]        ← 独立查询结果，不插入列表
[列表滚动容器 .footprint-list]
  卡片：时间 · 类型 · 书籍（全部书时） · 章节 / 触发 / 感想+心情 / 聊聊 / 原文依据
[上一页] 第 X / Y 页 · 共 N 条 [下一页] [回到最新]
```

- 排序与每页是工具栏右侧的紧凑组：内联标签、选择器自适应宽度，两者始终同一行；窄屏时整组一起换行，不会只剩“每页”单独掉下去。

- 保留原有卡片信息与详情（`episode` 的引文、理由、修订链）。
- 旧 `legacy` 手账节点保留但隐藏（不删代码，避免影响 status 面板与既有测试）。
- 书籍选择器用 `journal_books` 一次取回；搜索在浏览器内对书名/作者/版本前缀过滤（≤100 本，无额外查询）。
- 按钮文案固定：上一页 / 下一页 / 回到最新，不随排序变化。
- 切换排序会清空页锚点并加载新顺序第一页：最早在前显示最早记录，最新在前显示最新记录；每页数量变更才保留当前页首记录（R2 修正：此前保留锚点会让 asc 落到最新记录所在的末页）。
- 空结果、无匹配书籍、查询失败都有明确文案。

## 7. 测试计划

1. `tests/journal-browse.test.ts`（Library 层）
   - 跨书分页、单本分页、两种排序、双向游标往返、遍历无重无漏
   - 50 条/页、非法 limit/order/cursor/anchor
   - 翻页期间追加新记录不改旧页；sequence 空洞；删书后 total 与分页
   - 锚点恢复（存在/已删/低于最小）
   - `journal_books` 计数与排序；`journal_probe` 基线与计数；`journal_new` 批次边界与 truncated
2. `tests/webui/footprint.test.ts`（jsdom，真实 World）
   - 默认全部书 / 最新在前 / 10 条
   - 书籍搜索与切换、排序与每页保持、上一页/下一页/回到最新
   - 持久化恢复（重挂载）、损坏状态回退、锚点与滚动恢复
   - 新足迹提醒、预览不改变列表/页码/滚动、收起推进水位、失败不推进、切书按范围计数
3. 现有 `tests/journal.test.ts`、`tests/webui/client.test.ts` 全量回归。
4. 性能：真实库 SQL 计时 + `EXPLAIN QUERY PLAN`；合成 2k/10k 条走完整 Library 接口计时。

## 8. 风险与回滚

- 风险 1：旧 `legacy` 手账仍会每 2 秒渲染 5 条到隐藏节点。代价可忽略；若后续要清掉，需同时改 status 面板与测试。
- 风险 2：`ctx.memo` 在 localStorage 不可用时退回内存，重启后丢失位置——这是宿主既有降级路径，UI 不报错。
- 风险 3：跨书 `ORDER BY sequence` 若数据量大到数十万，需要复核执行计划是否走索引；交付前以实测为准。
- 回滚：本功能不写业务数据，回滚只需 `git revert` 本次提交（或切回 `50cf2de`）；用户数据无迁移、无残留。
