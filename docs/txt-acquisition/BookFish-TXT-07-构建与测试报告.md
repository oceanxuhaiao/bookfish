# BookFish TXT 获取模块 · 07 构建与测试报告

执行环境：Windows / Node 22 / `D:\学习\项目\bookfish`，分支 `feature/txt-acquisition`，基线 `origin/main` = `c440c03`（0.63.0）。
日志留存目录：`D:\学习\项目\bookfish\_verify\`（未提交，供审核复核）。

## 一、验收命令结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm test` | **通过**，`Test Files 70 passed (70)`、`Tests 734 passed (734)`，exit 0 | 含 7 个新测试文件 70 例；日志 `_verify\test-final.txt` |
| `npm run typecheck` | **通过**，exit 0（`tsc --noEmit` + `tsc -p tsconfig.web.json --noEmit`） | 日志 `_verify\typecheck.txt` |
| `npm run build:webui` | **通过**，exit 0；产出 `lib/webui.js`、`lib/import-worker.mjs`、`lib/zip-worker.mjs` | 日志 `_verify\build-webui.txt` |
| `npm run verify:world` | **失败（环境缺失，非回归）** exit 1 | 见第二节 |
| `npm run check:ssm` | **未通过（待审核）** exit 1 | `blocked=0 review=7 allowed=47`，见第三节 |

## 二、`verify:world` / `verify:runtime` 的阻塞与等价验证

现象：

```text
ENOENT: no such file or directory, stat
  '.../output/novel-runtime/bookfish-novel-runtime-1.12.0-bf1-win32-x64.zip'
    at scripts/verify-novel-world.ts:40
```

原因：这两条命令需要已打包的 SoNovel 运行时归档；其打包源目录 `D:\学习\research\novel-fetch-20261109\sonovel-runtime\SoNovel` 在本机不存在，`npm run package:runtime` 无法离线产出该 ZIP。与本次改动无关（本次未触碰 `src/novel-runtime/*`、`scripts/verify-*`、`package.json`）。

等价验证（已完成）：

1. 在 `D:\学习\项目\_base063` 建 origin/main 的 detached worktree（未含本分支任何改动），用 junction 指向同一份 `node_modules`。
2. 在该 worktree 执行 `npm run verify:world` → 得到**完全相同**的 ENOENT（路径为 `_base063\output\novel-runtime\...zip`）。
3. 结论：缺失是环境/制品问题，基线同样失败，本分支未引入回归。

如需在审核环境补齐：放入合法运行时 ZIP 到 `output/novel-runtime/` 后重跑两条命令即可。

## 三、`check:ssm` 待确认项

```text
blocked=0  review=7  allowed=47
```

review 文件：`describe.json`、`src/ENV_PROMPT.md`、`src/config.ts`、`src/library.ts`、`src/stream-import.ts`、`src/tool-schemas.ts`、`src/world.ts`。这些文件含 SSM 共享区段，需要 SSM 负责人用 `npm run check:ssm -- --accept-review "<理由>"` 明确同意；实现方不自行 accept。

## 四、新增测试明细（70 例）

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/txt-acquisition-url.test.ts` | 11 | 协议白名单、凭据剥离、私有/元数据/单标签名、DNS 混合答案、无网络权限不解析、地址段分类、CDP WS 校验、链接提取（绝对/相对/去重/截断/身份提示） |
| `tests/txt-acquisition-browser.test.ts` | 11 | 端口范围、非回环 WS 拒绝、建页失败不接管现有页、只关自建页、readyState 兜底、加载超时、attach 失败清理、落地地址复检（内网/元数据/file 协议/DNS/空地址/无网络权限） |
| `tests/txt-acquisition-download.test.ts` | 9 | GBK 字节原样、逐跳复检、重定向到内网、5 跳上限、超限不落盘、HTML/PDF 拒绝、octet-stream 接受、503 可恢复、取消清理、无网络权限不发请求 |
| `tests/txt-acquisition-import.test.ts` | 19 | 5 种编码、坏字节、末尾残字、章节编号/缺失/重复/风格、无章节、广告保留、残卷、书名不符、空/二进制/登录页/大面积乱码拒绝、严格入口不变 |
| `tests/txt-acquisition-flow.test.ts` | 11 | discover 只存摘要、clean 后删原件、warning 保留原件、下载失败重试不建新任务、重启恢复、取消清理、repair 生成新 revision、重复导入去重、网络关闭、不探测端口、被拒保留原件 |
| `tests/txt-acquisition-selection.test.ts` | 5 | exact 排队一次且不推进进度、身份不符转确认、人工/取消不动作、已有其他 revision 不动、书架缺失记失败 |
| `tests/txt-acquisition-tool.test.ts` | 4 | 工具注册与 action 枚举、默认关闭状态、关闭时拒绝、参数校验 |

## 五、既有测试的影响面

- 唯一被修改的既有测试：`tests/context-budget.test.ts`（工具数 15→16、schema 上限 13 000→13 400、提示词 band 600→800），理由与实测数字见 `docs/prompt-refactor/2026-11-txt-acquisition.md`。
- 其余 69 个测试文件**零改动**，全部通过。

## 六、常驻预算实测

| 指标 | 基线（origin/main） | 本分支 | 增量 |
|---|---|---|---|
| 工具数 | 15 | 16 | +1 |
| 工具 schema 字符 | 12 473 | 13 150 | +677 |
| 环境提示词字符 | 424 | 667 | +243 |

折算约 **+370 token/请求**（估算口径：ASCII 约 4 字符/token、汉字约 1 token；未在真实宿主取基线，需要时应实测回填）。控制手段：不新增独立状态工具（并入 `bookfish_import_txt` 的 status）、repair 不暴露编码参数、参数不带 description、`modelStatus()` 只暴露 `txtFiles{enabled,browserConfigured,active}` 三个布尔/计数。
