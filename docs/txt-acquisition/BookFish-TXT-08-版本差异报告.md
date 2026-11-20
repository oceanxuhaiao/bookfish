# BookFish TXT 获取模块 · 08 版本差异报告

基线：`origin/main` = `c440c03`（0.63.0 发布）。分支：`feature/txt-acquisition`。
`git diff --stat`（相对 origin/main，不含新增文件）：

```text
 describe.json                |  61 ++++++++++++++++++++++++-
 lib/import-worker.mjs        |  15 +++---
 lib/webui.js                 |   5 +-
 lib/zip-worker.mjs           |  16 +++----
 src/ENV_PROMPT.md            |   2 +
 src/book-storage.ts          |   9 +++-
 src/config.ts                |  27 ++++++++++-
 src/definition.ts            |   1 +
 src/library.ts               |  43 ++++++++++++++++++
 src/selection.ts             |  50 +++++++++++++++++++-
 src/status.ts                |   1 +
 src/stream-import.ts         | 106 ++++++++++++++++++++++++++++++++++++++++++-
 src/tool-schemas.ts          |   5 ++
 src/world.ts                 |  47 +++++++++++++++++++
 tests/context-budget.test.ts |  11 +++--
 15 files changed, 374 insertions(+), 25 deletions(-)
```

## 一、修改文件逐项

| 文件 | +/− | 变更内容 |
|---|---|---|
| `describe.json` | 60/1 | 新增 `bookfish_import_txt` 工具条目；`envPrompt` 追加一段。`bookfish_lookup` 描述已还原为 0.63.0 原文，避免无关 diff |
| `src/ENV_PROMPT.md` | 2/0 | 追加获取流程指引（纯 LF，无 CRLF） |
| `src/stream-import.ts` | 105/1 | 新增 `BestEffortRejected`、`decodeFileBestEffort`、`importFileBlobBestEffort`；严格路径未改 |
| `src/library.ts` | 43/0 | 新增 `importFileBestEffort` |
| `src/book-storage.ts` | 8/1 | 新增 `importFileBestEffort`；import 行扩展 |
| `src/config.ts` | 25/2 | 三个新字段 + 默认值 + schema + advanced 列表 + 端口校验 |
| `src/selection.ts` | 49/1 | 新增 `onExternalImport` |
| `src/world.ts` | 47/0 | 字段、构造、`tools()` 分支、`status()`/`modelStatus()`、`start()` 初始化 |
| `src/tool-schemas.ts` | 5/0 | 一条工具声明 |
| `src/definition.ts` | 1/0 | 一条中英文摘要 |
| `src/status.ts` | 1/0 | 类型字段 |
| `tests/context-budget.test.ts` | 7/4 | 上限调整（工具 16、schema 13 400、prompt 800） |
| `lib/import-worker.mjs` | 9/6 | 构建产物（打包符号重命名 + 新模块并入） |
| `lib/zip-worker.mjs` | 8/8 | 同上 |
| `lib/webui.js` | 4/1 | 同上 |

## 二、新增文件

| 文件 | 行数 |
|---|---|
| `src/txt-acquisition/types.ts` | 211 |
| `src/txt-acquisition/url-policy.ts` | 142 |
| `src/txt-acquisition/browser-client.ts` | 212 |
| `src/txt-acquisition/link-discovery.ts` | 85 |
| `src/txt-acquisition/download.ts` | 169 |
| `src/txt-acquisition/quality.ts` | 179 |
| `src/txt-acquisition/repair.ts` | 183 |
| `src/txt-acquisition/records.ts` | 104 |
| `src/txt-acquisition/staging.ts` | 141 |
| `src/txt-acquisition/acquisition.ts` | 622 |
| `src/txt-acquisition/index.ts` | 11 |
| **小计** | **2059** |

| 测试文件 | 例数 |
|---|---|
| `tests/txt-acquisition-url.test.ts` | 11 |
| `tests/txt-acquisition-browser.test.ts` | 11 |
| `tests/txt-acquisition-download.test.ts` | 9 |
| `tests/txt-acquisition-import.test.ts` | 19 |
| `tests/txt-acquisition-flow.test.ts` | 11 |
| `tests/txt-acquisition-selection.test.ts` | 5 |
| `tests/txt-acquisition-tool.test.ts` | 4 |

另有文档 `docs/prompt-refactor/2026-11-txt-acquisition.md`（预算调整理由）。

## 三、契约面变化（describe.json）

| 项 | 0.63.0 | 本分支 |
|---|---|---|
| tools | 15 | 16（+`bookfish_import_txt`） |
| events | 10 | 10（不变） |
| prompts | 1 | 1（内容追加一段） |
| `cortico.api` | 6 | 6（不变） |
| package 版本 | 0.63.0 | 0.63.0（未提升，属开发分支；发布时按发版流程决定 0.64.0） |

## 四、零改动确认

- `src/world.ts` 的 `chapters`（L442）、`set_start`（L446-453）面板分支：diff 中零改动。
- `src/stream-import.ts` 的 `canonicalize`、`importFileBlob`、`detectEncoding`、`repairBudget`：零改动。
- `src/books.ts`、`src/stream-index.ts`、`src/paged-book.ts`、`src/novel-*.ts`、`src/scheduler.ts`、`src/reviews.ts`、`src/sharing.ts`、`src/serial-*.ts`、`src/history.ts`、`src/journal.ts`：均无改动。
- `package.json`、`tsconfig*.json`、`vitest.config.ts`：无改动（无新增依赖）。

## 五、未纳入提交的目录

- `_verify/`：命令输出日志，供审核复核，属临时证据目录。
- `output/`：构建/运行时产物目录，工作区原本即未跟踪。
