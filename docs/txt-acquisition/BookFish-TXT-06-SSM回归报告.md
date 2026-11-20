# BookFish TXT 获取模块 · 06 SSM 回归报告

核心结论：本次改动**没有**改变阅读任务创建、阅读确认、已读进度推进、阅读回执真实性、Episode 证据、Story Index/StoryStore、Persona Memory、阅读足迹决策与长篇读后感流程。新模块只提供「书籍内容进入书架」这一件事。

## 一、未触碰的文件（行为不可能变化）

| 领域 | 文件 | 状态 |
|---|---|---|
| 阅读调度与推进 | `src/scheduler.ts` | 未改 |
| 阅读回执与 Episode | `src/library.ts` 中 `recordReading`/`confirm`/Episode 相关段落 | 未改（只在导入区新增 `importFileBestEffort`，43 行全为新增） |
| 故事索引 | `src/story*.ts` / StoryStore 调用 | 未改 |
| 读后感 | `src/reviews.ts` | 未改 |
| 分享 | `src/sharing.ts` | 未改 |
| 长篇连载 | `src/serial-sync.ts`、`src/serial-types.ts` | 未改 |
| 书源获取 | `src/novel-fetch.ts`、`src/novel-engine.ts`、`src/novel-integrity.ts`、`src/biquge.ts`、`src/source-http.ts` | 未改 |
| 正文存储 | `src/paged-book.ts`、`src/stream-index.ts`、`src/books.ts` | 未改 |
| 进度/历史 | `src/history.ts`、`src/journal.ts` | 未改 |
| Persona Memory | 无任何写入点被新增 | 未改 |

## 二、改到的共享文件里，改动都是增量

| 文件 | 新增内容 | 是否触碰既有语义 |
|---|---|---|
| `src/library.ts` | `importFileBestEffort` 一个方法 + 两处 import | 否。内部仍走原有 `addBook`，同 `bookKey` 仍判 `duplicate`，上限仍 100 本/128Mi 字符 |
| `src/book-storage.ts` | `importFileBestEffort` 一个方法 | 否。仍用同一 `this.dir`、`loadPagedBook`、`collect` |
| `src/stream-import.ts` | 宽松解码/导入三个导出 | 否。`canonicalize`、`importFileBlob`、`detectEncoding` 一行未改 |
| `src/selection.ts` | `onExternalImport` 一个方法（50 行） | 否。`fulfill`、`recordFailure`、`deferIntent`、`announce`、队列写入全部原样复用 |
| `src/config.ts` | 三个新设置项 + 一项校验 | 否 |
| `src/world.ts` | 字段、构造、tools 一个分支、status 两个字段、start 一行 | 否。`chapters`(L442) 与 `set_start`(L446-453) 未动 |

## 三、行为证据（自动化测试）

| 断言 | 证据 |
|---|---|
| 导入书籍不推进阅读进度 | `tests/txt-acquisition-selection.test.ts` → `queues a matching book exactly once and never claims reading progress`：导入后 `entry.confirmedChars === 0`、`library.status().current === null` |
| 导入成功不产生已读回执 | 同上；另 `tests/ssm-guard.test.ts` 全绿（在 734 例全量中） |
| 不把未读内容写进阅读足迹 | 新模块不调用 journal/history 写入接口；`git diff` 中 `src/journal.ts`、`src/history.ts` 无改动 |
| 不污染 Persona Memory | 新模块只写 `data/bookfish/txt-acquisition/tasks.json` 与 `raw/`；不触碰 StoryStore/记忆相关存储 |
| 不改变 Story Index | `src/stream-index.ts`、`src/books.ts` 未改；宽松导入复用同一 `streamIndex` 与 1200 字分段 |
| 自主选书成功只建正确队列 | `queues a matching book exactly once...`：exact 身份 → `intent.status='reading'`、队列 1 条 `{source:'pet',status:'queued'}`，二次调用不重复 |
| 人工导入不改当前书 | `ignores manual imports and cancelled intents`：无 `intentId` 时不做任何事 |
| 身份不匹配不自动排队 | `holds an uncertain edition for confirmation instead of queueing it`：`awaiting_choice` + `identity_mismatch` |
| 修复版不自动切换版本 | `leaves an intent that already points at another revision alone` |
| 旧书源机制不受影响 | 737 例全量中 `world.test.ts`、`novel-*`、`source-*`、`serial-*` 全部通过 |
| 书架数据格式未变 | `LibraryState.schema` 仍为 3，未新增字段；`tests/library.test.ts`、`tests/import-migration` 相关用例全部通过 |

## 四、`npm run check:ssm` 结果

```text
blocked=0 review=7 allowed=47
```

7 个 review 文件都因**包含 SSM 共享区段**而需要 SSM 负责人确认（不是因为我改了它们的行为）：

`describe.json`、`src/ENV_PROMPT.md`、`src/config.ts`、`src/library.ts`、`src/stream-import.ts`、`src/tool-schemas.ts`、`src/world.ts`

- `src/txt-acquisition/*` 与 7 个新测试文件：**not-protected**。
- 确认命令：`npm run check:ssm -- --accept-review "已获得 <负责人> 同意：<范围与理由>"`。
- **本分支未执行 accept**：这是审核方的动作，不是实现方的动作。

## 五、明确不做的事

- 不把获取记录、质量报告、网页内容写入 Persona Memory。
- 不把自动修复后的内容标记成用户已读。
- 不为补正而推进已读进度。
- 不改变 Episode 证据要求，也不新增 Episode。
- 不让 Gold Data / Labels / Answers 参与新书入架判定。
