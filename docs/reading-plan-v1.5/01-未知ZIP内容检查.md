# 01 · 索引不可读时的第二道真实内容检查（P1-1）

对应任务书第 1 节。核心命题：**`readZipPlan()` 返回 `null` 不等于可以放行。**

---

## 1. v1.4 的实际缺陷

v1.4 已经在解压**之前**读中央目录（`readZipPlan()`），据以判定"几本书 / 解压后多大"。但该函数在五种情况下返回 `null`：

| 情况 | 判定依据（`src/import-batches.ts:103-160`） |
| --- | --- |
| ZIP64 | 经典 EOCD 的 `entryCount === 0xFFFF` / `cdSize === 0xFFFFFFFF` / `cdOffset === 0xFFFFFFFF` |
| 分卷 | `diskNumber !== 0` 或 `cdDisk !== 0` |
| 中央目录 > 8 MiB | `cdSize > ZIP_PLAN_MAX_CD`（`8 * 1024 * 1024`） |
| 条目 > 20000 | `entryCount > ZIP_PLAN_MAX_ENTRIES` |
| 结构不可信 | 尾部 66 KiB 内无 EOCD、签名不符、`cdOffset + cdSize > size`、读文件失败、条目记录越界、条目 `uncompressed === 0xFFFFFFFF` |

v1.4 对 `null` 的处理只有一句：

```ts
const estimate = plan ? plan.totalUncompressed : ceiling;   // 预算预检退回最坏值
const books = plan ? Math.max(incoming, plan.supported) : incoming;
if (books > BATCH_ITEM_LIMIT) { … }                          // plan 为 null 时这行永不触发
```

结论：**索引读不到时，100 本限制这道闸门直接短路**。一个 120 本的 ZIP64 只要解压后不超 1 GiB 预算，就会走完 `addItems()`：前 100 本进批入库，后 20 本落到 `overflow` 计数里——从用户视角看，这是"导入成功"。

## 2. 本轮的流程

`extractArchive()`（`src/import-batches.ts:551` 起）现在的顺序：

```
1. statSync → 长度等于 zip.size
2. pin = zip.sha256 ?? zip.claimedSha256；缺则 fail('unverifiable')
3. sha256File(zipPath) === pin，否则 fail('unverifiable')
4. existing = dirTreeBytes(batchDir) - zipSize；ceiling = min(batch - existing, workspace - zipSize - existing)
   ceiling < 1 → fail('over_limit')
5. plan = readZipPlan(zipPath, budget.fileBytes)
   ├─ plan !== null → 三道索引预检（count / entry / bytes），任一命中 → refuseArchive()
   └─ plan === null → 跳过，进入第 6 步
6. estimate = plan ? plan.totalUncompressed : ceiling
   diskFree === null → fail('disk')；free < estimate → fail('disk')
7. target = batchDir/<uuid>.extract   ← 独立临时目录
8. extractRuntimeZip(zipPath, target, signal, undefined, { maxEntries: 400, maxTotalBytes: ceiling, maxEntryBytes: budget.fileBytes })
9. peak = dirTreeBytes(batchDir)；peak > workspaceBytes → fail
10. entries = outcome.files 过滤隐藏项
11. verdict = classifyInputs(entries, { seen, itemCount, declaredBytes, itemLimit: 100, fileBytes, batchBytes })   ← 第二道检查
12. overflow > 0        → refuseArchive('count', measured: true)
    tooLarge.length > 0  → refuseArchive('entry', measured: true)
13. recordRejected(...)  ← 先记录拒绝，再接受
14. addItems(verdict.accepted)  ← 到这里才第一次写正式条目
15. 逐条 rename 到 .src 暂存位
16. rmSync(target)；ZIP 处理（全部暂存 → 删包；否则保留）
17. catch: rmSync(target) → ZipStateError 直接抛 / over_limit → refuseArchive / 否则 fail
```

第 11 步是 v1.5 的**新增**：它跑在真实解压出的目录树上，跑在 `addItems()` 之前，跑在任何字节被 `rename` 到 `.src` 之前。

## 3. 统计规则与导入规则完全一致

关键设计：**`classifyInputs()` 是一个纯函数，上传路径与解压路径共用**（`src/import-batch.ts:326`）。

v1.4 里 `addItems()` 内联了分类逻辑，解压路径另有 `entries.filter(size > fileBytes)` 手写一版。两套规则并存就会有分歧（比如大小写重复、NFC 归一化），而分歧在"100 本边界"这种地方一定表现为"一边接受、一边拒绝"。

现在的判定顺序（两条路径逐条相同）：

| # | 检查 | 桶 |
| --- | --- | --- |
| 1 | `safeBatchName()` 失败（路径穿越 / 绝对路径 / Windows 设备名 / 过长 / 控制字符） | `duplicates` |
| 2 | `size` 非安全整数或 < 1 | `duplicates` |
| 3 | 扩展名不在 `.txt / .md / .epub / .pdf` | `unsupported` |
| 4 | 路径归一化（NFC + `toLowerCase`）后已存在（含本批已有条目、本次请求内重复） | `duplicates` |
| 5 | `size > fileBytes` | `tooLarge` |
| 6 | `declared + size > batchBytes` | `overBudget` |
| 7 | `itemCount + accepted.length >= itemLimit` | `overflow`（并收集名单，上限 100） |

解压路径额外一层：**隐藏项从不参与**。`entry.path.split('/').some(part => part.startsWith('.'))` 的条目（`__MACOSX/`、`.DS_Store`、`._正文.txt`）在进入分类器前就被过滤，与 `readZipPlan()` 里的 `hidden` 判定同义。目录条目由 Worker 自行 `mkdir` 且不进入 `outcome.files`，因此"目录也算一本书"这种错误不可能发生。

## 4. 超 100 本默认整包拒绝

```ts
if (verdict.overflow > 0) {
  const found = verdict.accepted.length + verdict.overflow;
  throw this.refuseArchive(batchId, 'over_limit', 'count',
    `解压后实际得到 ${found} 本可导入的书，超过单批 ${BATCH_ITEM_LIMIT} 本的上限；已保留压缩包并清理临时目录，没有任何一本被部分导入。`,
    { measured: true, totalBytes: outcome.bytes, budgetBytes: ceiling,
      books: found, accepted: acceptedBefore, names: verdict.overflowNames, overflow: verdict.overflow, … });
}
```

`found` 是**实测总数**：能容下的 + 容不下的。它不等于"前 100 本"，也不等于 `entries.length`（后者含不支持格式）。这是任务书第 1 节"统计必须准确"的落点。

## 5. 任务书 10 条约束的逐条落实

| # | 约束 | 落实位置 |
| --- | --- | --- |
| 1 | `addItems()` 之前完成检查 | 第 11 步在 §2 流程里先于第 14 步 |
| 2 | 不用"前 100 本截断"代替整包检查 | `overflow > 0` 即整包拒绝；不存在部分接受的代码路径 |
| 3 | 超限不移动任何文件到 `.src` | 拒绝发生在第 15 步之前；`refuseArchive()` 内无 `renameSync` |
| 4 | 不创建部分计划条目 | 未调用 `addItems` → `batch.items` 为空 → 无 `ImportJob`（`tests/import-batch-zip-unknown.test.ts:197`） |
| 5 | 保留 `source.zip` | `refuseArchive()` 不改 `zip.state`（保持 `ready`）、不 `rmSync(zipPath)` |
| 6 | 清理 `.extract` | `catch` 块首句 `rmSync(target, { recursive: true, force: true })` |
| 7 | 不影响其他已成功批次 | 只 `updateImportBatch(batchId, …)`；预算按本批目录实算 |
| 8 | 失败后仍有明确处理路径 | `state: 'ready'` + `rejection.nextStep` + 面板"重试解压"入口 |
| 9 | 不绕过 Worker 路径安全与炸弹保护 | 仍走 `extractRuntimeZip()`；Worker 的 12 条拒绝规则一字未改 |
| 10 | 不放宽 1 GiB / 1.5 GiB 预算 | `batchBytes` / `workspaceBytes` 常量与 `ceiling` 公式均未改 |

## 6. 测试夹具：真实 ZIP，而非 mock

任务书特别要求"不能只 mock `readZipPlan()` 返回 null，必须提供至少一个真实合法 ZIP，中央目录无法通过预解析器但 Worker 能正常解压"。本轮的两种真实夹具：

### 6.1 手工 ZIP64（`tests/import-batch-zip-unknown.test.ts:48`）

```ts
// 在经典 EOCD 之前插入 56 字节 ZIP64 EOCD 记录 + 20 字节 locator，
// 并把经典 EOCD 的 entryCount / CD size / CD offset 写成逃逸标记。
record.writeUInt32LE(0x06064b50, 0);            // ZIP64 end of central directory
record.writeBigUInt64LE(44n, 4);                // size of remaining record
record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);   // version made by / needed
record.writeBigUInt64LE(BigInt(entriesCount), 24);            // entries on this disk
record.writeBigUInt64LE(BigInt(entriesCount), 32);            // entries total
record.writeBigUInt64LE(BigInt(cdSize), 40);                  // central directory size
record.writeBigUInt64LE(BigInt(cdOffset), 48);                // central directory offset
record.writeUInt32LE(0x07064b50, 56);                         // ZIP64 locator
record.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64);
record.writeUInt32LE(1, 72);
tail.writeUInt16LE(0xffff, 10); tail.writeUInt32LE(0xffffffff, 12); tail.writeUInt32LE(0xffffffff, 16);
```

为什么不用 `yazl` 的 `forceZip64Format: true`：实测它只在条目 ≥ 65535 时才写 ZIP64 记录，小包上加了选项仍写经典 EOCD，`readZipPlan()` 照样读得出来（这个弯路记录在 §8）。手工插入才是真 ZIP64，`yauzl`（Worker 用的库）能正常解压——两边的差异被完整复现。

### 6.2 超大中央目录（`tests/import-batch-zip-unknown.test.ts:78`）

```ts
// 每条 entry 带 65 520 字节的 fileComment：128 条 → 中央目录 > 8 MiB。
// 归档本身仍是合法 ZIP，只是索引超出预解析器的 8 MiB 读取上限。
(zip as unknown as { addBuffer(b: Buffer, p: string, o?: { fileComment?: string }): void })
  .addBuffer(body, name, { fileComment: 'x'.repeat(0xfff0) });
```

`@types/yazl` 把 `addBuffer` 的选项声明为 `Partial<Options>`（不含 `fileComment`），运行时确实支持，因此用一次带注释的类型断言，而不是改产品代码去迁就类型。

### 6.3 覆盖矩阵（10 例全绿）

| 场景 | 断言 |
| --- | --- |
| ZIP64 / 99 本 | 全部接受、`zip.state === 'extracted'` |
| ZIP64 / 100 本 | 全部接受、`report.overflow === 0` |
| ZIP64 / 101 本 | 整包拒绝、0 条目、`kind: 'count'`、`measured: true`、`books: 101`、`partiallyStaged: false` |
| ZIP64 / 120 本 | 同上，`books: 120` |
| 中央目录 > 8 MiB / 128 本 | 整包拒绝、0 条目、`books: 128`、ZIP 保留 |
| 拒绝后的现场 | ZIP SHA-256 与上传时一致、0 个 `.src`、0 个 `.extract`、`lib.list()` 为空、`rejection` 重启后仍在 |
| 名单真实性 | `rejection.names` 非空且全部匹配 `/\.txt$/` |
| ZIP64 超预算 | `kind: 'bytes'`、0 条目、ZIP 保留、`.extract` 已清理 |
| 可读索引的 count 拒绝 | `measured: false`（数字来自声明，不是实测） |
| 成功归档 | `zip.rejection === undefined`、`report.archiveRejected === null` |

## 7. 一处并发注意

`acceptedBefore` 在第 5 步之前取（`this.require(batchId).items.length`），第 11 步复用同一个值。为什么不重取：如果解压期间有其他路径往本批 `addItems`，`itemCount` 会变大而 `verdict.accepted.length` 仍按旧基数算，`itemLimit` 判断就会漏。当前实现下 `zipFinish()` 被 `running` 集合串行化，同一批次不会有两个解压并发；重试场景（`tests/import-batch-zip-count-rules.test.ts:195`，99 本已暂存 + 归档补 1 本）由 `acceptedBefore = 99` 正确处理，最终恰好 100 本、`report.duplicate = 99`。

## 8. 走过的弯路（如实记录）

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `yazl` + `forceZip64Format: true` 生成的包，`readZipPlan()` 仍返回 plan | yazl 只在条目 ≥ 65535 时输出 ZIP64 EOCD | 改为手工插入记录 + 逃逸标记 |
| 超大目录夹具只有 8 404 984 字节（< 8 MiB） | `fileComment: 'x'.repeat(65535)` 被 yazl 拒绝（> 0xffff） | 改 `0xfff0`（65 520）× 128 条 → 8.4 MB |
| `@types/yazl` 不接受 `fileComment` | 类型声明为 `Partial<Options>` | `as unknown as` 强转 + 注释说明运行时支持 |
| 超限单本用 ZIP64 夹具时 `rejection.names` 为空 | 索引不可读 → 无 file list → 名单确实无从得知 | 拆成两例：ZIP64 只断言 `kind` / `partiallyStaged` / 零条目 / ZIP 保留；另用普通 ZIP 验证名单（`tests/import-batch-zip-count-rules.test.ts:145`、`:172`） |
| 期望数组与实际顺序不符 | 默认 `sort()` 按 UTF-16 码元，`第`(U+7B2C) 排在 `系`(U+7CFB) 前 | 断言改为已排序的 4 项字面量 |

## 9. 复现

```bash
cd E:/项目/桌面宠物/扩展/cortina/state/packages/bookfish-reading-plan
npx vitest run tests/import-batch-zip-unknown.test.ts --pool=threads   # 10 passed
```