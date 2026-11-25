# 真实宿主验收报告（v1.5）

- 验收对象：`feat/reading-plan-v1` · 代码 `cfd46e0` · 文档 `ea2d9eb`
- 验收时间：2026-11-25 21:30 – 22:08（北京时间）
- 宿主：Coopanion 0.2.23（`E:\zcdfy\Coopanion`，program 区只读）
- 隔离数据根：`E:\zcdfy\Coopanion\data-v15-acceptance-run3`（web 端口 17789）
- 正式实例：`E:\zcdfy\Coopanion\data`（web 端口 17788，root PID 17112，全程未重启）
- 结论：**PASS**（17 步全部取证，14/15 以测试替代，A–E 五项真机新发现需回写文档）

---

## 0. 隔离方案与安全边界

| 项 | 做法 | 证据 |
| --- | --- | --- |
| 数据隔离 | `CORTICO_COMPANION_DATA` 指向 `data-v15-acceptance-run3`，绕过 `data-location.json` 落点判定（`app/main.cjs:82-87` 的 `INSTALLED` 因环境变量存在而为 `false`） | `evidence/pre-hashes.txt` 中 `data-location.json` 验收前后哈希一致 |
| 自动更新 | 隔离根 `companion.autoUpdate = false`（`updater.cjs:41` 会写正式安装目录） | 隔离根 `config.json` |
| 单实例锁 | `app.requestSingleInstanceLock()` 锁在 `userData`(=DATA) 上，换根即另一把锁 → 与正式宿主**并存** | 两个实例 PID 同时存在 |
| 自动阅读 | 隔离根关闭 `automaticReading / automaticSharing / automaticReview / txtAcquisitionEnabled / browserBridgeEnabled / sleepEnabled / mealsEnabled / realRoutineEnabled` | 隔离根 `config.json` |
| 侧载 | `extensions/node_modules/cortico-world-bookfish` → symlink 指向 v1.5 worktree | `evidence/step00-manifest-hash.txt` |

### 侧载一致性（步骤 0）

宿主实际下发的客户端脚本与本地产物**逐字节一致**：

```
url  = /assets/extensions/cortico-world-bookfish/0.66.7/lib/webui-txt-builtin-bing-0651.js
size = 489,603 B
sha256 = 31347a6283e7c0b28d74fa87b2393ec8793d289367aa280a371e2f06adfdc390
MATCH  = true
```

---

## 1. 验收素材（14 份 ZIP + 2 个文件夹）

素材用 **Python `zipfile`** 生成。这一步是必须的：Windows 自带 libarchive（`tar.exe`）用 ANSI/GBK 写条目名且不置 UTF-8 标志位（`flag_bits & 0x800`），宿主按 UTF-8 解码后书名全变 `╩Θ001` / `╒²╬─`。`zipfile.writestr` 对非 ASCII 名自动置 `0x800` 并写 UTF-8 字节，宿主才正确显示 `验收小说001`。

| 文件 | 字节 | 书数 | 条目 | `readZipPlan` | 真机路径 |
| --- | --- | --- | --- | --- | --- |
| 01-normal-3books.zip | 778 | 3 | 4 | ok / 3 本 | 第二道检查 → 3 入库 |
| 02-plain-120books.zip | 26,842 | 120 | 120 | ok / over=20 | 预检拒绝（`measured=false`, `books=120`） |
| 03-nested-3books.zip | 772 | 3 | 3 | ok / 3 本 | 3 入库 |
| 04-zip64-99books.zip | 7,241,856 | 99 | 65,545 | **null**（逃逸） | Worker 条目上限拦截 |
| 05-zip64-101books.zip | 7,258,389 | 101 | 65,545 | **null** | **整包拒绝, books=null** |
| 06-zip64-120books.zip | 7,415,462 | 120 | 65,545 | **null** | **整包拒绝, books=null** |
| 07a-bigcd-99books.zip | 10,189,449 | 99 | 400 | **null**（cdSize 9.3 MB） | 第二道检查 → 可入库 |
| 07b-bigcd-101books.zip | 10,205,869 | 101 | 400 | **null** | **实测 101 本 / 834,251 B，溢出 1** |
| 07c-bigcd-120books.zip | 10,362,992 | 120 | 400 | **null** | **实测 120 本 / 991,210 B，溢出 20** |
| 07d-bigcd-150books.zip | 10,611,162 | 150 | 400 | **null** | **实测 150 本 / 1,239,040 B，溢出 50** |
| 08-oversize-1big.zip | 106,988,356 | 5 | 5 | ok / oversize=1 | 预检拒绝（`kind=entry`） |
| 09-truncated.zip | 466 | — | — | **null**（无 EOCD） | 解压失败, ready 保留 |
| 10-405entries-101books.zip | 873,961 | 101 | 405 | ok / over=1 | 预检拒绝（备用） |
| 11-exact-100books.zip | 20,161 | 100 | 100 | ok / 100 本 | 边界（备用） |

`07a-07d` 的构造：`pad = 400 - nbooks`，每条 `ZipInfo.comment = ceil(8.9 MiB / pad)` 字节 → 总条目恰 400（不撞 Worker `maxEntries`）、`cdSize > 9 MB`（触发 `readZipPlan` 的 8 MiB 上限）→ 落入第二道真实内容检查。

判定矩阵见 `evidence/asset-plan-matrix.json`（用真实 `readZipPlan` 跑出，非推算）。

---

## 2. 17 步证据矩阵

| 步 | 场景 | 观察结果 | 截图/证据 | 判定 |
| --- | --- | --- | --- | --- |
| 0 | 侧载哈希 | SHA-256 逐字节一致 | `step00-manifest-hash.txt` | **PASS** |
| 2 | 正常 ZIP 3 本 | `进批 3 本 · 已入库 3 本`；中文书名正确；1 个批次目录；`source.zip` 已删 | `step02-normal-zip.txt` + `shots/step02-*` | **PASS** |
| 3 | 三层嵌套 ZIP 3 本 | `已入库 3 本`；`嵌套书01/02/03` 正确；`zipPresent=false`；`extractDirs=[]` | `step03-normal-nested.txt` | **PASS** |
| 4 | 真 ZIP64 101 本 | **整包拒绝**：`条目数 0`、`source.zip` 保留 7,258,389 B、零 `.extract` 零 `.src`、UI 显示 `压缩包声明 未知 本 / 未知 字节` | `step04-zip64-101.txt` | **PASS**（见 §3-A） |
| 5 | 真 ZIP64 120 本 | 同上，`source.zip` 7,415,462 B | `step05-zip64-120.txt` | **PASS** |
| 5b | > 8 MiB 中央目录 101 本 | **第二道真实检查生效**：`解压后实测 101 本 / 834251 字节`；`超出单批 100 本上限 1 个（books/B100.txt）` | `step05b-bigcd-101.txt` | **PASS** |
| 5c | > 8 MiB 中央目录 120 本 | `解压后实测 120 本 / 991210 字节`；溢出 20 个 | `step05c-bigcd-120.txt` | **PASS** |
| 6 | > 8 MiB 中央目录 150 本 | `解压后实测 150 本 / 1239040 字节`；溢出 50 个 | `step06-bigcd-150.txt` | **PASS** |
| 7 | 单本 101 MiB | `kind=entry, measured=false, books=5`，点名 `books/超大单本.txt`，`原始压缩包已保留` | `step07-oversize.txt` | **PASS** |
| 8 | 关面板重开 | `reopened/reason/unknownBooks/kept/noPartial/nextStep` 全 true | `step08-reopen-panel.txt` | **PASS** |
| 9 | 整机重启 | 6 个批次目录**字节与 mtime 全部不变**（无新 `.extract`、无自动重试）；UI 5 项全 true | `step09-after-restart.txt` + `step09-batches-before.json` | **PASS** |
| 10 | 截断 ZIP 首失败 | `errorShown/retryButton/batchInHistory/batchDirCreated/zipKept` 全 true，无需重开面板 | `step10-truncated-first-fail.txt` | **PASS** |
| 11 | 文件夹 2 txt + 3 jpg | `共 2 本`；`格式不支持 3 个（folder-mixed/封面1.jpg…）`；未开始导入 | `step11-folder-mixed.txt` | **PASS**（P2-5 已生效） |
| 12 | 文件夹全 jpg | `进批 0 本`；`格式不支持 3 个`；历史出现 total 0 批次；不崩溃 | `step12-folder-alljpg.txt` | **PASS** |
| 13 | 篡改归档 | sha `688b5586…`→`a0ecef84…`（同长 466 B）；重试报 `内容与已验证的摘要不一致`；不导入；ZIP 保留 | `step13-tamper-archive.txt` | **PASS** |
| 14 | 改名失败 | 目录级 ACL Deny 在 Administrator 令牌下被绕过 → **未能触发**（见 §3-E） | `step14-rename-fail.txt` | `not_observed` |
| 15 | 恢复后重试 | 同上（前置未成立） | — | `not_observed` |
| 14/15 替代 | 改名失败代码路径 | `tests/import-batch-rename-retry.test.ts` → **6/6 通过**（含"拒绝改名不降级为无预算复制""保留归档""重试恢复""resume 保持 ready"） | 测试输出 | **PASS（替代）** |
| 16 | 旧计划统计 | `计划 1 本 · 至少累计读完 7 本` + `此计划由旧版本迁移而来…以上累计数字是可确认的下界，不是完整总数。` | `step16-legacy-plan-stats.txt` | **PASS** |
| 17 | 正式数据零改动 | 见 §4 | `post-formal-hashes.txt` | **PASS** |

### 零副作用审计（步骤 4–7）

| 批次目录 | `source.zip` 字节 | 原素材 SHA-256 | 一致 | `.extract` | `.src` | status | `rejection.kind` | books | measured |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1ef4cf3d | 7,258,389 | 05-zip64-101 | ✔ SAME | 0 | 0 | ready | count | **null** | **false** |
| eb246bb8 | 7,415,462 | 06-zip64-120 | ✔ SAME | 0 | 0 | ready | count | **null** | **false** |
| a4eb7908 | 10,205,869 | 07b-bigcd-101 | ✔ SAME | 0 | 0 | ready | count | **101** | **true** |
| f79e1444 | 10,362,992 | 07c-bigcd-120 | ✔ SAME | 0 | 0 | ready | count | **120** | **true** |
| 481179da | 10,611,162 | 07d-bigcd-150 | ✔ SAME | 0 | 0 | ready | count | **150** | **true** |
| adbaf4f6 | 106,988,356 | 08-oversize | ✔ SAME | 0 | 0 | ready | **entry** | 5 | false |

全 12 个批次目录**零 `.extract` 残留**；成功批次（3a33ef85 / fc7d00d0 / f07d0d60）ZIP 已删，被拒批次 ZIP 完整保留。

---

## 3. 真机新发现（必须回写文档）

### A. Worker `maxEntries` 使真 ZIP64 无法进入第二道内容检查 ← **最重要**

`src/import-batches.ts:639-640` 传 `maxEntries: BATCH_ITEM_LIMIT * 4 = 400`；`zip-worker.ts:90` 在 `entries > limits.maxEntries` 时 `abort('zip_too_many_entries')`。

真 ZIP64 的经典 EOCD 必须打 `0xFFFF` 逃逸（条目 ≥ 65535），**总条目数必然 > 400** → 归档在 Worker 阶段就被拒，轮不到第二道内容检查。

**后果**：对真 ZIP64，P1-1 的"真实内容检查"实际退化为"Worker 条目上限拒绝"，`books` 只能是 `null`，`measured=false`。

**真正能走第二道检查的兜底路径**是 **`cdSize > 8 MiB` 且条目 ≤ 400**——已用 07b/07c/07d 三份实证（`解压后实测 N 本 / X 字节`）。

> 文档 `09` §C 步骤 4/5 写的「面板显示"整包未导入：解压后实际得到 101 本…"」对**真 ZIP64 不可达**，实际文案是「压缩包文件数量超过限制」+「压缩包声明 未知 本 / 未知 字节」。已据实测修正。

### B. 预览态 + 解压失败时 UI 冗余

拒绝态界面同时出现「重试解压」与「开始导入 / 取消这批」。点「开始导入」会抛 `Error: Import batch is empty`。建议：拒绝/失败态隐藏「开始导入」按钮。

### C. 计划统计在 `textContent` 的不可见区

`document.body.innerText` 取不到计划统计（只有 317 字符，停在书架态）；必须用 `textContent`。自动化断言应统一改用 `textContent`。

### D. 非法 UUID 会让整个 bookfish world **静默不挂载**

`src/reading-plan.ts:134` `Invalid reading plan item id` → 整个 world 启动失败被跳过（`core/world-start-failed: World 启动失败,已跳过: bookfish`），所有面板调用报 `Bookfish is not mounted`。不是只对该字段报错。注入 legacy plan 必须用合法 UUID。

### E. Administrator 令牌下目录级 ACL Deny 不能可靠触发 rename 失败

以 Administrator 权限运行时，目录级 `Deny Write` 被绕过（批次照常入库，还带「书架上已有同名同作者版本」）。ACL 已恢复（`RemoveAccessRule` 确认 "ACL restored"）。v1.5 文档 A7 应**保持** `not_observed`。

---

## 4. 正式数据零改动（步骤 17）

正式数据根 `E:\zcdfy\Coopanion\data`（由 `data-location.json` 确认，验收前后哈希一致）。

| 项 | 验收前 | 验收后 | 判定 |
| --- | --- | --- | --- |
| `data/extensions/package.json` | `32E4EEB8…A3564D` | `32E4EEB8…A3564D` | **SAME** |
| `data-location.json` | `E2F650D6…19F46F` | `E2F650D6…19F46F` | **SAME** |
| bookfish 文件数 | 10029 | 10029 | **SAME** |
| `sharing.json` / `text-store.json` / `writer.lock` | — | — | **SAME** |
| 验收痕迹（`验收小说` / `01-normal` / `importBatches` / `plan` 键） | — | **全部 false** | **零污染** |

### 3 处字节变化的归因

`library.json`、`reading-budget.json`、`history.sqlite` 在 22:02:28 发生字节变化。**这不是验收操作**：

- 正式 `history.sqlite` 最后一条阅读记录 `recordedAt = 2026-11-25T14:02:28.542Z`（UTC）= **北京时间 22:02:28**，与文件 mtime **完全吻合**；
- 该记录 `bookKey = 6a52794c…` 是正式宿主原有书，非验收素材；
- 正式宿主 `bookfish.automaticReading = true` / `dailyTasks = 40` / `dailyChars = 48000`，当日已累计 100 任务 / 116,358 字；
- 最近 6 条阅读记录时间是连续的日常节律（08:21 / 08:34 / 08:41 / 12:09 / 13:55 / 14:02 UTC），跨越整个验收窗口；
- 验收注入的 `plan` / `importBatches` 只存在于 run3 隔离根，正式 `library.json` **无 `plan` 键**；
- 正式 bookfish 下 `batches/` `import-batches/` **均不存在**。

> 若要求绝对零字节变化，需在验收前关闭正式宿主。本轮授权方案明确选择「不关正式宿主 + 隔离数据根」，故该变化在预期之内。

### 事后复核（正式宿主于 22:29:19 正常退出）

验收结束后正式宿主被**手动退出应用**（`data/logs/core.log`：`开始关机(应用退出)` → 7 步 `关机 ✓ …` → `===== exit 0 =====`），属正常关机，与本轮回收 run3 无关（run3 整树已于 22:14 停止，PID 无关联）。

退出状态下复核：

- `library.json` 12 本正式藏书全在，无 `plan` / `importBatches` 键，无 `验收` 痕迹；
- `history.sqlite` 3188 行，与验收前一致；
- `library.json` / `reading-budget.json` 哈希与 22:06 相同，**未再变动**；
- 文件数 10029 → 10027：`writer.lock`(144 B) 与 `writer-lock.sqlite-journal`(512 B) 在正常关机释放写锁时被删除，**是锁释放的正常行为，不是数据丢失**。

详见 `host-acceptance/evidence/post-formal-hashes.txt` §6。

---

## 5. `not_observed` 更新

| # | 项 | v1.5 原状态 | 本轮结果 |
| --- | --- | --- | --- |
| A1 | 真实宿主批量导入页 | not_observed | **已观察**（17 步全程真机） |
| A2 | 真实系统文件选择器 | not_observed | **已观察**（CDP `DOM.setFileInputFiles` 注入真实文件路径） |
| A3 | **真实 ZIP64 归档** | not_observed（仅手工夹具） | **已观察**（Python zipfile 生成 65,545 条目真 ZIP64，经典 EOCD 打 `0xFFFF` + 合法 ZIP64 EOCD 已断言）；**但同时发现 Worker 上限使第二道检查不可达（§3-A）** |
| A4 | **真实 > 8 MiB 中央目录** | not_observed（夹具靠 65,520 B comment 堆） | **已观察**（400 条目 × comment 撑到 9.3–10.4 MB，走通第二道检查） |
| A7 | 真实 rename 失败 | not_observed | **仍未观察**（ACL 在 Administrator 下被绕过，§3-E）→ 保持 not_observed，以 `import-batch-rename-retry.test.ts` 6/6 为替代 |
| A10 | 120 本名单滚动展开 | not_observed | **已观察**（`涉及书目：books/B100.txt、B101…` + `超出单批 100 本上限 20 个（…）`） |
| A11 | 真实用户库升级后显示 | not_observed | **已观察**（注入 v1.2 时代 plan，显示下界而非总数） |
| A14 | 解压炸弹端到端 | not_observed | **部分观察**（真 ZIP64 超高条目数被 Worker 拒 → `zip_too_many_entries` 真实触发） |
| A15 | 慢磁盘实时体验 | not_observed | **已观察**（10.6 MB / 400 条目解压 + SHA-256，UI 显示 `解压峰值占用 11.3 MB`） |
| A16 | Worker 中止时 `books: null` 观感 | not_observed | **已观察**（UI 显示「压缩包声明 **未知** 本 / 未知 字节」，不推算不填 0） |
| A5/A6/A8/A9/A12/A13 | — | not_observed | 仍未观察（不在本轮范围） |

---

## 6. 截图索引

截图（28 张，3.7 MB）保留在验收工作区 `E:\zcdfy\Coopanion\v15-acceptance\evidence\shots\`，未入包以免撑大仓库。

| 步骤 | 文件 |
| --- | --- |
| 2 | `step02-normal-zip-00-before.png` / `-01-preview.png` / `-02-done.png` |
| 3 | `step03-normal-nested.png` |
| 4 | `step04-zip64-101.png` |
| 5 | `step05-zip64-120.png` |
| 5b / 5c | `step05b-bigcd-101.png` / `step05c-bigcd-120.png` |
| 6 | `step06-bigcd-150.png` |
| 7 | `step07-oversize.png` |
| 8 | `step08-reopen-panel.png` |
| 9 | `step09-after-restart.png` |
| 10 | `step10-truncated-first-fail.png` |
| 11 / 12 | `step11-folder-mixed.png` / `step12-folder-alljpg.png` |
| 13 | `step13-tamper-archive.png` |
| 14 | `step14-rename-fail.png` |
| 16 | `step16-legacy-plan-stats.png` |

文本证据全部入包：`docs/reading-plan-v1.5/host-acceptance/evidence/`（31 个文件，127 KB）。

---

## 7. 复现方式

```
E:\zcdfy\Coopanion\v15-acceptance\
  gen_assets.py                 素材生成（Python zipfile，UTF-8 名 + ZIP64 + 大中央目录）
  lib-entry.mjs                 公共入口（openShelf / snapshot / waitText / saveEvidence）
  cdp.mjs                       CDP 封装（Node 22 内置 WebSocket/fetch）
  ui.mjs                        文件注入（DOM.setFileInputFiles，不手动 dispatch）
  launch.sh <rootName> [port]   隔离启动（CORTICO_COMPANION_DATA）
  reset_run3.sh <rootPid>       整树停止 + 清批次（taskkill //T //F //PID）
  step00..step16                17 步脚本
  probe-plan2.mts               素材判定（复制到包根跑 npx tsx）
  assets/ evidence/ shots/
```

**关键操作纪律**（踩过的坑）：

1. 停实例必须 **整树**：`taskkill //T //F //PID <root>`。只杀 core 的话 Electron 主进程会重新拉起 core 并抢回端口。
2. 端口占用会静默降级（17789 → 17790），脚本若写死 17789 会打到别实例。启动后必须核对日志里的实际端口。
3. `DOM.setFileInputFiles` **自带原生 `change` 事件**，再手动 `dispatchEvent` 会生成两条批次（1 空壳 + 1 真实）。
4. 素材必须用 Python `zipfile`，不能用 `tar.exe`（GBK 书名乱码）。