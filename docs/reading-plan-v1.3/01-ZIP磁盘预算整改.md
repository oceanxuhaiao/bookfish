# 01 · ZIP 磁盘预算整改（P1-1 / P1-2 / P1-3）

对应任务书：① `batchDirBytes()` 改真递归；② 部分解压失败后预算重算；③ 消除不受预算约束的复制回退。

全部改动集中在 `src/import-batches.ts`（+314 / −? 行，见 `evidence/changes.patch`）。

---

## 1. 目录占用改为真递归（P1-1）

### 问题

v1.2 的 `batchDirBytes()` 只扫一层目录、且读异常时按 0 处理。归档里的嵌套布局（`系列/第一部/正文/book1.txt`）几乎全在子目录里，占用被大幅低估；磁盘预算因此形同虚设，"实测峰值"是假的。

### 实现

`src/import-batches.ts:95-106`：

```ts
export function dirTreeBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat: ...;
    try { stat = lstatSync(full); } catch (error) { if (isVanished(error)) continue; throw error; }
    if (stat.isDirectory()) {
      try { total += dirTreeBytes(full); } catch (error) { if (isVanished(error)) continue; throw error; }
    } else if (stat.isFile()) total += stat.size;
  }
  return total;
}
```

四条语义，逐条对应任务书要求：

| 要求 | 实现 |
| --- | --- |
| 递归统计嵌套目录 | 见上，自递归 |
| 符号链接不跟随 | 用 `lstatSync`（不是 `statSync`），`isDirectory()` / `isFile()` 对链接均为 false，链接本身不计入 |
| 遍历中途消失不误判 | `ENOENT` 容忍（`isVanished`），其它错误继续抛 |
| **读异常不得默认零** | 目录 `readdirSync` 失败直接向上抛；`lstat` 的非 ENOENT 失败也抛。未知绝不能当 0，否则预算会静默超放 |

旧的 `batchDirBytes()`、`extractCeiling()` 已删除（无引用残留，见补丁中的 `-` 行）。

### 测试侧独立实现（关键）

`tests/import-batch-zip-recursive.test.ts` 与 `tests/import-batch-zip-peak.test.ts` 都**不 import** 生产实现，各自写了一份独立递归 walk（`treeBytesAt` / `dirBytes`），用"两套独立实现对同一目录给出同一数字"来交叉验证。这样生产实现写错时测试不会跟着一起错。

验收用例（`tests/import-batch-zip-recursive.test.ts`，4 例）：

| 用例 | 断言 |
| --- | --- |
| 三层嵌套 ZIP 的占用统计 | 生产 `dirTreeBytes` 与测试独立 walk 结果**相等**，且等于 3 个条目的字节和 |
| 嵌套导致的预算判定 | 按嵌套真实字节数触发 `overBudget`，不再因低估而放行 |
| 符号链接不跟随 | 指向大文件的链接不增加统计值 |
| 遍历中途目录消失 | 删掉子目录后统计不抛错、不把未知记 0 |

---

## 2. 部分解压失败后预算重算（P1-2）

### 问题

v1.2 的预算是"整批"口径：失败重试时，上一轮已经搬进 `.src` 的文件仍占着磁盘，但预算计算没有把它们算进去，重试等于在已有占用之上再要一整棵树——直接冲破 `batchBytes` / `workspaceBytes`。

### 实现（`src/import-batches.ts:422-438`）

```ts
const zipSize = statSync(zipPath).size;
if (zipSize !== persisted.size) throw new Error('The stored archive does not match its declared size');
// 已有暂存 = 批次目录真实占用 − 压缩包本身
const existing = Math.max(0, dirTreeBytes(this.batchDir(batchId)) - zipSize);
const ceiling = Math.min(this.budget.batchBytes - existing, this.budget.workspaceBytes - zipSize - existing);
if (ceiling < 1) {
  throw new Error(`The batch workspace cannot fit another extraction: ${ceiling} bytes of headroom left (already occupied: ${existing})`);
}
const free = this.diskFree(this.batchDir(batchId));
if (free !== null && free < ceiling) {
  throw new Error(`Not enough disk space: ${free} bytes free, this extraction may need up to ${ceiling}`);
}
```

逐条对应任务书：

| 要求 | 实现 |
| --- | --- |
| 可用 = workspace − ZIP − 已有暂存 | `workspaceBytes - zipSize - existing`，并与 `batchBytes - existing` 取小 |
| 已有暂存 + 新解压 ≤ batchBytes | 上面的 `Math.min` 第二项正是这条 |
| 磁盘剩余不足先拒绝，不写满再报错 | `statfsSync` 的 `bavail × bsize` 预检，**在 `mkdirSync(target)` 之前**；解压 worker 的 `maxTotalBytes` 也传 `ceiling`，双重约束 |
| 不删成功书 | 失败路径 `rmSync(target)` 只删本轮解压目录；已搬移的 `.src` 与批次条目原样保留 |
| 不重复导入 | 搬移循环按 `items` + `item.staged` 跳过，重试只处理未搬移的条目 |
| 重试不破预算 | 每次进入都重算 `existing`，失败重试的 `ceiling` 随着已有暂存增大而减小 |

`diskFree` 是可注入依赖（`ImportBatchesOptions.diskFree`，`src/import-batches.ts:126`），测试用小预算/假磁盘验证边界，不需要真的造一个满盘。

### 验收（`tests/import-batch-rename-retry.test.ts`，5 例）

| 用例 | 断言 |
| --- | --- |
| rename 全失败后恢复 | 抛错文案含"已保留压缩包供重试"；ZIP 仍存在；`state` 回到可重试（`ready`）；批次条目全部未 staged；重试后 3 本书成功、`.src` 各 1 份 |
| 部分失败 + 重启 + 再解压 | 重启后 `resume()` 再解压；**全程峰值 ≤ `workspaceBytes`**（每步实测 `dirTreeBytes`）；已成功的书不重复、进度不丢 |
| 磁盘预检 · 拒绝 | 注入 `diskFree = 1024`：在任何解压产物写出前抛 `Not enough disk space`，`extract` 目录不存在 |
| 磁盘预检 · 通过 | 注入 `diskFree = 10 MiB`：正常解压 |
| 磁盘预检 · 无法测量 | 注入 `diskFree = null`：不阻塞（无法测量不等于零） |

---

## 3. 消除不受预算约束的复制回退（P1-3）

### 选择

任务书给了两条路。**采用推荐方案：整段移除 `copyThenUnlink`。**

理由：保留回退就必须把它做成流式、计入预算、事后再校验一遍——这三件事都要复刻 `rename` 路径已有的约束，等于在预算体系旁边维护第二条等价路径；而它存在的唯一场景（同一目录树内 `rename` 失败）本身就说明文件系统或权限有问题，此时"偷偷复制一份"只会让磁盘占用翻倍、把问题藏起来。

### 实现（`src/import-batches.ts:466-489`）

```ts
for (const item of this.require(batchId).items) {
  if (item.staged) continue;
  const from = join(target, ...item.name.split('/'));
  if (!existsSync(from) || !lstatSync(from).isFile() || statSync(from).size !== item.size) continue;
  const to = this.stagedPath(batchId, item);
  rmSync(to, { force: true });
  try { renameSync(from, to); }
  catch (error) {
    throw new Error(`无法把解压出的文件移动到暂存位置（文件系统或权限问题）：${...}；已保留压缩包供重试`);
  }
  if (statSync(to).size !== item.size) throw new Error('Staged entry length does not match the archive entry');
  ...
}
```

失败时的完整后果（任务书逐条）：

| 要求 | 实现 |
| --- | --- |
| 记录原因 | 错误消息带原始 `errno` 文案 + "已保留压缩包供重试" |
| 不删源 | `catch` 分支不删 `from`；失败路径只 `rmSync(target, {recursive:true})`（`src/import-batches.ts:516`）——注意 `.src` 已经搬走的文件**不在** `target` 里，天然保住 |
| 保留 ZIP | 失败路径不删 `source.zip`（只有成功/空归档终态才删） |
| 清理解压目录 | `catch` 里 `rmSync(target, ...)`，不留半截树 |
| 置可恢复状态 | `zip.state` 保持 `ready`（已验证字节仍在），下次 `zipFinish` / `resume()` 可直接重试 |
| 禁用整文件 `readFileSync` | 全文件已无 `readFileSync`（源级护栏用例断言） |

### 顺便修掉的 v1.2 真 bug

v1.2 的搬移循环遍历 `result.added`。重试时所有条目都已存在（全部进 `duplicates`），`added` 恒为空——**上一轮没搬完的条目永远拿不到 `.src`**，界面表现为"解压完成但书一直 pending"。改为遍历 `this.require(batchId).items` + `item.staged` 跳过，重试路径才真正可重入。这条由上面"部分失败 + 重启 + 再解压"用例覆盖。

### 源级护栏（`tests/import-batch-bounded-read.test.ts`）

```ts
// 源码里不得再出现不受预算约束的整文件读取与复制回退
expect(source).not.toContain('readFileSync');
expect(source).not.toContain('copyThenUnlink');
expect(source).toContain('readRange(file,');
```

护栏读的是 `src/import-batches.ts` 原文，防止以后有人"顺手"加回来。
