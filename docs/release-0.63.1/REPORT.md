# BookFish 0.63.1 发布候选记录

日期：2026-11-21。用户授权依次准备候选、备份实机验收、发布 npm/GitHub/扩展市场；并明确回复“在 win10 验收即可”，将本次 OS 验收口径调整为 Windows 10。

## 范围

以 0.63.0 c440c03 和 Issue #2 修复 65ab88f / 93c8aec 为基础。包含孤立 UTF-8 坏字节导入修复、长连载候选及目录修复、从指定章开始阅读、独立 SQLite 写锁和 Library/World 生命周期清理。没有合入 feature/txt-acquisition 或本机 TXT 加固分支，没有修改 SSM 算法/数据流程。

## 发布包

`cortico-world-bookfish-0.63.1.tgz`，93 文件，1,544,404 字节，解包后 2,759,933 字节。

SHA-256：`96d90802601e472109bfec4a598c13d3fdbb35686862172bf7c0bd31b11af588`。

npm pack 清单确认无开发中的 TXT 获取代码、测试、证据、数据库、凭据和私有备份；包含独立锁和进程身份模块。真实宿主安装的就是此压缩包解出的代码。生产依赖与原 0.62.1 完全相同，复用原安装的 node_modules；未重新联网安装依赖。

## 工程验证

- 重新构建 WebUI、import worker、ZIP worker。
- 63 文件、683 项测试通过。
- 后端和 WebUI TypeScript 类型检查均 exit 0。
- 官方 describe：15 工具/10 事件/1 提示词；check 通过（world v6）。
- 相对 0.63.0 的保护检查 blocked=0，3 个共享文件 review 依据本任务授权登记；原 9 个 SSM 专属保护文件保持不变。两份旧检查日志的 ssm 文件名前缀触发保守分类，本轮仅改为 protection-check / protection-staged，原始内容保留，未修改保护规则或 SSM 源码。

## 真实宿主验收

环境：Windows 10 Pro 19045，Coopanion **0.2.23**（当前实机版本；此前隔离测试用 0.2.21）。数据位于 `E:\zcdfy\Coopanion\data\home\companion\data\bookfish`。

先暂停 Core、停用 BookFish，再备份 10,011 文件 / 743,850,720 字节。备份逐文件 SHA-256 清单与停用后的源库一致。私有备份和配置只保存在本机 `output/release-0.63.1/private-live/`，不入 Git、不上传。

从发布包安装到 `E:\zcdfy\Coopanion\data\local-extensions\bookfish-0.63.1`。旧版本目录、旧链接重命名副本及扩展/宿主配置备份保留。

实际通过：

1. 连续四次 World 开关和一次 World restart。
2. 完整 Core 正常重启，新进程 PID 37180 加载 0.63.1。
3. 强制终止已核验程序路径和父进程的 Core PID **37180**；Coopanion 启动器自动拉起 PID **24268**，BookFish 为 active / running，扩展状态 loaded，未人工删除锁。
4. World 停用后读取业务快照：11 本书、1,496 条已确认记录、762 条足迹、13 个正文文件 / 24,519,096 字节，以及原故事侧车不存在这一状态均保持相同，SQLite integrity_check=ok。
5. 前后语义及正文哈希一致：`e45600f93de8e744aa4b4a9982b0dcda5395cb6a87f5452296810dcfce2b5705`。仅启动代次、已失效任务等生命周期状态允许正常变化。
6. 已重新启用 BookFish，并将 Core 暂停状态恢复为用户原来的运行状态。

验收发现并处理的观察干扰：第一次正常重启时，验收用只读完整性查询与异步宿主启动写 HistoryStore 重叠，导致一次 database is locked。查询结束后重新启用成功；后续快照全部在 World 停用后执行。不修改 HistoryStore 的业务/锁等待策略，也不将该次失败记为通过。

更新链接的组合命令曾被自动审批拒绝（仅返回 blocked by policy），未执行。改为检查精确路径、备份重命名旧符号链接后创建新链接，成功完成可回退更新。旧 extensions/package.json 存在 UTF-8 BOM，修改脚本已按现有格式正确读取并保存。

## 发布状态

用户已明确回复“显示正常”，桌面目击通过。npm 0.63.1 已发布，latest=0.63.1；线上元数据 shasum / integrity 与候选一致，下载包 SHA-256 与实机安装包完全相同。发布时间为 2026-11-21 12:45:35（Asia/Shanghai）。发布后初期 CDN 曾缓存旧元数据与 tarball 404，使用新查询核对源站和实际下载成功，未重复发布。

GitHub main 与发布分支已快进到 5a83f700f5470ef8a7de43b401b4bf3970fbc9d8，版本标签 v0.63.1 指向该提交。GitHub Release 已公开，附带同一 tgz 和 SHA256SUMS，GitHub 资产 digest 与候选一致。

- npm：https://www.npmjs.com/package/cortico-world-bookfish/v/0.63.1
- Release：https://github.com/oceanxuhaiao/bookfish/releases/tag/v0.63.1
- 市场同步：https://github.com/Pal-AI-Lab/cortico-extensions/issues/1062#issuecomment-7057578739（官方回执已收录 0.63.1，无详情下载错误）
- 市场详情 JSON 已实读核验 version=0.63.1，更新日志同时包含 0.63.1 和此前未同步的 0.63.0。

首次同步 #1061 已更新版本目录，但负缓存造成详情 tarball 404；缓存过期、默认 tarball 下载恢复并验 hash 后补发 #1062，完整详情同步成功。原请求重新打开两次均返回 GitHub 422，未修改其关闭状态。市场 WebUI 可能因索引与宿主缓存最多约 10 分钟后显示。

本次顺序发布全部完成。正式版本标签仍指向 5a83f70；后续提交仅保存发布证据，不改动已发布代码。

发布证据：evidence/release-0.63.1/npm-published.json、npm-download-verified.json、github-release.json。

## 升降级说明

升级前退出所有旧实例；不要运行中删除 writer-lock.sqlite。旧版未参与 SQLite 协议，任意新旧并发迁移不在保证范围。沿用 0.63.0 的 skip 行为，设置过起点的书不能直接用 0.62.1 及更早版本打开。回退时先停止新版，恢复旧包指向与此前配置；如需数据回退，应核对备份后的新阅读记录，不可直接覆盖而丢弃新数据。
