# BookFish TXT 获取模块 · 10 最终审核摘要

- 项目：看书吧！大肥鱼（BookFish）0.63.0 + 浏览器辅助 TXT 获取模块
- 分支：`feature/txt-acquisition`（基线 `origin/main` = `c440c03` = 0.63.0）
- 状态：**代码与测试完成，等待独立审核；未部署到任何生产环境**

## 一、三个被特别强调的验收点

| 强调点 | 结论 | 落点 |
|---|---|---|
| 1. 下载原始字节，不提前转码 | **已实现并有测试** | `download.ts` 全程只做 `Buffer` → 落盘（`fetch(url,{redirect:'manual'})` → `reader.read()` → `hash.update` → `stream.write`）；没有任何 `toString('utf8')`。测试 `keeps GBK bytes exactly as sent and reports progress` 逐字节比对 GBK 原文 |
| 2. 宽松导入必须有真实代码支持 | **已实现，不是「报错改警告」** | `stream-import.ts` 新增独立的 `decodeFileBestEffort` + `importFileBlobBestEffort`；`Library.importFileBestEffort` 走真实导入；旧硬条件（编码识别失败/坏字节预算/控制字符/末尾残字）在宽松路径被替换为打分与截尾，其余仍硬拒。19 例导入测试覆盖 5 种编码与全部容错场景 |
| 3. 失败后保留补救机会 | **已实现** | 原件保留在 `data/bookfish/txt-acquisition/raw/`；`retry` 三条路径（原件/已知地址/重扫页面）都不新建任务；`repair` 生成新 revision；被拒文件也记录 `rejection` + `retained=true`。11 例流程测试覆盖下载失败、重启中断、取消、被拒、重复导入 |

原来的 `Library.importFile` 与自主选书体系全部保留：新模块只通过 `Library.importFileBestEffort` 与 `SelectionCoordinator.onExternalImport` 两个受控入口接入，没有第二套书架、没有第二套阅读队列。

## 二、验收标准逐条

### A. 版本与代码安全
- [x] 基线为 0.63.0（与用户 ZIP 逐文件一致，已用 worktree 比对）
- [x] 群友补丁逐文件兼容处理（见 02 报告）
- [x] 未覆盖 `world.ts`；`chapters`/`set_start` 面板分支零改动
- [x] 未运行 `install.ps1`
- [x] 新模块与原书源引擎隔离（`novel-*.ts` 零改动）
- [x] 未引入新依赖（`package.json` 未改）
- [x] 新增权限有明确边界（默认关闭、只连指定回环端口、复用 `allowNetwork`）

### B. 浏览器获取
- [x] 打开指定资源页、发现 TXT/MD、返回多个候选
- [x] 下载指定文件，原始字节无损
- [x] 大小限制（100 MiB）、超时、取消、失败清理
- [x] 不影响用户已有页面（建页失败直接报错；只关自建页）
- [x] 网络关闭时无法访问互联网

### C. 宽松导入
- [x] 正常 TXT / UTF-8 BOM / GBK / GB18030 / UTF-16LE / UTF-16BE 全部可导入
- [x] 小瑕疵小说尽量导入（编号错、缺章、重复章、标题不齐、无章节、广告、残卷、书名偏差）
- [x] 不再以章节结构不完美为拒绝理由
- [x] 质量问题以警告形式记录（结构化 `QualityReport`）
- [x] 疑似不完整仍可作为部分作品阅读（`quality: partial`）
- [x] 只有空/二进制/登录页/大面积乱码/超限/违反策略/存储不可用才拒绝

### D. 补正机制
- [x] 下载失败与导入失败区分（失败码 + `recoverable`）
- [x] 失败文件不丢失
- [x] 能对原始文件重新修复
- [x] 修复生成新版本、不覆盖旧版本、不破坏旧进度
- [x] 失败任务可追溯（`tasks.json` 含历史、尝试计数、拒绝原因）

### E. 现有系统兼容
- [x] Library 导入体系正常（734 例全量通过）
- [x] SelectionCoordinator 正常（5 例定向测试 + 既有选书测试）
- [x] 阅读队列正常（复用 `fulfill`，按 `intentId` 去重）
- [x] SSM 无回归（见 06 报告）
- [x] 原书源搜索/抓取正常（未改）
- [x] 书架数据无变化（schema 3 未变）
- [x] Persona Memory 未被写入

### F. 自动化验证
```text
npm test              → 70 files / 734 tests passed, exit 0
npm run typecheck     → exit 0
npm run build:webui   → exit 0
npm run verify:world  → exit 1（缺运行时 ZIP，基线同样失败，已给出等价验证）
npm run check:ssm     → exit 1（blocked=0 review=7，待 SSM 负责人确认）
```

## 三、未完成 / 未验证

| 项 | 状态 | 说明 |
|---|---|---|
| `verify:world` / `verify:runtime` | 未通过（环境） | 缺 `output/novel-runtime/...zip`，打包源目录不存在；基线 worktree 复现同样错误 |
| `check:ssm` 的 7 个 review 文件 | 待审核方确认 | 实现方不得自行 accept |
| 真实浏览器端到端 | 未执行 | 本机无可用 CDP 浏览器实例；所有 CDP 交互由 `FakeSocket` 在协议层验证（建页/attach/navigate/close/事件/超时），未在真实 Chrome 上跑过 |
| 真实公网 TXT 下载 | 未执行 | 无网络访问授权与稳定测试地址；下载器用 `fetchImpl` 注入完成逐跳、超限、取消、内容类型验证 |
| Token 实测基线 | 未取 | 只给字符数实测与换算估算（约 +370 token/请求），需在真实宿主回填 |

## 四、已知限制

1. **宿主无浏览器接口**：Cortico 0.63.0 不提供任何 browser/CDP 能力（已 grep 确认），因此必须由用户显式配置 `browserDebugPort`；默认关闭。这不是「自动找到用户浏览器」，而是「连接用户明确授权的调试端口」。
2. **链接提取不是搜索引擎**：本模块只解析页面里的 `.txt/.md` 链接；找到资源页这一步依赖模型已有的联网搜索能力或用户给链接。若宿主没有可用搜索入口，这是下一阶段的能力缺口，不能用伪造结果填补。
3. **不自动删改正文**：广告行、重复章节只记警告，不自动删除（符合「不确定就保留」原则）。
4. **任务记录上限**：最多 100 个任务、每个任务 60 条历史、40 个候选；超出淘汰最旧的终态任务。
5. **候选过期**：候选 30 分钟有效；过期后需重新 discover。
6. **修复不自动切换版本**：生成新 revision 后，是否切换由现有版本机制/用户决定，绝不自动改当前在读。

## 五、剩余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| CDP 仍具高权限 | 若用户把调试端口暴露到非回环，可能被滥用 | 强制回环 + 端口白名单 + WS 校验 + 默认关闭 + 部署文档警示 |
| DNS 重绑定 | 首次校验后解析可能变化 | 每次重定向与落地页都重新 `checkUrl` 并重新解析；下载实际由浏览器/Node 各自解析，存在极窄 TOCTOU 窗口 |
| 宽松导入引入低质书 | 书架可能混入残卷 | 质量报告分级 + `partial` 标记 + 身份不匹配不自动排队 + 原件保留可再处理 |
| 常驻 token +约 370/请求 | 每轮对话成本上升 | 已做四项压缩；如需进一步降低可把 `bookfish_import_txt` 移到按需工具组（需评估可用性） |
| 未做真实浏览器验证 | 真实 Chrome 版本差异可能导致协议细节不符 | 审核阶段补一次真实 CDP 冒烟（打开一页 → 发现链接 → 关闭自建页） |

## 六、审核建议动作

1. 在装有 SoNovel 运行时归档的环境重跑 `npm run verify:world` 与 `verify:runtime`。
2. SSM 负责人确认 7 个 review 文件后执行 `--accept-review`。
3. 用装了扩展的 Edge/Chrome 做一次真实冒烟：配对 → discover → import → 入架（步骤见 11 号报告第 7 节），并顺带做一次真实公网 TXT 下载。
4. 通过后再决定版本号（建议 0.64.0）与 CHANGELOG 条目，按 `AGENTS.md` 发布清单执行 `pnpm describe:extension`、`pnpm check:extension`。

## 七、第二批：浏览器扩展通道（Edge/Chrome）

用户追加需求（m01117）：装了扩展的 Edge/Chrome 用户应当**直接可用**，不必改浏览器启动参数或重启浏览器。第一版只有 CDP 路径，无法满足这一点；本批补上扩展通道。

**方案**：不再依赖调试端口。世界进程内起一个只监听 `127.0.0.1` 的小 HTTP 桥（`src/txt-acquisition/bridge.ts`，401 行，纯 `node:http`，**零新增依赖**），MV3 扩展主动长轮询取任务，用**用户自己浏览器的 cookie 与 TLS** 打开资源页、流式取文件；世界只派活、收原始字节、做判断。Edge 与 Chrome 同为 Chromium，一份 `extension/` 通用。CDP 路径保留为备用（`browserDebugPort > 0` 时按 03 号报告规则连接唯一回环端口）。

| 关注点 | 结论 |
|---|---|
| 能否用日常浏览器 | **能**，扩展装在用户现有 Edge/Chrome 里，登录态即用户登录态 |
| 不接管标签页 | 完全不碰标签页：后台 `fetch`，不打开、不切换、不关闭任何页面 |
| 原始字节 | 扩展只搬运字节（4 MiB 分块裸 POST），桥边写边算 SHA-256；解码仍在世界侧，仍未提前转码 |
| 安全边界 | 仅回环监听；48 字符配对令牌（`timingSafeEqual`）；网页 Origin 一律 403 且不返回 CORS 头；页面 8 MiB / 分块 4 MiB / 文件仍 100 MiB；`page` 与 `done` 都重新校验落地地址 |
| 令牌隔离 | 令牌只经 WebUI 面板（`txt_bridge`）返回，不进工具参数、不进模型上下文、不进日志 |
| 入口 | 设置页新增「现成的 TXT 文件」卡片：两个开关、两个端口、配对信息与一键复制（否则用户根本开不了这个功能） |
| 网站边界 | 仍只用用户有权访问的页面；不登录、不付费、不绕过验证码/DRM；文件不上传、不传播 |

**验证**：`npm test` = 71 文件 / 745 测试通过（新增桥 8 例、扩展端到端 1 例、设置面板 2 例）；`typecheck`、`build:webui` 通过；`check:ssm` = `blocked=0 review=7 allowed=66`（7 个 review 文件未变，`extension/*` 与 `bridge.ts` 均 not-protected）。端到端用例把调试端口与直连 `fetch` 都设成抛错，证明整链路确实由扩展承载。

**已知限制**：未在真实 Edge/Chrome 上运行（无浏览器实例、无商店签名）；扩展为「加载解压缩」形式，无自动更新；令牌本地明文；需要 `<all_urls>` 主机权限；桥同时最多 4 个等待任务、扩展一次处理一个 job。详见 [11 号报告](BookFish-TXT-11-浏览器扩展.md)。
