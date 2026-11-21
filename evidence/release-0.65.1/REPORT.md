# Bookfish 0.65.1 发布记录

日期：2026-11-21。发布在线开发动态与宿主端兜底修复。

## 发布

- npm：`cortico-world-bookfish@0.65.1`，latest 已指向 0.65.1；shasum `dd79d27c06f3e2549503183f0c1e19e5153e81f8`。
- GitHub：标签 `v0.65.1` 指向 `d34717c`，Release 附带同一 tgz；资产 digest `sha256:14eca6fd36cf0441cad6e28224132b9ccd6e32fa3c7cca5add1453c3472940f9`。
- 扩展市场：issue #1069 已关闭，回执“已收录 0.65.1”；catalog 版本核对为 0.65.1。
- 本地 tgz 与 npm 下载 tgz SHA-256 均为上述 digest。

## 内容

- 在线开发动态页签；GitHub `announcements.json`（main `147a089`）。
- WebUI 直连失败时宿主端 `help_online` 兜底；真实宿主拦截浏览器 Raw 请求后仍显示 8 条。
- 失败时只显示明确标记的「版本更新（内置）」卡和原因，不与在线条目混淆。
- 在线条目为蓝色时间线卡片。
- 718 项测试、双端 typecheck、WebUI 构建、`check:help`、官方 describe/check 通过。

## 真实宿主

真实 Coopanion 0.2.23，17788，`0.65.1 loaded`；在线成功 8 条、浏览器直连被拦截时宿主兜底成功、书架与阅读数据未变。

## 未覆盖

- 真实宿主上“改 GitHub 数据后刷新出现新条目”未重复做；浏览器 harness 已做。
- GitHub Raw 约 5 分钟缓存。
