# 03 · ZIP 完整性及磁盘峰值报告

本报告是任务书第 2 / 3 节与交付要求第 3 项的集中技术说明。代码位置：`src/import-batch.ts`（`BatchZip` / `digestOf` / `validateBatches`）、`src/import-batches.ts`（`sha256File` / `zipBegin` / `zipChunk` / `zipFinish` / `zipReselect` / `importZip` / `batchDirBytes` / `extractCeiling` / `resume`）、`src/world.ts`（分发入口）、`src/webui/batch-import.ts` + `batch-types.ts`（状态展示）。

---

## 1. 落盘数据结构

```ts
interface BatchZip {
  name: string;                 // 原始 ZIP 文件名
  size: number;                 // 声明大小，上传不得超过
  sha256?: string;              // 服务端在完整上传后计算的身份摘要
  claimedSha256?: string;       // 客户端声明的期望值，仅用于比对，永不信任
  state: 'uploading' | 'needs_reselect' | 'ready' | 'extracted';
  peakBytes?: number;           // 实测的批次目录峰值（含 ZIP 与解压树）
}
```

`ImportBatch.zip?: BatchZip` 只在 `source === 'zip'` 时存在。`validateBatches()` 对 `name / size / state / sha256 / claimedSha256 / peakBytes` 全部做 fail-closed 校验：摘要必须是小写 64 位 hex，大小必须在 1 byte–512 MiB，状态必须在四态枚举内。

`status(batchId)` 返回 `BatchZipView`（`name / size / state / sha256? / peakBytes?`），面板据此显示状态与峰值，不把内部字段整体暴露。

## 2. 上传完整性规则

| 环节 | 规则 | 违反后果 |
| --- | --- | --- |
| `zipBegin` | 只接受 `.zip`、名称 ≤260、`1 ≤ size ≤ 512 MiB`、批次为 `preview`；重开时保留上次已接受的 `sha256` 与声明 size | 抛错，不建文件 |
| `zipChunk` | `state === 'uploading'`；offset 非负整数；`offset + len ≤ 声明 size`；`offset > written` 判跳片；`offset < written` 时重叠部分必须逐字节一致，否则拒绝；base64 必须能严格回编码 | 抛错，不写盘 |
| `zipFinish` | `statSync().size === 声明 size`；服务端 `sha256File()` 全量哈希；与 `claimedSha256`、与已接受的 `sha256` 逐一比对 | 删除半截文件、置 `needs_reselect`、清除错误 claim、抛错 |
| 解压前 | `extractCeiling(zipSize)` 作为 `maxTotalBytes` 传给解压 worker；单条目 ≤100 MiB；条目数 ≤400 | 解压 worker 拒绝 |

`sha256File()` 使用 256 KiB 固定缓冲区 + `readSync` 循环，内存占用与文件大小无关。

**分片 append-only** 与普通书籍分片共用同一套语义：跳片、不一致重叠、改后重放全部拒绝；重复分片仅字节一致时幂等（`replayed: true`）。

## 3. 四态状态机与恢复矩阵

```
                 zipBegin
   (none) ──────────────────► uploading
                                  │ zipFinish 校验失败（长度 / 摘要）
                                  ▼
        zipReselect          needs_reselect ◄──── resume(): 半截 uploading
        (同 batchId)              │                      │
              ▲                   │                      │ 已有 sha256？
              └───────────────────┘                      ▼
                          zipBegin（保留 size/sha256）  拒绝不同内容
                 uploading ──zipFinish 通过──► ready ──importZip 成功──► extracted
                                                  │
                                                  └── 解压失败 / 重启 resume ──► 保留 ZIP 重试或 needs_reselect
```

| 重启时观察到的状态 | `resume()` 行为 | 用户入口 |
| --- | --- | --- |
| `uploading`（半截） | 删半截文件、置 `needs_reselect`、`archives += 1` | 面板"重新选择 ZIP" → `zipReselect` → 同 batchId 重传 |
| `ready` 且 ZIP 文件在 | 直接重试 `importZip()`、`archives += 1` | 无需操作；失败再转 `needs_reselect` |
| `needs_reselect` | 不动 | 面板重新选择入口；或取消旧批次 |
| `extracted` | 不动（ZIP 已删，条目已就位） | 正常派发 `ImportJob` |
| 无 `zip` 元数据的旧批次 | 按普通文件批次处理 | 无 ZIP 入口，不假装可恢复 |

`zipReselect()` 拒绝：批次已开始、条目已存在、状态已 `extracted`。这些情况明确提示"新建批次"，避免把不同书塞进旧批次历史；`batchSummary()` 对空条目批次用 `zip.name` 命名，保证历史里仍能识别并取消。

## 4. 磁盘峰值：核算、实测、清理顺序

### 4.1 为什么旧实现可能到 ~2.5 GiB

ZIP 原件（≤512 MiB）+ 解压临时目录（≤1 GiB）+ 把解压文件**复制**成 `.src` 暂存（再 ≤1 GiB）三者同时存在。旧代码只约束"声明的书籍文件总量 1 GiB"，没有约束共存占用，也没有实测。

### 4.2 本轮的三道闸门

1. **配置闸门**：`workspaceBytes = zipBytes + batchBytes = 1536 MiB`；构造函数拒绝 `workspaceBytes < zipBytes + batchBytes`。
2. **解压前闸门**：`extractCeiling(zipSize) = max(0, min(batchBytes, workspaceBytes - zipSize))`，传给解压 worker 的 `maxTotalBytes`；ZIP 越大，解压树可用空间越小。
3. **解压后实测闸门**：`batchDirBytes()` 递归统计该 `batchId` 目录（含 ZIP、解压树子目录、临时文件），`peak > workspaceBytes` 立即抛错；实测值写入 `zip.peakBytes = max(历史, 当前)`。

### 4.3 消除第三份副本

`importZip()` 用 `renameSync(from, to)` 把解压树里的文件**移动**成 `.src` 暂存文件（同目录树、同文件系统，元数据操作）。搬完逐条复核长度，全部条目就位后才：

```
rmSync(target, recursive)        // 删解压目录
若所有条目已 staged/completed/不支持 → rmSync(zipPath) + state = 'extracted'
```

**清理顺序的硬规则**：ZIP 只在"解压结果完整且恢复所需条件已满足"之后删除。失败路径 `catch` 里删解压树但**保留已校验的 ZIP**，重启可无感重试；`zip.state !== 'ready'` 的残留 ZIP 才在目录清理时被移除。

### 4.4 逐阶段峰值（`tests/import-batch-zip-peak.test.ts` 用小预算实测）

| 阶段 | 盘上内容 | 相对 workspace 的位置 |
| --- | --- | --- |
| 上传完成 | `source.zip` | = 声明 size |
| 解压完成（**实测点**） | `source.zip` + 完整解压树 | ≤ `size + extractCeiling ≤ workspaceBytes` |
| 逐个 rename 搬入 | ZIP + 逐渐缩小的解压树 + `.src` | 单调不增（无副本） |
| 成功收尾 | 仅 `.src` 暂存文件 | ≤ `batchBytes` |
| 失败 | 仅 `source.zip`（解压树已清） | 可在重启后重试 |

用例 `reports each stage and never lets a third copy exist` 逐阶段断言目录字节数；`keeps the archive (and no partial tree) when extraction is refused`、`does not leave a partial tree behind when the archive is invalid`、`can retry the extraction from the stored archive after a restart` 覆盖失败与恢复；`refuses a workspace smaller than its own parts` 覆盖预算不足。

### 4.5 清理不越界

所有 `rmSync` 的目标都是 `this.batchDir(batchId)` 下的 `source.zip` 或 `*.extract/`，从不扫描其他批次目录或用户书架。`trimBatches()` 只删批次记录，不删书。

## 5. 预算口径判定（最坏情况与是否请求批准）

| 上限 | v1.1 | v1.2 | 结论 |
| --- | --- | --- | --- |
| 单文件 / 单批条目 / 并发 | 100 MiB / 100 / 2 | 同左 | 未变 |
| 单批 staging | 1 GiB | 1 GiB | 未变 |
| ZIP | 512 MiB | 512 MiB | 未变 |
| 真实工作集 | 未封顶（潜在 ~2.5 GiB） | 显式 ≤1536 MiB | **收紧，非放大** |

最坏情况：`512 MiB ZIP + 1 GiB 解压树 = 1536 MiB`，且该值在写入前就被 `extractCeiling` 与 `batchDirBytes` 双重拒绝机制约束。没有引入新常量、没有提高任何已发布上限、没有请求更高预算。按任务书 2.2 第 3 条与第 11 节，本轮判定为"不需要请求批准预算变化"，但该口径本身列为 00 文档的两个待确认点之一。

**已知例外（如实披露）**：仅当文件系统拒绝 rename 时，`copyThenUnlink` 回退会让单个条目（≤100 MiB）瞬时多一份且源随即删除；`peakBytes` 实测点在 rename 之前，不含这一瞬时字节。正常同盘路径不触发；测试已断言不存在第三份完整副本。若审核要求把回退路径也纳入严格封顶，需另开一轮改动。

## 6. 验收条件对照（任务书第 12 节第 2/3/4 条）

| 门槛 | 判定 | 依据 |
| --- | --- | --- |
| ZIP 上传有严格的长度和内容校验 | ✅ | `zipBegin/zipChunk/zipFinish` 三层；`import-batch-identity` 5 个 ZIP 用例 + `import-batch-chunks` 2 例 |
| ZIP 峰值磁盘占用有真实上限 | ✅ | `workspaceBytes` + `extractCeiling` + `batchDirBytes` 实测；`import-batch-zip-peak` 5 例 |
| ZIP 中断后有明确恢复路径 | ✅ | 四态状态机 + `resume()` / `zipReselect()` + 面板状态展示 |
