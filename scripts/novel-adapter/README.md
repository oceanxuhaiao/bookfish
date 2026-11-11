# so-novel 隔离适配

状态：适配器已接入 0.25.0 的 World 面板；`src/novel-engine.ts`、`src/novel-fetch.ts`、`src/novel-probe.ts` 是生产路径，`scripts/novel-adapter/` 保留受控故障与验收脚本。本目录的验收脚本只在显式指定的隔离书架和证据目录内运行，不读写用户正在运行的 Coopanion 数据；真实实例验收由单独步骤执行。

## 为什么需要独立校验

2026-11-09 的《小说获取引擎对比实测》已证明：so-novel 在永久缺章、章节分页失败时仍可能生成 TXT 并返回完成。因此适配层不把“进程退出 0 / 合并文件已生成 / SSE 进度 100%”当作完整：

- 书本身份（title / author / source / revision）由 Bookfish 匹配，不取搜索第一条。
- 每次任务只使用一个目录快照；下载后再解析一次目录，目录变化即拒绝。
- 只读取 so-novel 保留的单章 TXT（`preserve-chapter-cache=1`），逐章核对目录项。
- 笔趣阁365另做按书源页数探针：独立读取源站章节页、跟随章内分页，要求下载正文包含每个源页的中间片段；探针失败按未通过处理。
- 只有 `assessNovelDownload` 返回 `complete: true` 的结果才会被组合为规范 TXT，并交给现有 `Library.importFile`（内部即 `importFileBlob` 流式导入）。
- 失败任务保留工作目录和 `task.json` 作为证据，但不产生任何书架记录。

任务状态固定为：`queued → fetching → validating → complete | failed | cancelled`。目录预检失败（例如版本混杂）在 `fetching` 之前直接 `failed`，不会下载。

## 生产路径与引擎目录

生产模块不包含 so-novel 运行包。World 从 `<dataDir>/bookfish/novel-engine` 读取 `app.jar`、`runtime/`、`rules/main.json` 和 `engine.json`；缺失时面板明确显示不可用原因。用 `scripts/install-novel-engine.mjs --data-dir <宿主数据目录>` 从隔离研究目录一次性安装。编译后的 `SonovelBridge.class` 随扩展 `src/novel-bridge/classes` 分发。

支持的书源在 `src/novel-sources.ts`：笔趣阁365、第八中文网、新笔趣阁小说网、香书小说、悠久小说网、少年小说网。候选 URL 的主机与书籍路径决定真实书源，不信任搜索接口自报的 sourceId。搜索可只填书名、只填作者或两者同时；同时填写时先搜书名，无精确匹配再追加作者搜索。页数探针按书源配置正文选择器；少年小说网正文由 JavaScript/base64 生成，没有独立探针，只走文本闸门。

## 组成

| 文件 | 作用 |
|---|---|
| `bridge/SonovelBridge.java` | 只读调用官方 v1.12.0 的 SearchParser/TocParser/BookParser，输出单行 JSON。使用独立编译，不修改上游源码。 |
| `adapter.mts` | 搜索归一化、候选匹配、任务状态机、配置生成、子进程下载、完整性闸门、隔离导入。 |
| `src/novel-integrity.ts` | 纯函数完整性校验，可被后续 World/worker 复用。 |
| `tests/novel-integrity.test.ts` | 缺章、漏页、截断、重复编号、目录变化、占位正文等单元测试。 |
| `fixture-server.mts` | 本地受控书源，复现完整、缺章、漏页、分页完整、版本混杂、同名书。 |
| `acceptance.mts` | 受控故障 + 真实公版书全本验收，输出 `output/novel-adapter/acceptance.json`。 |
| `build-bridge.mjs` | 用隔离 ECJ 编译 bridge（无需系统 JDK）。 |

## 运行

前置：隔离研究目录仍保留官方 so-novel v1.12.0 运行包：

```
E:/项目/桌面宠物/扩展/cortina/state/research/novel-fetch-20261109
```

可用 `SONOVEL_RESEARCH_ROOT` / `SONOVEL_RUNTIME_DIR` / `SONOVEL_JAVA` 覆盖。

```powershell
cd E:/项目/桌面宠物/扩展/cortina/state/packages/cortico-world-bookfish
node scripts/novel-adapter/build-bridge.mjs
pnpm exec tsx scripts/novel-adapter/production-acceptance.mts
```

只看受控故障（不访问真实书源）：

```powershell
$env:PRODUCTION_ACCEPTANCE_FIXTURE_ONLY='1'
pnpm exec tsx scripts/novel-adapter/production-acceptance.mts
```

## 校验规则

拒绝条件（失败即不入架）：

- 目录为空、条目结构损坏、order 不是连续 `1..N`、URL 重复。
- 标题重复，或 `第X回/章/节` 编号重复 / 回退 / 相对 order 偏移发生变化（版本混杂或插入杂章）。
- 下载后目录与下载前不一致。
- 目录中的章节没有对应单章文件；存在目录外文件；同一 order 多文件。
- 正文为空、过短、占位页（加载失败/正在手打/404）。
- 正文末尾出现 `本章未完 / 点击下一页 / 上一页 / 下一页 / 第x/y页` 等分页残留。
- 正文以 `，、；：、（【[《` 等截断标点结尾。
- 两个较长章节正文完全相同。
- 笔趣阁365页数探针：源站章节页无法读取、下载正文缺少任一源页的中间片段、或单页正文明显短于源站。

## 已知边界

- 页数探针按源站页面独立复核；它降低“无导航标记漏页”的风险，但仍依赖源站当前页面结构。若源站把正文拆成图片、登录墙或探针本身被限流，会按失败关闭而不是猜测。
- 规则目录中的书源仍可能改版；目录二次解析只能证明两次抓取一致，不能证明源站版本本身是“善本”。
- 只支持 so-novel 官方 v1.12.0 运行包与 `main.json` 规则；未做升级兼容。
- 隔离验收书架使用扩展自己的 `Library`；真实实例验收需显式安装，并在完成后清理测试书。
- so-novel 为 AGPL-3.0；当前仅作为独立进程调用，未复制其源码进扩展。正式分发前需继续确认许可证边界。

