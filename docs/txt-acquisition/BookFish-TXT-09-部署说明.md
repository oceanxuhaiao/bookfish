# BookFish TXT 获取模块 · 09 部署说明

适用版本：BookFish 0.63.0 + 本分支（`feature/txt-acquisition`）。**不要直接覆盖生产环境**，先按本说明在隔离环境验证。

## 一、安装

```powershell
# 1) 取分支（不推送公开仓库前，请在受控环境操作）
cd D:\学习\项目\bookfish
git fetch origin
git switch feature/txt-acquisition

# 2) 安装依赖（本次未新增依赖，仍为 cheerio 1.2.0 / ipaddr.js 2.2.0 / unpdf 2.1.0）
npm ci

# 3) 构建
npm run build:webui        # 产出 lib/webui.js 等
npm test                   # 期望 70 files / 734 tests 通过
```

若目标机器使用仓库内已提交的 `lib/*` 构建产物，可跳过构建直接安装，但建议保持一致。

## 二、配置（设置面板 → 高级）

| 设置键 | 默认 | 说明 |
|---|---|---|
| `worlds.bookfish.txtAcquisitionEnabled` | `false` | **总开关，默认关闭**。关闭时工具仍注册但调用即报 disabled |
| `worlds.bookfish.browserDebugPort` | `0` | 专用浏览器调试端口，`0` 表示不启用。只连 `127.0.0.1:<该端口>`，不探测 9222/9223/9224 |
| `worlds.bookfish.txtAcquisitionRetentionMb` | `512` | 原始文件保留上限（64–10240 MiB），超限时仅清理未被任务引用的原件 |
| `worlds.bookfish.allowNetwork` | `true` | 复用现有网络权限；关闭后本模块任何网络访问都会被拒 |

启用 CDP 的参考做法（自备浏览器，不要复用日常浏览器）：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9333 `
  --user-data-dir="$env:LOCALAPPDATA\BookFishCDP" `
  --no-first-run http://127.0.0.1:9333/json/version
```

> 调试端口只绑回环；`--user-data-dir` 用独立目录，避免把用户日常会话暴露给自动化。

## 三、使用（模型侧）

```text
bookfish_import_txt action=discover pageUrl=<资源页> title=<书名> [author=<作者>] [intentId=<选书意向>]
bookfish_import_txt action=import  taskId=<任务> candidateId=<候选>     # 或 fileUrl=<直链>
bookfish_import_txt action=status  [taskId=<任务>]
bookfish_import_txt action=retry   taskId=<任务>
bookfish_import_txt action=repair  taskId=<任务>
bookfish_import_txt action=cancel  taskId=<任务>
```

- 人工导入（无 `intentId`）：成功即入架，不改当前在读、不推进进度、不建阅读承诺。
- 自主选书（带有效 `intentId`）：成功后进入现有 `SelectionCoordinator` 完成流程，由既有机制生成阅读队列；身份不是 exact 时停在 `awaiting_choice` 等待确认。
- 带警告入架可以正常阅读；`partial` 表示疑似不完整或截断，模型不得据此声称已获得全本。

## 四、数据目录与容量

```text
<dataDir>/bookfish/txt-acquisition/
├── tasks.json                 # 任务与质量报告（原子写；损坏时改名为 tasks.json.corrupt-<ts>）
├── raw/<sha256>.txt|.md       # 保留的原始字节（有警告/补正/失败时保留）
└── work/<taskId>.part         # 下载中的临时文件（成功或失败后清理）
```

- 正式书籍全文仍在原来的 `BookStorage` 目录，**不会混入**。
- `tasks.json` 只保存地址的 `sha256`，不保存 URL 原文、Cookie、Authorization。

## 五、回滚

本分支对既有代码是纯增量改动，回滚只需切回基线：

```powershell
git switch main            # 或 origin/main 对应的 0.63.0 提交
npm ci
npm run build:webui
```

- 书架数据格式未变（`LibraryState.schema` 仍为 3），回滚后原有书籍与进度可直接读取。
- `data/bookfish/txt-acquisition/` 可以整体删除（只是一份获取记录与原件），不影响书架。
- 若已用新分支导入过书，这些书在回滚后**仍然存在**（因为走的是原有 BookStorage 与 `library.json`），只是不能再发新的获取任务。
- `describe.json` 回滚后工具列表恢复 15 个，模型不再看到 `bookfish_import_txt`。

## 六、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `browser_unavailable` | 未配置 `browserDebugPort`，或该端口没有可控制的浏览器 | 确认端口非 0、浏览器已开 `--remote-debugging-port`、只绑回环 |
| `Invalid browser debug port` | 端口 <1024 或 >65535 | 换到 1024–65535 |
| `policy_blocked` | 目标是 localhost/私有网段/元数据地址，或 DNS 解析到内网，或网络权限关闭 | 换公开资源页；确认 `allowNetwork` |
| `More than 5 redirects` | 跳转链过长 | 找到最终地址直接 `fileUrl` 导入 |
| `The address returned an HTML page` | 下载地址其实是网页 | 换真实文件地址；本模块会拒绝而非把 HTML 当书 |
| `too_large` | 超过 100 MiB | 换更小的版本；上限沿用 `MAX_BOOK_BYTES` |
| `not_a_book` / `empty_file` / `binary_file` | 登录页、空文件、二进制 | 任务与原件已保留，可 `retry` 或 `repair` |
| `library_full` | 书架 100 本或 128Mi 字符上限 | 先导出/移除旧书 |
| `Library is full; export and remove books first` | 同上 | 同上 |
| `disabled` | 总开关关闭 | 打开 `txtAcquisitionEnabled` |
| `check:ssm` 退出码 1 | 7 个 review 文件待 SSM 负责人确认 | `npm run check:ssm -- --accept-review "<理由>"` |

## 七、安全注意事项

- 不要把调试端口暴露到非回环地址；不要复用含登录状态的日常浏览器配置目录。
- 本模块只读取用户本就有权访问的内容；不得用于绕过登录、付费、验证码或 DRM。
- 下载到的正文仅供本地阅读，不上传、不分享。
