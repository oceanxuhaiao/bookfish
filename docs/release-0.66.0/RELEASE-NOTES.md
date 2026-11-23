# BookFish 0.66.0 发布记录

发布日期：2026-11-23（Asia/Shanghai）
发布提交：`76f532a`（`main`）
标签：`v0.66.0`
npm：`cortico-world-bookfish@0.66.0`（latest）
GitHub Release：<https://github.com/oceanxuhaiao/bookfish/releases/tag/v0.66.0>
市场同步 issue：<https://github.com/Pal-AI-Lab/cortico-extensions/issues/1092>

## 产物

| 项 | 值 |
| --- | --- |
| npm tarball | `cortico-world-bookfish-0.66.0.tgz` |
| 文件数 | 155 |
| 压缩后 | 2,288,542 字节 |
| SHA-256 | `bb0a6509af315fa871d106c83fdbd9fe04edeaa47010d0e1e5c256d1c6684123` |
| npm shasum (SHA-1) | `619d681fdd7d8af246835af21391d55a7ad9d133` |
| GitHub Release 资产 | 同名 `.tgz`，下载 SHA-256 与上表一致 |

## 内容

- 阅读足迹看板：全部书籍/单本、最新/最早排序、每页 5/10/20/50、双向翻页、回到最新、位置记忆。
- 足迹关键词搜索：触发/感想/前判/理由/心情/人物/问题，多词 AND，结果继续分页。
- 新足迹提醒与临时预览；单批超过 50 条时明确“显示 50 条”。
- 跨书讨论使用记录所属书籍；修复“最早在前”跳到末页。
- 浏览器辅助 TXT：跟随重定向、允许所有网站、可选真实标签页、再跟一层下载页。

## 验证

- `check:help`：通过（20 指南、9 版本、4 进度项、11 条在线动态）。
- 全量测试：101 文件 / 1106 通过 / 1 跳过。
- 主/Web `tsc --noEmit`：0 错误。
- 官方 `describe:extension` / `check:extension`：通过（工具 16、事件 10、提示词 1，world API 6）。
- `npm pack`：155 文件，2,288,542 字节。
- 真实宿主：安装 npm tarball 0.66.0，manifest 为 `/0.66.0/webui-txt-builtin-bing-0651.js`；帮助页显示“阅读足迹看板”及新指南全文；在线动态首条为 0.66.0 足迹条目。

## 已知边界

- 浏览器辅助 TXT 获取仍为实验性、默认关闭，需要安装扩展并授权来源。
- 单批新增预览上限 50 条；超出部分不自动展示。
- 搜索为 `json_extract + LIKE` 扫描；2000 条约 30 ms，10 万条未压测。
- 足迹查询只读，不新增模型调用。

## 安全提醒

发布过程中使用本机 git 凭据调用 GitHub API；该 OAuth token 在一条检查命令的输出中被回显。发布完成后应立即在 GitHub 设置中撤销/轮换该 token，并重新登录 git/gh。
