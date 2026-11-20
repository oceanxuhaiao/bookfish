# Issue #2 验收报告（2026-11-21）

**状态：实现和本机验证已完成；整项任务尚未达到全部验收条件。**

基线是 BookFish **0.63.0 / c440c03**，分支 `codex/issue-2-writer-lock`，代码在 Cortina 的 `state/packages/bookfish-issue-2-writer-lock/` 独立 worktree。原 `cortico-world-bookfish/` 的未提交 SSM 工作未修改。未推送、未发布、未安装或修改真实用户实例。

## 修改文件

| 文件 | 内容 |
|---|---|
| src/writer-lock.ts | 独立 SQLite 写事务锁、旧锁迁移、Token 标记、错误映射与最终释放 |
| src/process-identity.ts | Windows CIM 创建时间身份；Linux /proc 身份；失败保守处理 |
| src/library.ts | 委托独立锁；初始化失败清理；业务资源关闭后才释放锁；重复 close |
| src/world.ts | 启停排队；统一失败清理；所有后台资源逐项停止；失败保留锁并阻止直接重启 |
| tests/library.test.ts | 新增 19 项锁、跨进程、查询错误与生命周期测试 |
| tests/fixtures/writer-lock-child.ts | 独立持锁/旧版 JSON/无关进程夹具 |
| scripts/verify-writer-lock-host.mts | 安装版 Coopanion Core 隔离启停、强杀与合成数据完整性验证 |
| describe.json | 官方重新生成。0.63.0 原文件存在既有 lookup 说明不同步，恢复旧文件后官方 check 实测失败，故保留生成结果；另有提示词 CRLF 的序列化差异，无源提示词/Schema 修改 |
| docs/writer-lock/、evidence/writer-lock/ | 设计、报告、原始日志和进程证据；隔离运行数据不提交 |

未修改 LibraryState、library.json Schema、HistoryStore / StoryStore 代码、阅读/进度/足迹/小说导入/正文逻辑及 SSM 算法。没有调用模型，没有 Token 优化效果声明。

## 原锁与新锁

原锁只保存 PID/Token，用 kill(pid,0) 认定主人存活；崩溃后残留，PID 复用时永久拒绝启动；正常关闭先删标记再关业务数据库，有提前接管窗口。

新版打开独立 `writer-lock.sqlite`，设 `busy_timeout=0`，通过 `BEGIN IMMEDIATE` 在整个 Library 生命周期持有事务和连接。其他新版立即收到包含锁路径、可获得 PID、占用原因和恢复步骤的错误。进程死亡后 SQLite 文件锁释放。正常关闭顺序是业务资源 → Token 校验删除兼容标记 → ROLLBACK → 关闭锁连接。某业务资源关闭失败不阻碍其余资源的关闭尝试，但保留写锁直至成功重试。标记清理/回滚失败也继续尝试关闭锁连接。

SQLite 数据库与 history.sqlite 完全独立，无业务表、无业务迁移。运行时不得人工删除或替换锁数据库。

## 旧锁迁移与恢复

- 保留 writer.lock 作为旧版兼容屏障，仍有 PID/Token，增加协议和真实创建身份。wx 创建、fsync，删除前重读原始内容与 Token。
- 无新版协议的旧锁必须有效；PID 已不存在才可回收，或精确创建身份不同可确认 PID 复用。
- 无创建身份的旧锁只在真实进程创建时间晚于锁文件较早的 mtime/birthtime 超过 2 秒时回收。文件时间单独不构成回收依据；enabled 状态不参与判断。
- 进程早于锁文件、时间精度边界、EPERM、CIM 查询失败、损坏 JSON、无效 PID/Token 均保守失败。错误提示先退出其他实例，核对任务管理器启动时间；必要时全部退出并备份后检查/移走 writer.lock，不清书库、不删除 SQLite 数据库。
- 新版标记不作为新版所有权依据。即使标记 PID 仍存活，成功取得 SQLite 写事务后仍可恢复。

**旧版边界：**未经修改的旧版不参加 SQLite 协议，其既有 stale-check/unlink 和先删锁后关资源的竞争无法由新版单方面消除。升级应先退出全部旧实例；不保证任意新旧版同时迁移或旧版已越过检查后暂停再恢复的安全。正常旧版活写者拒绝接管已由真实子进程验证。新版本之间由 SQLite 保证单写者。

## 验证结果

| 项目 | 实际结果 |
|---|---|
| 原基线 | 63 文件 / 664 项通过 |
| 最终全量 | 63 文件 / 683 项通过（原测试保留，新增 19 项） |
| 双端 TypeScript | 通过，无诊断 |
| 官方 describe | 15 工具 / 10 事件 / 1 提示词 |
| 官方 check | Extension check passed |
| SSM guard | blocked=0；共享 library/world/describe 共 3 项 review，按本任务明确授权登记范围与理由 |
| SSM 保护文件 | 9 个 tracked blocked 文件 Git blob 与 c440c03 全部一致；共享改动逐 hunk 仅锁/生命周期及生成说明 |
| Windows 独立子进程 | 双实例互斥、正常关闭重取、强杀恢复、旧 JSON 活写者拒绝、同时启动恰一成功，通过 |
| PID 复用 | 旧锁 + 后启动的真实无关 PID + 真实 CIM 创建时间，恢复成功；另有精确创建身份不同的测试 |
| 初始化/关闭故障 | History/Story 初始化后故障均清理；关闭故障保留写锁并继续关闭其他资源；Token 替换不误删；ROLLBACK 故障仍关连接；失败临时连接关闭，通过 |
| 查询故障 | EPERM、返回无创建时间、查询异常、无法确认时间边界均保守失败，错误包含原因与安全恢复步骤 |
| 安装版 Coopanion Core | 0.2.21 实际安装程序的 Core + 独立部署，四次开关、World restart、Core 强杀重启恢复 active，通过 |
| 合成数据完整性 | 1 本书、已确认进度、足迹与 1 条故事记录在 Core 强杀重启前后语义快照相等 |
| Windows 11 + 桌面 UI | **未完成**：本机实为 Windows 10 Pro 19045，不具备 Windows 11；未操作 Electron UI |
| 真实用户书库升级完整性 | **未完成**：真实书库未安装候选，不能以合成副本测试替代真实数据验收 |

原始记录见 `evidence/writer-lock/full-tests.log`、`typecheck.log`、`extension-check.log`、`ssm-guard.log`、`protected-hashes.json`、`windows-environment.json`、`windows-processes.json`、`coopanion-host.json`、`coopanion-core.log`。开发中曾发现 ESM 全局函数不可 spy、夹具文件名写错、宿主脚本 Windows --import 路径需 file URL、重复引用必须带 start；均修正夹具/脚本后复测，最终结论仅引用最后通过记录。

PID 复用是可重复的故障条件重建，没有等待或观测到内核自然复用同一个 PID，不能称为自然 PID 回收实测。强制终止是真实 Windows 进程 SIGKILL，具体 PID、实际创建时间和接管结果见下方关键证据。

## 失败场景与剩余风险

1. 权限/CIM 不可用或旧锁时间不确定时会阻止启动；这是保守保护，按错误提示退出所有旧实例后备份检查。
2. 业务资源关闭失败会保留锁；重试 stop/close 或退出进程可恢复，不能让另一实例提前接管。
3. 标记被人工改写/删除、SQLite 锁文件被替换、旧版并发迁移不属于可保证的运行条件。不能据本轮保证网络文件系统或不遵守本地锁语义的存储。
4. Windows 查询为同步调用，当前进程成功身份按进程缓存；旧锁查询超时上限 10 秒。新版实际竞争使用 SQLite 立即失败。未做延迟性能基准。
5. Linux 实现未实机验证；其他平台尚无旧锁进程身份查询，存在旧 JSON 锁时保守失败。新版无旧锁时仅用 SQLite 判权，当前进程身份查询不可用也能正常建立兼容标记，不以自身查询失败阻止 SQLite 单写者。
6. 尚缺 Windows 11 + 目标 Coopanion 桌面实例、真实书库备份/安装/启停/强杀恢复后的数据验收。因此不得关闭 Issue 或宣称全部完成。

## 后续验收步骤

在 Windows 11 上备份真实部署与整本书库，停止所有旧实例，再安装本候选。执行双端类型、全量测试、官方检查以及本报告的进程测试；在桌面界面连续停用/启用、正常退出/重开，核对书籍键、已读前沿、足迹和故事记录。再在隔离真实数据副本执行持锁进程强杀与 PID 复用条件重建，保存日志。通过后才可认定任务全部完成；发布另行执行。

实现依据：[Node SQLite](https://nodejs.org/api/sqlite.html)、[SQLite 事务](https://www.sqlite.org/lang_transaction.html)。

## 本轮关键证据摘要

- Library 持锁子进程 PID **36292** 被 SIGKILL，退出记录 `[None, 'SIGKILL']`；原兼容标记仍在，随后独立实例成功获取 SQLite 写锁。完整顺序见 windows-processes.json。
- 旧锁原主人 PID **40348** 已终止；残留锁改指向真实无关 PID **38976**，该进程真实创建时间为 **1795193848896 ms**，旧锁 mtime **1795193838896 ms**；新实例 PID **36900** 成功接管。真实 CIM 身份 `win32:639307906488964140`。此项为故障条件重建，不是自然 PID 回收观测。
- 安装版 Coopanion Core PID **37316** 被 SIGKILL 后重开，BookFish 实际 active，合成书库/足迹/故事记录快照相同。独立部署端口 **17992**，无模型凭证、没有模型请求。

依赖说明：本轮复用同机既有 node_modules（目录 junction），没有宣称完成冻结依赖重装。最终执行两端 tsc、worker 构建后的 vitest 全量运行，以及官方 describe/check；产物构建引起的 worker/lockfile 无关差异已恢复。Node 为 v24.14.1，Vitest 为 2.1.9。
