# Bookfish 0.64.8 发布记录

日期：2026-11-21。用户明确授权把当前版本发布到 npm、GitHub 和扩展市场，并把本次「帮助与更新」界面更新标记为需要提醒的重要更新。

## 发布内容

- npm：`cortico-world-bookfish@0.64.8`，latest 已指向 0.64.8。
- GitHub：main 快进到 `63ac768`，标签 `v0.64.8` 指向同一提交，Release 附带同一 tgz。
- 扩展市场：`[sync] cortico-world-bookfish` issue #1065 已由维护流程关闭，回执确认收录 0.64.8。
- 重要公告：`bookfish-help-center-0.64.8`，`majorAnnouncement: true`，真实宿主已目击「大肥鱼有新变化啦！」Banner。

## 校验

- npm 0.64.8 的 shasum 为 `29fda9f8da4c5bcfc3f79c2547556b6d81a576b6`，integrity 与本地包一致。
- npm 下载 tgz 与本地 tgz 的 SHA-256 均为 `6b3bc882419a824d69e557308971f463a393ed3e5bfc7496cdf22ce1918584ed`。
- GitHub Release 资产 digest 与上述 SHA-256 一致。
- 709 项测试、双端 typecheck、WebUI 构建、`check:help`、官方 describe/check 均通过。

## 说明

- npm 发布时遇到浏览器 2FA 流程和 staged 版本传播延迟；最终通过带 bypass 2FA 的 token 完成，0.64.8 在传播完成后成为 latest。
- 市场索引文件的 raw.githubusercontent.com 仍有 CDN 旧缓存，用 GitHub contents API 核对已是 0.64.8；回执说明 WebUI 约 10 分钟内显示。
- 发布后 main 只增加本证据提交，不再改变已发布的 0.64.8 代码。
