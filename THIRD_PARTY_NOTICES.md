# 第三方组件与非原创内容声明

本文件说明 Bookfish 扩展中哪些内容属于原创代码，哪些来自第三方，以及它们各自适用的许可证或权利边界。

**结论先说：**

- **Bookfish 扩展自身的原创代码**采用 **MIT**，见 [`LICENSE`](LICENSE)。
- **小说引擎运行时不是 MIT**，也不包含在 npm 扩展包内；它包含 **AGPL-3.0** 的 so-novel 和 **GPLv2+CE** 的 Temurin JRE。
- **小说正文、书源网站内容、品牌图、QQ 群二维码、第三方依赖**不自动适用 MIT，详见下文。
- MIT 只覆盖原创代码，不覆盖运行时、正文、书源规则/网站内容、图片、二维码或依赖。

## 1. 小说引擎运行时（不在 npm 包内）

扩展通过“一键安装”或离线 ZIP 安装一个独立的 Windows x64 运行时。npm 包本身不包含这个约 85 MB 的 ZIP。

| 组件 | 版本 / 对应源码 | 许可证 | 说明 |
|---|---|---|---|
| so-novel | v1.12.0，commit `88acec6ee489ca1c2489c624cedd1ef417d3f3ee`；https://github.com/freeok/so-novel | **AGPL-3.0** | 上游小说搜索、目录、章节解析和下载引擎。 |
| Eclipse Temurin JRE | 21.0.8+9-LTS；https://github.com/adoptium/jdk21u/tree/18dfe1e4938d | **GPLv2 with Classpath Exception** | 运行时内置的 Java 运行环境。 |
| Bookfish bridge | `bookfish-bridge-bf1-source.tar.gz` | Bookfish 原创适配代码 | `SonovelBridge.java` 只读调用 so-novel 的 SearchParser/TocParser/BookParser，不修改上游源码。 |

运行时 Release：

- https://github.com/oceanxuhaiao/bookfish/releases/tag/runtime-1.12.0-bf1
- 包含运行时 ZIP、so-novel 对应源码、Bookfish bridge 源码、`SHA256SUMS`、`sbom.json`、`RELEASE-NOTES.md`
- 运行时说明：https://github.com/oceanxuhaiao/bookfish/blob/main/runtime/README.md

再分发运行时必须保留 ZIP 内的版权、LICENSE、NOTICE、SOURCE 文件并提供对应源码。不要把它当作 MIT 内容再分发。so-novel 与 bridge 组合分发时的 AGPL 边界仍需法律确认；本文件不是法律意见。

## 2. 书源网站与小说正文

扩展支持的书源是第三方公开网站，例如：

- 笔趣阁365
- 第八中文网
- 新笔趣阁小说网
- 香书小说
- 悠久小说网
- 少年小说网
- 笔尖中文
- 阅读库

这些网站、其页面结构、书源规则和站点内容由各自权利人提供，**不属于 Bookfish 原创内容**，也不适用本项目的 MIT 许可证。

抓取到的小说正文版权归原作者、出版方或相应权利人所有。Bookfish 只把用户主动选择获取的正文缓存在本机，用于该用户的阅读、讨论和读后感；不声称拥有正文版权，不把正文打包进 npm 包，也不对外分发正文。公开可访问不等于已获转载/商用授权，部署者仍需自行判断来源用途和当地法律。

## 3. 品牌图、角色图与二维码

| 内容 | 位置 | 说明 |
|---|---|---|
| Logo | `assets/branding/logo.png` | 由项目维护者提供给 Bookfish 作为市场图标；不声明为第三方图库素材。 |
| 宣传海报 | `assets/branding/poster.jpg` | 由项目维护者提供给 Bookfish 作为宣传图；包含项目角色“大肥鱼”的插画。 |
| QQ 群二维码 | `src/webui/qq-group.ts`（内嵌 data URI） | 由 QQ 群主/项目维护者提供，仅用于加入反馈群；不是 MIT 代码素材。 |

这些图片用于本扩展的识别、展示和反馈，不自动授权他人单独转载、商用或用于其他项目。若权利人认为某张图不应以当前方式使用，请通过 GitHub Issues 联系，我们会核实并调整。图片的具体来源说明见 [`assets/branding/SOURCE.md`](assets/branding/SOURCE.md)。

## 4. npm 依赖

npm 包运行时会安装以下第三方依赖，它们不是 Bookfish 原创代码：

| 依赖 | 许可证 | 用途 |
|---|---|---|
| `cheerio` | MIT | HTML 解析 |
| `ipaddr.js` | MIT | IP 地址/网段判断 |

开发依赖（TypeScript、Vitest、esbuild 等）不进入 npm 运行时依赖；其许可证以各自包为准。

## 5. 原创部分

以下内容为 Bookfish 原创代码，除非另有标注，适用 MIT：

- World 定义、工具、事件与阅读协议
- 书架、阅读进度、手账、讨论、读后感、分享的实现
- 完整性校验、分卷感知、运行时安装/校验/激活逻辑
- WebUI 面板、反馈页和品牌展示代码
- `SonovelBridge.java` 适配代码

## 6. 与官方的关系

Bookfish 是第三方 Coopanion/Cortico 扩展，不代表 Pal AI Lab、Cortico、Coopanion、so-novel 或 Temurin 官方背书。扩展市场中的认证/标签以市场维护者的实际审核结果为准。

---

最后更新：2026-11-11。若发现遗漏或错误归属，请提交 GitHub Issue：https://github.com/oceanxuhaiao/bookfish/issues
