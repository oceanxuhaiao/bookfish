# 02 · ZIP 分片重放内存与内容身份（P1-4 / P1-6）

对应任务书：④ ZIP 分片重放内存问题；⑥ ZIP 重选内容身份。

---

## 1. 分片重放不再读整文件（P1-4）

### 问题

v1.2 的幂等重放校验是"读整个暂存文件 → `subarray` → 比较"。归档上限 512 MiB，而分片只有 256 KiB（`BATCH_CHUNK = 256 * 1024`，`src/import-batches.ts:27`）——为了验证 256 KiB 的分片，会把最多 512 MiB 读进内存。命中同一区间的大量小分片重放时，这是线性叠乘的内存炸弹。

### 实现

`src/import-batches.ts:68-80`：

```ts
export function readRange(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);   // 精确等于请求长度，不随文件增长
    let at = 0;
    while (at < length) {
      const read = readSync(fd, buffer, at, length - at, offset + at);
      if (read <= 0) break;                      // 短读 = 文件比声称的短
      at += read;
    }
    return buffer.subarray(0, at);
  } finally { closeSync(fd); }
}
```

两个使用点：

| 位置 | 用途 |
| --- | --- |
| `src/import-batches.ts:297`（`stage()`，单文件分片） | 小说分片重放比较 |
| `src/import-batches.ts:590`（`zipChunk()`，ZIP 分片） | 归档分片重放比较 |

两处都补了长度校验（旧代码只比较内容）：

```ts
const existing = readRange(file, offset as number, bytes.length);
if (existing.length !== bytes.length || !existing.equals(bytes)) throw new Error('ZIP upload replay does not match the staged data');
```

内存上界由构造保证：`Buffer.allocUnsafe(length)` 的 `length` 就是本次请求的分片长度（≤ 256 KiB），与归档大小无关。

### 验收（`tests/import-batch-bounded-read.test.ts`，6 例）

| 用例 | 断言 |
| --- | --- |
| `readRange` 任意 offset / 长度 | 与 `Buffer.subarray` 结果逐字节相等 |
| 短读 | 请求超过文件尾时返回短结果，不补零、不越界 |
| 64 MiB 稀疏文件 + 256 KiB 窗口 | 只读窗口；不触发整文件读取（用进程内存峰值与耗时双重约束） |
| **源级护栏** | `src/import-batches.ts` 原文不含 `readFileSync`、不含 `copyThenUnlink`、包含 `readRange(file,` |
| 缺失文件 | 抛错（ENOENT 不被吞） |
| 真实 chunk 路径 | 幂等重放成功；不同内容拒绝；跳跃 offset 拒绝 |

---

## 2. 重选必须证明"是同一个压缩包"（P1-6）

### 身份锚点：双锚，缺一即拒

`BatchZip` 上有两个摘要字段，语义不同：

| 字段 | 来源 | 生命周期 |
| --- | --- | --- |
| `claimedSha256` | 客户端首次 `zipBegin` 声明的摘要（前端对所选文件现算） | **粘性**：一旦记下不允许换值；`zipFinish` 拒绝时**不清除** |
| `sha256` | 服务端完整上传后对暂存文件实算的摘要 | 只有过一次完整且被接受的上传才存在 |

`BatchZipView.reselectable = !!(sha256 || claimedSha256)`（`src/import-batches.ts:214`），前端据此决定显示"重新选择"还是"请新建批次"。

### 服务端规则

| 入口 | 规则 | 代码 |
| --- | --- | --- |
| `zipBegin` | 已有 claim 且新 claim 不同 → 抛错（不接受换摘要）；`effectiveClaim = claimed ?? priorClaim`（新传不带摘要时沿用旧 claim，**不丢失**） | `src/import-batches.ts:542-555` |
| `zipFinish`（`uploading`） | 长度必须等于声明；实算摘要必须匹配 `claimedSha256`（若不匹配：`refuse()` 置 `needs_reselect` 并删半截文件，**但保留 claim**）；还必须匹配 `sha256`（若曾接受过上传） | `src/import-batches.ts:622-641` |
| `zipFinish`（`needs_reselect`） | 明确拒绝：必须先重选 | `src/import-batches.ts:619` |
| `zipReselect` | 仅 `needs_reselect` 可重开；`!sha256 && !claimedSha256` → 中文明确拒绝并提示新建批次；批次已有条目 → 拒绝；正在解压 → 拒绝 | `src/import-batches.ts:661-682` |

**错 claim 不可能被"删掉"来放行：** v1.2 的 `refuse()` 会删 claim，导致换个同长度文件重传就能洗白。v1.3 反转为"拒绝时保留 claim"——错误证明反而变成更严格的约束。

无锚点的老批次（v1.2 中断上传、从未完整传完、前端也没声明摘要）没有可信身份，`zipReselect` 给出明确中文错误：

> 此批次的中断上传没有可验证的内容指纹，无法证明重新选择的仍是同一个压缩包。请新建一个批次重新导入；本条记录保留为未完成状态，可随时清理。

### 前端：首传即锚定，且不整读大文件

`src/webui/sha256.ts`（新增，115 行）是纯 JS 增量 SHA-256：

```ts
export class Sha256 { update(bytes: Uint8Array): this; digest(): string }
export async function fileSha256Hex(file: File, sliceBytes = 1024 * 1024): Promise<string | null>
```

`fileSha256Hex` 按 1 MiB 切片逐片喂入，**永不 `arrayBuffer()` 整读**；任一切片读取失败返回 `null`（宁可没有 claim，也不给假 claim）。

`src/webui/batch-import.ts`：

| 位置 | 逻辑 |
| --- | --- |
| `fileDigest()`（167-184） | ≤ 64 MiB 走 `crypto.subtle.digest`（失败则 fall through 到增量实现）；其余全部走 `fileSha256Hex`。**所有尺寸都能拿到摘要**，不存在"大文件没有 claim"的空档 |
| `uploadZip()`（187-207） | 上传前先算摘要；`digest && expected && digest !== expected` → 前端就拒绝（"选择的不是原来的那个压缩包（内容指纹不一致）…"），不发无用分片；`zipBegin` 携带 `sha256: digest`；finish 后清空 `expectedZipSha256` |
| `reselect` 点击（322-328） | 从 `import_batch_zip_reselect` 取回服务端锚点摘要写入 `expectedZipSha256`，再打开文件选择器 |
| 重新选择入口（315-330） | `reselectable === false` 时不显示按钮，改为警告文案 + 引导新建批次 |

### 验收（`tests/import-batch-zip-claim.test.ts` 3 例 + `tests/webui-sha256.test.ts` 7 例 + `tests/import-batch-identity.test.ts` 改造）

| 用例 | 断言 |
| --- | --- |
| 错 claim 拒绝且保留 | `zipFinish` 抛摘要不一致；记录里 `claimedSha256` 仍在；`state = needs_reselect` |
| 重传同错内容仍拒绝 | 第二次同样内容仍然被拒（claim 没被洗掉） |
| claim 描述的正确文件重传被接受 | 摘要一致 → 正常解压 |
| 不允许 re-begin 换 claim | 第二次 `zipBegin` 带不同 claim → 抛错 |
| `webui-sha256` 标准向量 | 空串 / `"abc"` 与 Node `crypto` 一致；长度 0..4096 全对；任意分片喂入一致；`File` 切片哈希一致；读取失败返回 `null` |
| identity 用例改造 | 同长度不同内容 → 服务端拒绝；无可验证指纹的中断上传 → 拒绝重选且 `reselectable === false` |
