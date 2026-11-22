> 2026-11-22 用户已要求本机试用安装：源码9a2300b候选已替换日常实例0.65.1（原目录和数据备份保留），12本及原确认进度/821记录/1666任务核对不变。见round4-final/09；这不是正式发布或浏览器控制器放行。

> 2026-11-22 实际宿主后续：用户授权高权限隔离功能验收且无需普通权限。Coopanion0.2.23 Core/实际WebUI已完成，4本测试书confirmed0/队列0、重启/恢复/撤权/退出核对通过；详见round4-final/08。来源恢复夹具不是实际网络下载，模型/Electron壳/MV3及正式控制器不计通过。

> 2026-11-22 最终收尾：见round4-final/00-审核入口.md及07-最终验收摘要.md；源码9a2300b，85文件963通过/1跳过，类型/构建/官方契约通过。完整world仍失败，累计SSM待审核；当前桌面High，普通权限真实宿主验收BLOCKED，未启动测试宿主。用户已授权之后验收，但不豁免普通权限/非生产数据边界。

> 2026-11-22 当前补充修复以round4-supplement/00-独立审核入口.md及07-最终验收摘要.md为准；源码77a5af8，全量945通过/1跳过，SSM待独立审核，完整world失败。保持controllerReady=false/browserReady=false；未运行宿主脚本，未合并/发布。历史main c440c03不是当前远程main，当前远程1fc504f（0.65.1）。

> 2026-11-21 第四阶段当前状态：以 round4/00-审核入口.md 和 round4/15-最终验收摘要.md 为准。以下旧版真机操作步骤属于历史记录，当前不得绕过 controllerReady=false/browserReady=false；不安排用户现在运行宿主脚本。第三轮审核对象35e364a、此前生产代码8587756、本轮候选12d8a03分别标识，不继承旧测试通过结论。

# TXT 获取模块 · 进度说明（跨机器接力用）

> 本文件是给「换一台电脑继续开发」准备的交接说明。分支：`feature/txt-acquisition`，基线 `origin/main` = `c440c03` = BookFish 0.63.0。**不要合并到 main，也不要直接部署生产环境。**

## 1. 现在到哪一步了

两批工作已提交，全部自动化测试为绿：

| 提交 | 内容 |
|---|---|
| `5e4cd49` | 第一批：独立的浏览器辅助 TXT/MD 获取模块、宽松导入、补正与重试、自主选书接入、工具与提示词 |
| `81a31c7` | 第二批：Edge/Chrome 扩展通道（MV3 扩展 + 回环桥），让装了扩展的用户直接可用，不必重启浏览器改调试参数 |

验证结果：`npm test` = **71 文件 / 745 测试通过**；`npm run typecheck`、`npm run build:webui` 通过；`npm run check:ssm` = `blocked=0 review=7`（7 个含 SSM 共享区段的文件需 SSM 负责人确认）；`npm run verify:world` / `verify:runtime` 因本机缺 `output/novel-runtime/…zip` 而失败，已在未改动的 0.63.0 基线上复现同一 ENOENT，属环境缺失。

## 2. 能力现状

- **发现**：给一个资源页 URL，用浏览器打开（扩展通道，或显式配置的调试端口），从页面里提取 `.txt` / `.md` 链接，生成带有效期的 `candidateId`（候选 URL 不落盘，只存 SHA-256）。
- **下载**：原始字节全程 `Buffer`，不提前转码；分块、进度、超时、取消、实时累计字节、失败清理；`text/html` 明确拒绝；上限沿用 `MAX_BOOK_BYTES` = 100 MiB。
- **质检**：三档——必须拒绝（空文件/二进制/登录页/超限/违反网络策略）、可导入但记警告（乱码、缺章、重复章、广告、标题不统一、疑似截断、书名作者偏差）、自动补正（BOM、GBK/GB18030、UTF-16LE/BE、换行、坏字节、末尾残字、控制字符、重复空行）。
- **导入**：新增 `Library.importFileBestEffort`，走真实存储与 1200 字分段；严格入口 `Library.importFile` 行为完全未改。
- **失败恢复**：原件保留在 `data/bookfish/txt-acquisition/raw/`，任务记录在 `tasks.json`；`retry` 三条路径（原件 / 上次地址 / 重扫页面）都在**同一任务**上继续；`repair` 生成新 revision，不覆盖旧版本、不动旧进度。
- **自主选书**：成功后调用现有 `SelectionCoordinator.onExternalImport`，只建一次阅读队列；身份不匹配只入架不排队；获取成功不等于阅读成功。
- **安全**：仅 HTTP/HTTPS；阻断回环/私有/链路本地/云元数据；DNS 解析结果校验；重定向逐跳复检；浏览器落地地址二次复检；标签页只建自己的、绝不接管或关闭用户页面；网络权限关闭时不做任何外呼。

## 3. 代码地图

```
src/txt-acquisition/
  types.ts          任务/候选/质量报告/状态机与校验
  url-policy.ts     URL、IP、DNS、重定向、WS 回环校验
  browser-client.ts CDP 客户端（只连显式配置的回环端口）
  link-discovery.ts 页面链接提取与书名/作者/体积启发
  download.ts       Node 直连下载（原始字节）
  bridge.ts         扩展通道：127.0.0.1 回环 HTTP 长轮询桥
  repair.ts         编码探测、宽松解码、文本规范化
  quality.ts        质量评估与可读性判断
  records.ts        任务持久化（tasks.json）
  staging.ts        原件暂存、配额清理、路径逃逸防护
  acquisition.ts    编排：discover / import / retry / repair / cancel / prune
  index.ts          公共导出
extension/           MV3 扩展（Edge / Chrome 通用）
src/stream-import.ts 新增 decodeFileBestEffort / importFileBlobBestEffort（严格路径未改）
src/book-storage.ts  新增 importFileBestEffort
src/library.ts       新增 importFileBestEffort（宽松受控入口）
src/selection.ts     新增 onExternalImport
src/config.ts        txtAcquisitionEnabled / browserDebugPort / txtAcquisitionRetentionMb / browserBridgeEnabled / browserBridgePort
src/world.ts         注册 bookfish_import_txt、设置面板 txt_bridge / txt_bridge_restart、启动与停止钩子
src/webui/settings.ts 设置页「现成的 TXT 文件」卡片
tests/txt-acquisition-*.test.ts  url / browser / download / import / flow / selection / tool / bridge
docs/txt-acquisition/ 本目录：审核包与方案书
```

## 4. 另一台电脑上怎么继续

```powershell
git clone https://github.com/oceanxuhaiao/bookfish.git
cd bookfish
git checkout feature/txt-acquisition      # 需要的话先 git fetch origin
npm install                               # Node >= 22.13
npm test                                  # 预期 71 文件 / 745 测试
npm run typecheck
npm run build:webui
```

真机验证扩展：设置页打开两个开关 → 保存 → 复制「端口 / 令牌」→ `edge://extensions` 或 `chrome://extensions` 开发者模式加载 `extension/` → 弹窗粘贴 → 显示已连接 → 让大肥鱼找一本书，看到 `discovering → candidate_ready → downloading → importing → completed`，书架出现新书且阅读进度为 0。

## 5. 还没做（按优先级）

1. **真实浏览器冒烟脚本化**：目前扩展协议由伪扩展（测试里的轮询客户端）验证，未在真实 Edge/Chrome 跑过。建议用 Puppeteer 拉起带 `--load-extension` 的 Chromium 做 CI 冒烟。
2. **「自己找资源页」的搜索入口**：本模块只解析页面里的链接，找资源页仍依赖模型已有的联网搜索能力；若宿主没有可用搜索入口，需要单独设计（不得伪造搜索结果）。
3. **扩展打包与分发**：现在是「加载解压缩的扩展」，没有商店上架、没有自动更新。
4. **SSM 负责人复核** 7 个 review 文件（`describe.json`、`src/ENV_PROMPT.md`、`src/config.ts`、`src/library.ts`、`src/stream-import.ts`、`src/tool-schemas.ts`、`src/world.ts`）后再决定是否公开合并。
5. **运行时归档**：在装有 SoNovel 运行时包的环境跑通 `npm run verify:world` 与 `verify:runtime`。
6. **版本号与 CHANGELOG**：建议 0.64.0，按 `AGENTS.md` 发布清单执行 `pnpm describe:extension`、`pnpm check:extension`。

## 6. 不能碰的红线（改代码前先读）

- 不得用补丁整体覆盖 `src/world.ts`：0.63.0 的 `chapters` 与 `set_start` 面板分支必须保留。
- 不得运行补丁包里的 `install.ps1`（只检查 `package.json` 存在就覆盖源码）。
- 严格导入入口 `canonicalize` / `importFileBlob` / `Library.importFile` 的行为不得改动；宽松能力只走新增入口。
- 下载阶段禁止把未知编码的字节转成 UTF-8 字符串。
- 不得删除失败任务唯一的原始文件；不得自动覆盖已有书籍版本；不得把获取成功当作阅读成功。
- 不得绕过登录、付费墙、验证码、DRM 或反爬；不得上传或传播下载到的小说。
- 获取记录、质量报告、网页内容不得写入 Persona Memory；不得推进已读进度。

## 7. 审核包位置

本目录下除了本文件，还有 `TXT获取模块-方案书.md` 与 `BookFish-TXT-00` … `BookFish-TXT-11` 共 12 份报告（索引见 `BookFish-TXT-00-从这里开始.md`）。工作区里另有 `_verify/`（命令原始输出）与 `output/`（构建产物）为本地未跟踪目录，不需要带走。

## 第二轮审查检查点（2026-11-21）

当前状态以 [第二轮基线与阻断报告](ROUND2-BASELINE-AND-BLOCKER.md) 为准。71 文件 / 745 用例是本机重新执行结果；npm ci 和 pnpm 冻结安装未通过。恢复已有合法运行时归档后 runtime 验证通过，不能继续沿用本机缺 ZIP 的结论。

已复现初始私有地址派活、双消费者领取同一任务、旧 .part 拼接导致磁盘与哈希不一致。当前扩展/CDP 的事后 URL 校验不是请求前防护；DNS 预检未绑定连接 IP。按第二轮方案书停止条件提交安全边界分析，未进行真实浏览器联调，尚未实施修复，不可发布。旧报告属于历史实现记录，所有安全通过及真实宿主结论必须按本次报告重新审核。

## 受控出站设计授权与结果（2026-11-21）

用户已明确授权安全出站方案设计与验证。已完成 [受控浏览器出站方案 v0.1](ROUND2-CONTROLLED-EGRESS-DESIGN.md)，方向为独立配置文件、固定IP代理及独立出站限制；不复用日常profile，不导出Cookie、不做TLS中间人。8项解析/策略实验、5项真实本机CONNECT负向请求通过；真实公网HTTPS与CONNECT TLS均HTTP200且证书校验通过。两脚本专项tsc通过。没有启动浏览器、修改防火墙或生产网络；强制出口与回环限制尚未验证，P0和真实浏览器验收仍未通过。设计实验不改变71/745的上一轮产品测试基线，也不构成新增产品用例数。

## 真实 Chrome 强制阻断与代理联调（2026-11-21）

用户授权继续后，在独立 Chrome 158.0.8127.36 副本上通过 WFP 按应用路径限制。真实页面/STUN正向对照可达，受限后TCP4/TCP6/本机LAN地址、UDP4/UDP6及TCP允许端口的同号UDP接收/连接增量全0；精确允许端口仍正常，控制器强杀后规则仍在。继续真实Chrome经固定IP CONNECT取得RFC1149公开TXT，3215字节、SHA与独立下载完全一致；删除代理配置后无法直取，实际停止代理后禁止目标0连接。全部实验过滤器和sublayer已按GUID清理，最终查询found0，未改日常安装目录/生产宿主。

详见[浏览器阻断与联调报告](ROUND2-WFP-BROWSER-VERIFICATION.md)。这不是BookFish MV3或Coopanion验收；当前产品入口尚未接入保护，P0本体仍待修复。保留两次测试断言修正与GitHub来源超时的原始失败记录。共享系统DNS、Edge、QUIC、BFE/系统重启等未专项验证，不宣称所有浏览器出站路径已闭合。

## 2026-11-21 第二轮收尾审核

协议v2、DNS固定传输、来源授权、记录脱敏、原件保护与宽松质量修复完成。75文件778测试、类型、构建、官方契约通过；真实CDP导航与WFP实验通过。正式控制器／MV3／实际Coopanion／真实样本仍待验收，SSM review7未放行，未push。详见ROUND2-IMPLEMENTATION-REVIEW.md。


2026-11-21后续阶段：799测试与Chrome／Edge真实MV3回归通过；发现共享DNS代发缺口。完整结果、内存代价和待人工审核边界见[后续交付报告](ROUND2-FOLLOWUP-REVIEW.md)。


第三轮独立分支codex/txt-acquisition-round3；数据可靠性候选13b6149，845全量+55后续边界专项、类型／构建／契约通过。五点Node中断、真实私有NTFS拒读／占用与100MiB边界验证通过；普通用户Coopanion预检受权限阻塞，未运行。浏览器就绪保持false，SSM仍需独立审核，未push／merge／部署。当前报告见round3/00-审核入口.md，后续阶段继续，不能把本阶段当全任务完成。

第三轮补充审核候选：真实样本前导空白与控制器失效旧上传修复8587756；最终80文件854测试、类型/构建/官方契约通过。新两部作品、GB18030派生与红楼梦12样本重新验证；30次单任务性能和10次并发比较完成。npm锁对齐权威pnpm；实际yauzl3.2.1发布worker畸形字段验证通过。verify:runtime/no-fetch通过，完整verify:world无精确候选失败；六项开发audit未消除。用户选择普通终端自行运行宿主脚本，等待结果；SSM仍review7/4/2，控制器/DNS与实际浏览器未验收。完整审核入口round3/00及13，不能发布。

## 2026-11-21 BookFish TXT 第四阶段第一阶段候选冻结

独立worktree bookfish-txt-acquisition-round3中新建codex/txt-acquisition-round4，源码修复12d8a03，补测试c5de064、验证脚本dc53793/9761e47。七项P1与P2网络撤销修复、受控故障回归完成；统一目录检查仍无法消除Node原生路径调用内外部恶意进程竞态，完整保证PARTIAL，待独立判断可信单写者前提。主pnpm与新npm副本均82文件907pass/1 POSIX skip，类型/构建/官方describe/check通过；runtime/no-fetch0，完整world明确作者16源无候选而FAIL。30次同输入性能与10次并发实测源码hash一致，99MiB解码9.51→10.35秒、入架21.55→22.52秒，RSS持平，不宣称提速。双锁安装版本集对齐，实际yauzl3.2.1发布worker通过，六项开发audit未关闭。SSM0阻断review7/4/2/2待独立审批；未运行宿主脚本，不创建账户，不安装控制器，不改系统网络，不合并或部署。审核入口该worktree/docs/txt-acquisition/round4/00-审核入口.md。

第四阶段最终补充冻结ed020ae：生产源码仍12d8a03；主树最终82文件908pass/1skip，类型0。npm独立树此前完整907pass/1skip，加最后两文件同步后的36项边界pass；不虚构npm树重复全量。宿主继续暂缓，等待独立审核。


2026-11-22 按用户要求先适配最新main 1fc504f/0.65.1再安装：冻结c9f24b494b83ac45439e35b737298e77bfe8a404，91文件1018pass/1平台skip，类型/构建/官方契约/帮助/runtime/no-fetch通过，完整world仍无精确候选失败；SSM blocked0 review8待独立审核。获准高权限隔离真实Core验证新版帮助和TXT共存；日常宿主新备份+副本兼容后升级，12书/1833748确认字符/823阅读记录保持，恢复运行，浏览器桥与controller/browser保持关闭。无push/main合并/正式发布。详见latest-adaptation/00-适配与安装报告.md。


2026-11-22 浏览器TXT新帮助、并列获取渠道及首次配置向导已完成，本机安装bfb4c7f。93文件1029pass/1平台skip、类型/构建/20指南检查/官方契约通过；实际隔离Core与日常UI确认向导、服务端安全门禁及新帮助。12书/1840439确认字符/826episodes保持，恢复运行；正式控制器缺失，浏览器获取仍BLOCKED。报告browser-txt-ui/00-实现与验收.md。
