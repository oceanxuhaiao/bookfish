# BookFish TXT 获取模块 · 05 补正机制报告

核心结论：**失败不再等于数据丢失**。下载失败、导入失败、文件被拒，三种情况都保留任务记录与（已下载的）原始字节，并且可以在同一任务上再次处理。

## 一、状态机

```text
queued → discovering → candidate_ready → downloading → validating
                                                    ↓
                                             needs_repair → repairing
                                                    ↓
                                                 importing
                                                    ↓
        completed │ completed_with_warning │ failed_recoverable │ failed_terminal
```

- 合法转移表在 `src/txt-acquisition/types.ts` 的 `TRANSITIONS`，任何非法转移由 `assertTransition` 抛错（测试会碰到这条，例如早期 `completed_with_warning → validating` 缺失导致 repair 抛 `Invalid acquisition transition`）。
- `failed_terminal` 允许转 `validating`/`downloading`/`discovering`：**终态失败仍保留字节**，重试是显式用户决定，不是自动重试。
- 失败码分可恢复 / 不可恢复（`FAILURE_RECOVERABLE`）。`network`、`timeout`、`download_failed`、`http_error`、`import_failed`、`unreadable_text`、`encoding_damaged`、`cancelled`、`restart_interrupted`、`storage_unavailable`、`candidate_expired` 可恢复；`browser_unavailable`、`policy_blocked`、`too_large`、`empty_file`、`binary_file`、`not_a_book`、`network_disabled`、`disabled`、`library_full`、`invalid_input` 不可恢复（但仍保留记录与原件）。

## 二、原始字节保留策略

| 情形 | 原件（`data/bookfish/txt-acquisition/raw/<sha256>.<txt|md>`） |
|---|---|
| 成功且无警告、无补正 | 导入确认后删除（`file.retained=false`） |
| 有警告 / 有补正 / `partial` | **保留**（`retained=true`） |
| 导入失败 / 被拒 | **保留** |
| 取消 | 保留已下完的原件；删除 `.part` |
| 重启中断 | 保留，任务转 `failed_recoverable`/`restart_interrupted` |

- 容量：`txtAcquisitionRetentionMb`（默认 512，范围 64–10240）。
- 清理：`prune()` 只在**没有活动任务**时执行，只删**没有被任何任务引用**的原件，按修改时间从旧到新，直到低于上限（测试：`keeps the original bytes when the copy has warnings, and still lets it be read` 断言 `prune()` 返回 `[]`）。
- 清理前有 `records.hasActive()` 守卫与 `staging.enforceQuota(limit, referenced)` 的引用集合。
- 原件不混入正式书籍全文目录（`BookStorage.dir`），位于独立的 `txt-acquisition/` 子树。

## 三、重新尝试的三条路径

1. **有保留原件**：`retry` 直接重新解码 → 重新导入，不再下载。
2. **只有候选地址仍在内存**（未过期）：`retry` 用同一地址重下，**不新建任务**。
3. **只剩资源页**（如重启后）：`retry` 在同一任务上 `runDiscovery` 重扫页面，**不新建任务**；都没有才提示重新 discover。

> 这三条是本次为满足「不得重复创建大量无意义任务」而修正的：早期 `retry` 在无原件时调用 `discover()`，会静默新建第二个任务。

## 四、补正（repair）语义

`repair(taskId, encoding?)`：

- 强制编码时只用该编码；否则依次尝试 `[检测到的, utf-8, gb18030, utf-16le, utf-16be]`，取**替换字符最少**者，遇到 0 替换即停止。
- 结果作为**新 revision** 导入：`bookKey = sha256(标题+作者) + ':' + sha256(parserVersion + 文本)` 由现有机制计算，旧版本与其阅读进度**不动**，切换由现有版本机制与用户选择决定。
- 允许从 `failed_recoverable`、`failed_terminal`、`completed_with_warning`、`needs_repair` 进入（`validating`）。
- 被拒时（例如换编码后仍是登录页）不抛异常给工具调用，而是记录 `rejection` 并把任务置为失败、保留原件，返回结构化状态。

## 五、R01–R08 覆盖

| 编号 | 场景 | 证据 |
|---|---|---|
| R01 | 第一次导入失败保留原件 | `keeps the original bytes when the file is not a book, so it can be retried later` |
| R02 | 重新执行编码修复能再次尝试 | `repairs a damaged file into a new revision without touching the first one` |
| R03 | 修复成功，新版本进入书架 | 同上（书架数量 +1，`repaired !== first`） |
| R04 | 修复前版本不被覆盖 | 同上（旧版本 `confirmedChars` 仍为 0，旧 key 仍在书架） |
| R05 | 新版本不错误继承旧进度 | 同上（进度仍停留在 0） |
| R06 | 重复补正不产生重复书籍 | `does not import the same file twice as two books`（同一文件两次导入 → 同 `bookKey`、`duplicate=true`、书架 1 本） |
| R07 | 重启后恢复历史任务与文件 | `marks interrupted work recoverable after a restart and keeps the page for rediscovery` |
| R08 | 补正失败后原件仍可再次处理 | `keeps the original bytes when the file is not a book, so it can be retried later`（重试后 raw 仍为 1 个、任务仍为 1 个） |

另有：`retries a recoverable download failure without duplicating the task`（下载失败→同任务重试成功，`attempts.downloads===2`、任务数不变）、`cancels a pending task, keeps it recoverable and leaves no partial file`（取消后 `work/` 无 `.part`）。

## 六、任务记录内容

`tasks.json`（原子写：临时文件 + rename）保存：任务 ID、创建/更新时间、状态、来源（manual/autonomous）、关联 intentId、目标书名作者、资源页 URL、来源域名、候选（`urlHash` 而非 URL）、选中候选、文件（sha256、字节数、文件名、是否保留、Content-Type）、质量报告、`bookKey`、重复标记、拒绝原因、失败记录、尝试计数（下载/导入/补正）、历史（最多 60 条）。

**不保存**：候选与下载地址原文（只存 `sha256(url)`）、Cookie、Authorization、密码、带签名的完整 URL。

## 七、边界说明

- 补正只做「不改变正文含义」的操作：BOM、编码、换行、少量坏字节、末尾残字、控制字符、重复空白行。
- 大范围删除广告/重复章节/段落**不自动执行**，只记警告（`ad_lines`、`duplicate_chapters`）。
- 补正不推进已读进度、不生成阅读回执、不写 Persona Memory。
