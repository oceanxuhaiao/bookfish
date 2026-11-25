# 03 · ZIP 重新选择的事务边界（P1-4）

对应任务书第 4 节：取消文件选择器 / 选错文件都不能让批次卡死。

---

## 1. 问题

v1.3 的 `zipReselect()` 在**用户还没选文件之前**就做了三件不可逆的事：

```ts
rmSync(file, { force: true });                                  // 删掉已上传的字节
closeSync(openSync(file, 'w'));                                 // 建一个空文件
updateImportBatch(... draft.zip.state = 'uploading' ...);       // 改成"正在上传"
```

用户如果在系统对话框里点了取消，批次就永久停在 `uploading`：`zipChunk` 期待数据但永远没有数据，`zipFinish` 因长度不足拒绝，而 `zipReselect` 又因为状态不是 `needs_reselect` 拒绝再次进入——**按钮失效，只能重启宿主**。

另外 v1.3 还要求 `batch.items.length === 0` 才能重选，于是"已导入一半 + 归档丢失"的批次没有任何恢复路径（`01` 记录了这个死结）。

## 2. 两阶段设计

### 第一阶段：`zipReselect(batchId)` —— 只准备

```ts
zipReselect(batchId) {
  // 校验来源、状态（needs_reselect，或 ready 且 missing/unverifiable）
  // 校验没有正在进行的解压
  const digest = zip.sha256 ?? zip.claimedSha256;      // 没有指纹 → 明确拒绝，要求新建批次
  const token = randomUUID();
  this.reselectTokens.set(batchId, { token, sha256: digest, size: zip.size });
  return { batchId, name, size, sha256: digest, chunkBytes, token };
}
```

**副作用清单：无。** 不改记录、不删文件、不建空文件、不改状态。token 只存在内存（`Map<batchId, {token, sha256, size}>`），重启即失效——失效的代价只是"再点一次按钮"，绝不会让服务端去猜。

### 第二阶段：`zipBegin(batchId, { ..., token })` —— 确认并替换

只在 `beginReplacement()` 里校验并放行：

```ts
const prepared = this.reselectTokens.get(batchId);
if (!request.token || !prepared || prepared.token !== request.token)
  throw new Error('This archive must be re-picked first ...');
if (previous.size !== request.size || prepared.size !== request.size) throw ...;
if (request.claimed !== undefined && prepared.sha256 && request.claimed !== prepared.sha256)
  throw new Error('选中的压缩包不是原来的那一个（内容指纹不一致）...');
this.reselectTokens.delete(batchId);          // 一次性
return this.startUpload(..., { replace: true });
```

| 保障 | 结果 |
| --- | --- |
| token 一次性 | 用过即删；重复 begin 变成幂等 resume，不再有替换能力 |
| 摘要必须匹配 | 选错文件在 begin 就被拒，前端另有预检更早拦住 |
| 大小必须匹配 | 与批次 pin 的 `size` 不一致直接拒绝 |
| 只有这里能截断 | 见 `02` 的 `startUpload` |

### 已导入一半也能重选

v1.4 删除了 `batch.items.length` 的前置拒绝：

- 身份由摘要强约束（必须仍是同一个归档），不存在"换个包覆盖已有书目"的风险；
- 重新解压时 `addItems` 把同名条目判为重复、搬移循环只处理未 staged 的条目，**不会产生第二份书**；
- 已入库的书与阅读进度完全不受影响。

## 3. 前端流程（`src/webui/batch-import.ts`）

```
[重新选择 ZIP] 点击
   → invoke import_batch_zip_reselect  →  { sha256, token }
   → state.reselectZipToken = token; state.expectedZipSha256 = sha256
   → zipInput.click()                       ← 用户可能在这里取消
   → 取消：什么都没变，按钮仍在，可以再点
   → 选中：fileDigest() 先与服务端期望比对（不一致直接拒绝，不发一个分片）
          → import_batch_zip_begin { name, size, sha256, token }
          → 分片上传（从 begin 返回的 offset 开始）
          → finish → 成功解压
失败：state.reselectZipToken 保留在内存但服务端 token 已消耗或未消耗，
      再次点击按钮会重新 prepare 拿新 token。
```

## 4. 验收（任务书第 4 节的 7 个场景）

| 场景 | 断言 | 用例 |
| --- | --- | --- |
| 用户取消文件选择器 | 准备阶段后 `state`/`sha256`/`claimedSha256` 全部不变；再次 prepare 仍成功 | `preparing a re-pick changes nothing ...` |
| 用户选择错误文件 | 摘要不符 → begin 拒绝；文件系统未被替换；批次仍可重选 | `a wrong pick is rejected and the batch can be re-picked again` |
| 摘要计算失败（前端） | `fileSha256Hex` 返回 null → 不带 claim 上传，服务端仍按记录里的 claim 校验（不放松） | `tests/webui-sha256.test.ts`（v1.3 已有） |
| 用户重新打开选择器 | 每次点击都重新 prepare，拿新 token | 同上第一条（两次 prepare 均成功） |
| 用户选择正确文件 | 正常上传并解压 | 同上第一条 |
| 上传中断 | 回到 `needs_reselect`（`resume()` 落半截），可再次 prepare | `tests/import-batch-zip-claim.test.ts` 中断用例 |
| 再次恢复 | 同一 `batchId` 完成导入，不重复 | `a re-pick with entries already staged ...` |

## 5. 未使用的新持久化

token 是**内存态**，不落盘、不进 `library.json`。这是刻意的：一个跨重启有效的"替换许可"等于把一次用户点击的授权变成长期凭据。重启后用户再点一次按钮，成本可以忽略。
