# Issue #2 独立写锁设计与验收计划

基线：BookFish 0.63.0，提交 c440c03，独立 worktree / 分支 codex/issue-2-writer-lock。
范围：独立锁模块、OS 进程身份查询、Library / World 生命周期清理和测试。LibraryState、library.json、HistoryStore / StoryStore 数据结构与业务、阅读/导入/SSM 算法不变。没有模型调用，无需 Token A/B。

## 所有权

writer-lock.sqlite 的 DatabaseSync 连接通过 PRAGMA busy_timeout=0 + BEGIN IMMEDIATE 持有整个书库生命周期。失败立即给出占用/权限/恢复信息，临时连接关闭。此数据库无业务表、无 COMMIT、永不在运行期间删除或替换。新版之间仅 SQLite 是权威。

writer.lock 保留 pid/token/protocol/processIdentity，使用 wx 排他创建并 fsync；移除前重读完整内容和 Token，在 SQLite 写锁内执行。正常关闭先关闭业务资源，再校验删除自己的标记，再 ROLLBACK，最后关闭锁连接。标记清理失败仍尝试回滚、关闭锁连接。业务关闭失败逐项尝试其余资源，保留锁以便重试，不能提前接管。

## 旧版迁移

普通 JSON 锁必须有有效 PID 和 Token。Windows 用 Win32_Process.CreationDate 的 UTC ticks 作为真实创建身份；Linux 用 boot ID + /proc start ticks。精确身份不同或 PID 已不存在可恢复。无身份旧锁只在真实进程创建时间晚于锁文件时间（mtime / birthtime 的较早值）超过 2 秒时判定 PID 复用。此前启动、时间边界、权限不足、查询失败、损坏、非普通文件均保守失败。mtime 本身不能证明失效。新版协议标记在 BEGIN 成功后不再按 PID 判权。

标记防护覆盖正常旧版启动与新版并发；未经修改的旧版不参与 SQLite 协议，已经越过其自身失效检查、暂停在 unlink 前的旧进程仍有不可修补的旧版 TOCTOU 风险。因此升级必须先退出全部旧实例，不支持新旧版本并发迁移或运行中人工删除/替换锁文件。不能以此限制替代真实旧写者存活拒绝测试。

## 生命周期

World 启停按实例排队；启动中途失败复用停止清理路径。所有后台停止逐项尝试，失败保留书库锁；成功后不再重复运行会写文件的 stop。Library.close 可重复调用，初始化失败通过相同清理路径关闭 History / Story。

## 验证层次

1. 原 664 项基线测试；新增 Library / World 故障与独立子进程测试、双端类型、SSM guard 与保护文件哈希。
2. 官方 describe/check；安装版 Coopanion Core 的隔离数据目录验证。
3. Windows 11 + Coopanion 真实启停和数据完整性。当前本机实际为 Windows 10 Pro 19045、Coopanion 0.2.21，不能声称第三级 Windows 11 通过。

PID 复用证据采用保留旧锁、替换成后启动的真实无关进程 PID 的确定性重建；真实 CIM 查询，无进程查询模拟。不宣称观测到内核自然复用同一 PID。强杀必须是真实持锁进程，不能用抛异常代替。
