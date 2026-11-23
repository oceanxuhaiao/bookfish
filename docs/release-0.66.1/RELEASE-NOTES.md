# BookFish 0.66.1 发布记录

发布日期：2026-11-23（Asia/Shanghai）
发布提交：`ab3196c`（`main`）
标签：`v0.66.1`
npm：`cortico-world-bookfish@0.66.1`（latest）
GitHub Release：<https://github.com/oceanxuhaiao/bookfish/releases/tag/v0.66.1>
市场同步 issue：<https://github.com/Pal-AI-Lab/cortico-extensions/issues/1111>

## 产物

| 项 | 值 |
| --- | --- |
| npm tarball | `cortico-world-bookfish-0.66.1.tgz` |
| 文件数 | 155 |
| 压缩后 | 2,289,497 字节 |
| SHA-256 | `85a7dbc18d478810a101c9af93ebcebd8d0a8e8dd26c2a3a798fdec4581d895d` |
| npm shasum (SHA-1) | `1ae0e289450bba64bba0496ac6c7c2ca5dfabee2` |
| GitHub Release 资产 | 同名 `.tgz`，下载 SHA-256 与上表一致 |

## 修复

- 停在阅读足迹最新一页（最新在前第 1 页，或最早在前最后一页）时，不再显示“大肥鱼新增了 N 条足迹”的提醒；这一页本来就看得到最新记录，提醒会挡住列表。
- 翻到更早的页面时提醒才出现；点「回到最新」看到新记录后提醒自动隐藏。
- 离开阅读足迹页面时立即收起提醒，不再残留在列表顶部。
- 不改变足迹数据、阅读进度、搜索与讨论行为。

## 验证

- 全量测试：101 文件 / 1107 通过 / 1 跳过。
- 主/Web `tsc --noEmit`：0 错误；WebUI 构建通过。
- `check:help`：通过（20 指南、10 版本、4 进度项、12 条在线动态）。
- 官方 `describe:extension` / `check:extension`：通过。
- 真机 0.66.1（918 条足迹，head 932，边界 931）：
  - 最新在前第 1 页：提醒 `hidden=true`；
  - 翻到第 2 页：提醒出现，文案“大肥鱼新增了 1 条足迹”；
  - 点「回到最新」：回到第 1 页，提醒再次隐藏。
- 帮助页显示当前版本 0.66.1，阅读足迹指南包含“最新一页不会出现提醒”的新说明。

## 已知边界

与 0.66.0 相同：浏览器辅助 TXT 仍为实验性、默认关闭；单批预览上限 50 条；搜索为 LIKE 扫描，10 万条未压测；足迹查询只读、不新增模型调用。
