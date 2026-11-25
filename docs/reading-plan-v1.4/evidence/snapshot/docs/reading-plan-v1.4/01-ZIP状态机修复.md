# 01 · ZIP 状态机修复（P1-1）

对应任务书第 1 节：`resume()` 不能把临时解压失败当成原始 ZIP 失效。

---

## 1. v1.3 的问题

```ts
// v1.3
chain = chain.then(() => this.importZip(id, path)).then(
  () => undefined,
  () => { /* 一律 */ draft.zip.state = 'needs_reselect'; },
);
```

任何异常——磁盘满、rename 被拒、权限不足、worker 崩、文件系统抽风——都被压成同一个结论："请重新上传压缩包"。而 `zipReselect()` 当时还要求 `batch.items.length === 0`，于是**已经导入一半的批次既不能重试、也不能重选**，只能新建批次从头再来（重新上传最多 512 MiB）。

## 2. 现在的分类

新增持久化字段 `zip.failure`（`src/import-batch.ts`）：

```ts
export type ZipFailure = 'missing' | 'unverifiable' | 'over_limit' | 'disk' | 'transient';
```

| 情形 | `state` | `failure` | 恢复路径 |
| --- | --- | --- | --- |
| 上传未完成（重启） | `needs_reselect` | — | 重选同一归档（见 `03`） |
| 文件缺失 / 长度不符 | `ready` | `missing` | 重选原归档；已入库书不受影响 |
| 摘要不匹配（被替换/损坏） | `ready` | `unverifiable` | 重选原归档；保留现场 |
| 解压后超出批次预算 / 100 本 | `ready` | `over_limit` | 拆分后重新导入；ZIP 保留 |
| 磁盘不足 / 无法测量 | `ready` | `disk` | 释放空间后**直接重试解压** |
| rename 拒绝 / 权限 / worker | `ready` | `transient` | **直接重试解压** |
| 成功 | `extracted` | 清除 | — |

核心不变式：**`ready` 只在"字节仍然可用"或"现场需要保留"时出现，且它永远允许一次 ZIP 级重试**；`needs_reselect` 只用于"上传从未完成"与"归档本身已不是当初那份且需要用户重新选择"。

实现要点（`src/import-batches.ts`）：

- `fail(batchId, failure, message)`（`:704`）：写入 `failure` + `error`（≤500 字），**不动 `state`**，返回 `ZipStateError` 供调用方抛出。所有失败路径都经过它。
- `resume()`（`:984`）：只跳过 `missing` / `unverifiable` / `over_limit`（重启不可能自行修好，重复哈希 512 MiB 只是浪费）；`disk` / `transient` 与"无 failure"正常进入串行链。链上的异常**不再改写状态**——失败已在 `fail()` 里记录。
- 恢复链仍然串行：后一个 `importZip` 只在前一个 settle 之后开始，重启不会叠加峰值。

## 3. 重试如何不重复导入

`extractArchive()` 的搬移循环遍历批次 `items` 而不是本次新增的 rows，并跳过 `item.staged`：

```ts
for (const item of this.require(batchId).items) {
  if (item.staged) continue;
  ...
  try { renameSync(from, to); } catch { throw ... }
}
```

重试时 `addItems` 会把同一批名字全部判为重复（`added` 为空），但搬移仍然按 `items` 进行——上一轮没搬完的条目这次拿到 `.src`，已搬完的原样跳过。实测见 `tests/import-batch-rename-retry.test.ts` 的"部分失败 + 重启 + 再解压"与 v1.4 新增的 resume 用例。

## 4. 验收（任务书第 1 节的 9 步）

| 步骤 | 断言 | 用例 |
| --- | --- | --- |
| 1–2 第一本成功、第二本 rename 失败 | 抛出"文件系统或权限问题"，`.extract` 已清理 | `a partial extraction failure retries within the same budget` |
| 3 宿主重启 | 重新 `open()` + `resume()`，`report.archives = 1` | `resume() keeps a transient failure at ready` |
| 4 再次制造 rename 失败 | 仍然失败，但状态**仍是 `ready`**，`failure = 'transient'` | 同上 |
| 5 ZIP 仍完整 | `source.zip` 字节数不变 | 同上 |
| 6 已暂存书仍存在 | `.src` 与 `item.staged` 不变 | 同上 + 部分失败用例 |
| 7 状态仍允许 ZIP 级重试 | `state === 'ready'`，且 `zipReselect` 不是唯一出路 | 同上 |
| 8 移除故障后再重试 | `zipFinish` 直接成功，无需重新上传 | `keeps the archive ... recovers on retry` |
| 9 最终正确暂存且无重复 | `items` 数量不变，每个 `items` 恰一份 `.src` | 同上 |

磁盘不足的恢复路径：`refuses up front when the filesystem cannot hold the estimate` 断言 `failure = 'disk'`、`state = 'ready'`、ZIP 保留、无 `.extract`；释放空间后同一批次直接 `zipFinish` 成功（`proceeds when the disk has room for the estimate`）。

## 5. 数据兼容

`failure` / `error` 都是可选字段，旧记录读入时视为"健康"。**没有新增 `state` 取值**，`validateBatches` 只增加两个字段校验（非法值拒绝加载，不会静默丢弃）。schema 版本未变，无迁移脚本。
