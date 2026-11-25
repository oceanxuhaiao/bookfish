# 02 · ZIP 内容身份（P1-2）与 begin 覆盖（P1-3）

对应任务书第 2、3 节。

---

## 一、每次实际解压前重新校验身份（P1-2）

### 问题

v1.3 只在 `zip.state === 'uploading'` 时算 SHA-256；`ready` 直接解压，只比较文件大小。磁盘上的归档被同长度内容替换后，系统会把它当成已验证归档解压——内容身份实际上只存在于"上传那一刻"。

### 实现（`src/import-batches.ts` 的 `extractArchive`）

顺序固定，任何一步失败都**不创建解压目录**：

```ts
if (!existsSync(zipPath))                      throw this.fail(batchId, 'missing', ...);
const zipSize = statSync(zipPath).size;
if (zipSize !== persisted.size)                throw this.fail(batchId, 'missing', ...);
const pinned = persisted.sha256 ?? persisted.claimedSha256;
if (!pinned)                                   throw this.fail(batchId, 'unverifiable', ...);
if (sha256File(zipPath) !== pinned)            throw this.fail(batchId, 'unverifiable', ...);
```

| 检查 | 语义 |
| --- | --- |
| 存在性 | 归档不在 → `missing`，不算"要重传"的默认结论 |
| 长度 | 与持久化 `size` 不符 → `missing`（被截断或替换） |
| 摘要来源 | **首选服务端 `sha256`**；没有时退回首选的 `claimedSha256`（用户第一次选择时固化的身份）；两者都无 → 拒绝 |
| 摘要计算 | `sha256File()` 256 KiB 流式，内存与归档大小无关 |
| 不匹配 | 拒绝，`failure = 'unverifiable'`，**文件原样保留**，未创建 `.extract`、未调用 worker |

**保守兼容策略**：旧 `ready` 记录没有服务端摘要时，用 `claimedSha256` 兜底（它是首次选择时由客户端对用户所选文件算出、并被服务端用于校验上传的摘要）；连 claim 都没有的记录**直接拒绝**，并在错误里说明"无法证明磁盘上的文件仍是当初那一个"。宁可不导入，也不冒充已验证。

### 为什么不是"验证一次就够"

`ready` 是一个跨重启、跨天、跨用户手动改文件的状态。只有每次进入解压前重算，才能保证"交给 worker 的字节"和"当初接受的字节"是同一份。

### 验收（`tests/import-batch-zip-state.test.ts`）

| 用例 | 断言 |
| --- | --- |
| 原始 ZIP 正常重试 | 解压成功、2 本入库 |
| 同长度不同内容替换 | 抛"内容与已验证的摘要不一致"；`failure = 'unverifiable'`；**0 条目、无暂存文件**；ZIP 保留 |
| 截断 | 抛"长度与声明不一致"；`failure = 'missing'`；0 条目 |
| 无服务端摘要的历史 ready | 抛"没有可验证的压缩包摘要"；`failure = 'unverifiable'` |
| 已暂存书不受影响 | 已 `extracted` 的批次再 `zipFinish` 返回 `alreadyExtracted`，条目仍 2 本且全部 staged |
| 验证后字节变化（重启后） | 同上"同长度替换"路径（替换发生在 ready 之后） |

---

## 二、`zipBegin` 不再覆盖已验证归档（P1-3）

### 问题

```ts
// v1.3
closeSync(openSync(file, 'w'));   // 无条件截断
```

重复的 `begin`（超时重试、客户端重连、脚本重放）会把已经上传的 512 MiB 归档截成 0 字节，且不区分当前状态是否已经验证。

### 现在的三种情况

| 情况 | 行为 |
| --- | --- |
| **A. 首次上传**（无 `zip` 记录） | 创建暂存文件，`state = 'uploading'` |
| **B. `uploading`（重复 begin）** | **不截断**；返回 `{ offset: 磁盘真实长度, resumed: true }`；摘要冲突（与已 pin 的 claim 不同）明确拒绝；大小不同拒绝 |
| **C. `ready`** | 健康：拒绝（"已验证，会在重试时重新解压，不能在这里替换"）；`failure` 为 `missing`/`unverifiable`：仅凭 reselect token 允许替换 |
| **D. `extracted`** | 拒绝（"已解压，不能再次上传"） |

截断只在一处发生：

```ts
private startUpload(batchId, input, options) {
  ...
  closeSync(openSync(file, 'w'));   // 唯一入口：首次上传，或用户确认过的替换
```

`startUpload` 的调用者只有两个：`!previous`（首次）与 `beginReplacement()`（token 校验通过）。任何其它路径都拿不到截断能力。

### 幂等 begin 的意义

客户端上传中断后重连，不需要知道"上次传到哪"：调一次 `begin` 就拿到真实 `offset`，从那里继续。测试覆盖：先写入 100 字节，重复 `begin` 返回 `offset = 100`，文件仍是 100 字节，随后从 100 继续传完并成功解压。

### 验收（`tests/import-batch-zip-state.test.ts`）

| 用例 | 断言 |
| --- | --- |
| 首次 begin | `offset = 0`，`uploading` |
| 上传部分后重复 begin | `offset = 100`、`resumed = true`、字节数不变（未截断） |
| ready 状态 begin | 抛"cannot be replaced here"；**文件 SHA-256 不变**；状态仍 `ready` |
| extracted 状态 begin | 抛"already been extracted"；状态仍 `extracted` |
| 不同摘要的重复 begin | 抛"already pinned a different archive digest"；已上传字节保留 |
| 重新选择原文件 | 走 reselect → token → begin，正常上传 |

---

## 三、数据兼容

`zipBegin` 的返回对象新增 `resumed`（可选，旧客户端忽略即可）；请求体新增可选 `token`（仅重选路径使用）。没有改变任何字段语义，旧客户端（v1.3 前端）首次上传路径完全不变。
