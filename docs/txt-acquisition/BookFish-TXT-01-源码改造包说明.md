# BookFish TXT 获取模块 · 01 源码改造包说明

- 仓库：`D:\学习\项目\bookfish`
- 分支：`feature/txt-acquisition`（从 `origin/main` = `c440c03` 切出；`c440c03` 即 0.63.0 发布提交）
- 基线证明：`git worktree add _base063 origin/main --detach` 后逐文件比对，用户提供的 `看书吧大肥鱼-0.63.0.zip` 的 `src/`、`tests/` 与 `origin/main` **完全一致**（`package.json`、`describe.json`、`tsconfig.json`、`vitest.config.ts`、`CHANGELOG.md` 哈希相同）。
- 未使用 0.62.1 补丁覆盖任何文件；未运行群友 `install.ps1`。

## 一、新增模块 `src/txt-acquisition/`（11 文件，2042 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `types.ts` | 209 | 状态机、候选/文件/质量/失败记录类型、持久化校验 `validateAcquisitionState`、失败码可恢复表 |
| `url-policy.ts` | 142 | `checkUrl`（协议/凭据/IP 段/DNS 解析）、`isBlockedAddress`、`isLoopbackWs` |
| `browser-client.ts` | 212 | 仅连 `127.0.0.1:<配置端口>` 的 CDP 客户端；`createPage` 只建自建页，绝不接管已有页 |
| `link-discovery.ts` | 85 | `discoverLinks`（cheerio 提取 TXT/MD 链接，去重、限 40 条、报告截断）、`extractIdentity` |
| `download.ts` | 169 | 逐跳复检的原始字节流式下载；大小/超时/取消/Content-Type 校验 |
| `quality.ts` | 179 | `assessText` 三档判定（拒绝/警告/补正），产出结构化质量报告 |
| `repair.ts` | 183 | 编码识别（BOM/pair-NUL/可信度打分）、宽松解码、换行与控制字符规范化、`looksBinary` |
| `records.ts` | 104 | `tasks.json` 原子持久化、历史截断、终态淘汰 |
| `staging.ts` | 141 | `data/bookfish/txt-acquisition/` 下的原件（`raw/`）与工作文件（`work/`）管理、防目录穿越、配额清理 |
| `acquisition.ts` | 607 | 编排：discover → download → validate → repair → import；retry/repair/cancel/prune |
| `index.ts` | 11 | 公共导出面 |

## 二、对既有文件的改动（全部为增量）

| 文件 | 改动 |
|---|---|
| `src/stream-import.ts` | **严格入口 `canonicalize` / `importFileBlob` 一字未改**；新增 `BestEffortRejected`、`decodeFileBestEffort`、`importFileBlobBestEffort` |
| `src/book-storage.ts` | 新增 `importFileBestEffort(file, metadata, decoded?)`，复用同一 `BookStorage.dir`、`loadPagedBook`、`collect` |
| `src/library.ts` | 新增 `importFileBestEffort(metadata, file, options)`，内部仍走 `private addBook`（同 `bookKey` 判定重复、版本共存逻辑不变） |
| `src/config.ts` | 新增 `txtAcquisitionEnabled=false`、`browserDebugPort=0`、`txtAcquisitionRetentionMb=512`，三项进 advanced；`validateSettings` 增加端口范围校验 |
| `src/selection.ts` | 新增 `onExternalImport(task, identity)`；`fulfill` / `recordFailure` / `announce` / 队列逻辑全部复用未改 |
| `src/world.ts` | 构造 `TxtAcquisition`；`tools()` 增加 `bookfish_import_txt`；`status()` 增加 `txtAcquisition`；`modelStatus()` 增加精简 `txtFiles`；`start()` 内初始化（失败不阻塞阅读） |
| `src/tool-schemas.ts` | 新增 1 条工具声明（7 参数、6 个 action） |
| `src/definition.ts` | 新增工具中英文摘要 |
| `src/ENV_PROMPT.md` | 末尾追加一段获取流程指引（纯 LF） |
| `src/status.ts` | `BookfishStatus` 增加 `txtAcquisition` 字段类型 |
| `describe.json` | 重新生成，diff 仅「新增 1 工具 + envPrompt 追加段」 |
| `tests/context-budget.test.ts` | 工具数 15→16、schema 上限 13 000→13 400、提示词 band 600→800（理由见 `docs/prompt-refactor/2026-11-txt-acquisition.md`） |
| `lib/{webui.js,import-worker.mjs,zip-worker.mjs}` | 由 `npm run build:webui` / `scripts/build-worker.mjs` 重建的产物 |

`src/world.ts` 的 `webUi().invoke` 中 `chapters`（L442）与 `set_start`（L446-453）分支在本次 diff 中**未被触碰**。

## 三、关键签名

```ts
// src/stream-import.ts
export class BestEffortRejected extends Error { readonly code: string }
export function decodeFileBestEffort(file: string, chunkBytes = 16 * 1024, progress?: Progress): Promise<BestEffortDecoded>
export function importFileBlobBestEffort(dir: string, file: string, metadata: { filename: string; title: string; author?: string }, chunkBytes = 16 * 1024, progress?: Progress, decoded?: BestEffortDecoded): Promise<{ id: string; decoded: BestEffortDecoded }>

// src/library.ts
importFileBestEffort(metadata: { filename: string; title: string; author?: string }, file: string, options?: { wanted?: { title: string; author?: string }; declared?: { title?: string; author?: string }; decoded?: BestEffortDecoded }): Promise<{ imported: true; duplicate: boolean; book: BookView; quality: QualityLevel; readableChars: number; identity: 'exact' | 'partial' | 'unknown'; repairs: string[] }>

// src/selection.ts
onExternalImport(task: { id: string; intentId?: string; bookKey?: string }, identity: 'exact' | 'partial' | 'unknown'): void

// src/txt-acquisition/url-policy.ts
export async function checkUrl(raw: string, options: { allowNetwork: boolean; resolve?: HostResolver }): Promise<URL>
export function isBlockedAddress(address: string): boolean
export function isLoopbackWs(raw: string, port: number): boolean
```

## 四、构建产物说明

`lib/webui.js`、`lib/import-worker.mjs`、`lib/zip-worker.mjs` 是构建脚本输出（`scripts/build-webui.mjs`、`scripts/build-worker.mjs`），diff 表现为打包符号重命名（`writeFileSync2`、`detectEncoding2`）与新模块并入，属正常构建结果，随源码一起提交。
