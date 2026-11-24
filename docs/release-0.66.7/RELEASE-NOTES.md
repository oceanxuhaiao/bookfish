# BookFish 0.66.7 发布记录

发布日期：2026-11-25（Asia/Shanghai）
发布提交：`baf6149`（`main`）
标签：`v0.66.7`
npm：`cortico-world-bookfish@0.66.7`（latest）
GitHub Release：<https://github.com/oceanxuhaiao/bookfish/releases/tag/v0.66.7>
市场同步 issue：<https://github.com/Pal-AI-Lab/cortico-extensions/issues/1151>

## 产物

| 项 | 值 |
| --- | --- |
| npm tarball | `cortico-world-bookfish-0.66.7.tgz` |
| 文件数 | 156 |
| 压缩后 | 2,293,735 字节 |
| SHA-256 | `dc8adbbc41f90409f53db2bb10422998b0650e80aa4452a14b234df432fb4e3b` |
| npm shasum (SHA-1) | `bf5144c91ed6ba7f5da30553137817fb4402194d` |
| GitHub Release 资产 | 同名 `.tgz`，重新下载后大小与 SHA-256 与上表一致 |

## 修复

- 扫描版 PDF 不再被当成正文导入：旧逻辑只看全书总字数，335 页的扫描书只要最后一页带一段打包说明（DuXiu / Anna's Archive 的说明与 PDG 转换回执，约 4000 字）就能过关，334 页扫描图被静默丢掉，打开只剩那段说明和乱码。现在按“有文字的页数占比”判断，低于一半即判为扫描版并拒绝导入。
- 拒绝信息写明页数（`No text layer: only 1 of 335 pages…`，面板中文为“这个 PDF 是扫描图：335 页里只有 1 页有文字……”），并提示先用 OCR 或改导入 TXT/EPUB。
- 打包方附加的说明页（Anna's Archive / DuXiu / `pdg_` 元数据）整页跳过，不再混进正文最后一段；需同时命中两处特征才判定，正文提及不受影响。
- 正常文字版 PDF 照常导入：个别空白页、插图页或扫描插页不会因此被拒。
- 不改变阅读、SSM、Persona、书架、足迹与 Token 策略。

## 验证

- 全量测试：101 个测试文件 / 1113 通过 / 1 平台跳过（0.66.1 为 1107 通过；本次新增 6 项 PDF 回归）。
- 双端 `tsc --noEmit`：0 错误；重跑 `build:webui` 后 `lib/webui.js`、`lib/webui-txt-builtin-bing-0651.js`、`lib/import-worker.mjs`、`lib/zip-worker.mjs` 与提交内容一致（git blob 相同）。
- `check:help`：通过（`package 0.66.7`、7 分类、20 指南、11 版本、4 进度项、13 条在线动态，当前版本动态存在）。
- 官方 `describe:extension` / `check:extension`：通过（16 工具 / 10 事件 / 1 提示，`world v6`，WebUI 页面 `world:bookfish`）。
- 真机（本机已装 0.66.7 试用构建，证据 `bookfish-pdf-scan-fix/output/acceptance-20261125/host-import.json`）：
  - 文件：335 页扫描版《夜航西飞》，64,196,717 字节，分 245 块上传；
  - 上传 8,801ms、拒绝判定 890ms，总计 9,691ms；
  - 返回 `No text layer: only 1 of 335 pages…`，`state=failed`；
  - 书架 12 本 → 12 本，`libraryUnchanged=true`，未出现导入标题。
- 在线动态：发布前已把 `announcements.json` 推到 `main`（blob `43360a9`），Raw 地址复核含 0.66.7 条目。
- 正常文字版 PDF：本次由测试夹具覆盖（含空白页/插图页），未重跑真实文字版 PDF 的书架导入。

## 版本说明

0.66.2–0.66.6 没有发布到 npm，仅用于本机试装/候选构建；本次直接发布 0.66.7。

## 已知边界

- 与 0.66.1 相同：浏览器辅助 TXT 仍为实验性、默认关闭；单批预览上限 50 条；搜索为 LIKE 扫描，10 万条未压测；足迹查询只读、不新增模型调用。
- 扫描判定按页覆盖率：图册/漫画类“几乎全是图、只有少量文字”的 PDF 会被判为扫描版拒绝；需要时先 OCR。
- 浏览器自主获取 TXT 的新改动（章节批次、有界探索、WAL 原型）未包含在本版本。
