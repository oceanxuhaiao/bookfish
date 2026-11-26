# BookFish 0.67.0 发布记录

发布日期：2026-11-26（Asia/Shanghai）
发布提交：`b962748`（`main`）
标签：`v0.67.0`
npm：`cortico-world-bookfish@0.67.0`（latest）
GitHub Release：<https://github.com/oceanxuhaiao/bookfish/releases/tag/v0.67.0>
市场同步 issue：<https://github.com/Pal-AI-Lab/cortico-extensions/issues/1167>

## 产物

| 项 | 值 |
| --- | --- |
| npm tarball | `cortico-world-bookfish-0.67.0.tgz` |
| 文件数 | 166 |
| 压缩后 | 2,560,329 字节 |
| 解压后 | 5,916,236 字节 |
| SHA-256 | `9ae5e06bf4b84f04a6674fdc25e97b572d8ed05680526d7dd166aa814addd1b5` |
| npm shasum (SHA-1) | `3bfb907703d8a1c4aa9819f471849c5c8cd40a23` |
| GitHub Release 资产 | 同名 `.tgz`；上传返回的 `digest` 为 `sha256:9ae5e06b…addd1b5`，与本地一致 |
| npm 远端 tarball | 重新下载后 SHA-256 与本地一致 |

## 新增

- 书架顶部「＋ 推荐书籍」改成抽屉，分「本地导入」和「在线找书」；本地导入支持单本、多本、整个文件夹和一个 ZIP。
- 导入三步：选文件 → 确认清单（可逐本取消）→ 看结果。详细报告给出进批、入库、失败、取消和未导入的数量与原因；失败项可单独重试，后台批次关掉抽屉或重启宿主后保留记录。
- 上限：单本 100 MiB、整批 1 GiB、单批 100 本。文件夹或 ZIP 触发上限或读不出可信数量时整包拒绝，不部分导入，原压缩包保留。
- 新增「阅读顺序」：从「正在读」页打开抽屉，当前书固定，后续书可拖动、上移下移、移到最后、设为下一本、暂时跳过或移出；「读完后按顺序继续」默认开启，读完并满足条件后自动接下一本。
- 导入完成后可选择把书加入阅读顺序，默认不勾选、不自动开始读；书籍详情可单本加入。
- 帮助中心新增「阅读顺序」指南，重写「导入一本或多本书」，同步书架、按书名或作者找书、连载追更、浏览器辅助 TXT 获取与开发进度；`releases.json` 记 0.67.0，`announcements.json` 新增 0.67.0 在线动态。

## 变更与兼容性

- 移除宿主与内部导航里的独立「阅读计划」页（宿主面板为 6 个）；原计划接口与存储保持兼容。
- 移除书架上重复的旧排队投影；当前无在读的书但书架非空时不再声称书架为空。
- 在线找书去掉「文件导入」选项；浏览器辅助 TXT 获取的入口暂时收起，底层模块与既有配置保留，后续版本再开放。
- 数据布局升到 8：升级自动迁移，计划与导入批次为空；0.66.7 及更早版本无法打开布局 8，降级前先用本版本导出备份。
- 模型侧只把 `bookfish_get_status.plan` 作为只读投影加入状态，阅读协议更新为 `reading v=4 since=0.67.0`；不新增工具、事件或模型调用，不改正文、Persona、SSM 语义与 Token 策略。

## 验证

- 全量测试：133 个测试文件 / 1385 通过 / 1 平台跳过（1386），命令 `vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=60000`，原始日志在隔离证据目录。
- 双端 `tsc --noEmit`：0 错误；`build:webui` 重新生成 `lib/webui.js`、`lib/webui-reading-order-4f0e0b336bb1.js`、`lib/import-worker.mjs`、`lib/zip-worker.mjs`，与提交内容一致。
- `check:help`：通过（`package 0.67.0`、7 分类、21 指南、12 版本、5 进度项、14 条在线动态，当前版本动态存在）。
- 官方 `describe:extension` / `check:extension`：工作区通过（16 工具 / 10 事件 / 1 提示，`world v6`，面板 6 个）；另把 npm tarball 解包后接 `node_modules` 再跑一次 `check:extension`，装载与自描述核对同样通过，Published URL 为 `/assets/extensions/cortico-world-bookfish/0.67.0/webui-reading-order-4f0e0b336bb1.js`。
- `check:ssm`：`blocked=0 review=2`（`src/library.ts`、`src/world.ts`），未 `--accept-review`。
- 包内容：`npm pack` 166 文件，只有 `src/assets/lib/extension/describe.json/README/CHANGELOG/LICENSE/THIRD_PARTY_NOTICES`，无 tests、docs、evidence、output、node_modules 或 `.env`；常见密钥形状扫描 0 命中。
- 在线动态：发布前已把 `announcements.json` 随发布提交推到 `main`，Raw 地址复核 200 且首条为 `0.67.0`。
- 真实宿主：本次发布时 Coopanion 正在运行，正式实例仍指向 0.66.7 预览目录；没有中途替换用户正在使用的实例。v1.5 的多文件导入、部分入队、设为下一本、当前书保持与持久化已在隔离真实宿主目击。

## 已知边界

- 正式实例没有在本轮切换成 npm 0.67.0；安装/更新由用户正常退出宿主后执行。
- 真实鼠标拖动手势未目击；拖动由 DOM 拖动事件测试覆盖，真实宿主目击的是「设为下一本」。文件夹与 ZIP 的完整端到端真实宿主矩阵沿用 v1.5 隔离宿主结果，本轮未重跑。
- 浏览器辅助 TXT 获取入口暂时收起；相关设置仍保留，但本版界面不可用。
- 布局 8 不支持回退到 0.66.7 打开；降级必须先用本版本导出备份。

## 版本说明

0.66.2–0.66.6 没有发布到 npm，仅用于本机试装/候选构建；0.66.7 之后直接发布 0.67.0。
