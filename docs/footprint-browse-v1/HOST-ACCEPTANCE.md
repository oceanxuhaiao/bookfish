# 真实宿主验收：阅读足迹看板 V1

- 日期：2026-11-23 11:49–12:10
- 宿主：Coopanion `E:\zcdfy\Coopanion`（正式安装）
- 浏览器：Microsoft Edge 158.0.4370.33（headless，CDP 驱动，`http://127.0.0.1:17788/`）
- 被测构建：分支 `codex/footprint-browse-v1` 的 0.65.1 工作树（含足迹看板）
- 对照构建：本机原有的 0.66.0 TXT 工作树

## 1. 安装与回滚

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| 备份 | 复制 `data/extensions/package.json` 为 `package.json.before-footprint-v1-20261123-114928` | 有备份 |
| 试用安装 | 新建 `data/local-extensions/bookfish-footprint-v1-trial`（源码+构建产物，`node_modules` 用 junction），把 `data/extensions/node_modules/cortico-world-bookfish` junction 指过去 | 宿主 manifest 变为 `/assets/extensions/cortico-world-bookfish/0.65.1/webui-txt-builtin-bing-0651.js` |
| 回滚 | junction 指回 `bookfish-txt-0651-4ba8df5`，`package.json` 用备份覆盖，删除 trial 目录 | manifest 回到 0.66.0，页面回到旧版；见 `10-original-restored.png` |

宿主共重启 6 次（含两次无变更的诊断重启），每次 WebUI 都在 `~15s` 内恢复 `127.0.0.1:17788`。`core.log` 中 `bookfish` World 启动正常，无本功能相关报错。

> 注意：直接 `Start-Process Coopanion.exe` 会因子进程继承 `ELECTRON_RUN_AS_NODE=1` 而以 Node 模式退出；本次用 `ProcessStartInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')` 启动，属于验收环境的操作细节，不代表产品问题。

## 2. 验收结果

| 任务书条目 | 实测 | 证据 |
| --- | --- | --- |
| 默认全部书籍 / 最新在前 / 每页 10 | 全新浏览器配置文件：`全部书籍（872）`、`最新在前`、`10 条`、10 张卡片、`第 1 / 88 页`、上一页禁用、下一页可用 | `01-defaults.png` |
| 书籍搜索、只列有足迹的书 | 输入“西游”后候选只剩 `全部书籍（872）` 与 `西游记 · 吴承恩 · v5bdc8644（40）` | 运行输出 |
| 切换指定书籍、可回到全部 | 选西游记后 `第 1 / 4 页 · 共 40 条`，10 张卡片；再选全部回到 872 条 | `02-book-filter.png` |
| 最新/最早排序 | desc 与 asc 都返回正确首尾；切换排序回到新顺序第一页（R2 修正：此前的“保留当前页”会让 asc 落到末页） | 运行输出 |
| 足迹关键词搜索 | 输入“源稚生”全部书籍 → 匹配 124 条 · 第 1/13 页；清空恢复 880 条；西游记范围搜“孙悟空”7 条；无匹配显示提示 | `07-search.png` |
| 每页 5 / 10 / 20 / 50 | 真机验证 5、10、20；50 由 Library 测试与 jsdom 覆盖 | 运行输出 |
| 上一页 / 下一页 / 回到最新 | desc：第 1 页 → 下一页第 2 页 → 上一页第 1 页（首尾卡片一致）→ 回到最新第 1 页 | 运行输出 |
| **最早在前时的“回到最新”** | 修复前：`第 175 / 175 页` 只有 1 条；修复后：同一位置 2 条（872 % 5），页码与记录一致 | 运行输出；见第 3 节 |
| 恢复书籍筛选 | 选西游记 → 正常关闭浏览器 → 重启宿主 → 重开：仍为西游记、`第 1 / 2 页 · 共 40 条`、20 条/页 | `05-restored-book.png` |
| 恢复排序 / 每页 / 页码 / 滚动 | 全部书籍 + 最早在前 + 20 条/页 + 第 44/44 页 + scrollTop=100 → 关闭浏览器 + 重启宿主 → 重开：完全一致，首尾卡片相同 | `03-persisted-state.png`、`04-restored.png` |
| 新足迹提醒 | 把持久化高水位调到 885（不写任何数据）→ 打开 trail 立即出现“大肥鱼新增了 1 条足迹”；列表仍是第 1/88 页 | `06-banner.png` |
| 预览不改变历史页 | 点“查看新增”：预览 1 条；列表 10 条、`第 1 / 88 页`、scrollTop=0 均未变 | `07-preview.png` |
| 整体收起 | 预览隐藏、提醒隐藏、列表未变；持久化水位推进到 886 | `08-collapsed.png` |
| 提醒遵守书籍筛选 | 西游记内水位=41 → 提醒 1 条、列表 40 条；切到全部（水位=886）→ 提醒消失 | `09-scoped-banner.png` |
| 面板关闭后无轮询 | 从 trail 切到书架后 6 秒内 `journal_probe` 请求数 +0；回到 trail 后 5 秒内 +3 | 运行输出 |
| 回滚后旧版可用 | 旧版 0.66.0 加载，`bf-footprint` 不存在，旧手账可见 | `10-original-restored.png` |
| 真实新增足迹（宠物自己写） | **未产生**：12:07 时宿主处于午餐作息（提示“她正在吃午餐，预计 13:00 后可以继续读”），手动“继续读”被作息阻止。改用“调低持久化水位”验证了真实 `journal_probe` → `journal_new` → 预览 → 收起的完整链路，未写入任何用户数据。 | 第 4 节 |

## 3. 真机发现并修复的问题

**问题**：最早在前（asc）时点“回到最新”，页只显示 1 条（锚点被当作页首），但页码显示 `第 175 / 175 页`，与“最新记录所在页面”不符；同样的问题会让任何按 esc 排序的锚点恢复落到错位页。

**修复**：`journalBrowse` 的锚点改为“包含该记录的页”，按 page size 对齐：

1. 用真实 COUNT 求锚点在显示顺序中的名次；
2. 取 `(rank-1) % limit` 条邻居确定该页第一条；
3. 再用 `sequence <= start`（desc）或 `>= start`（asc）查询。

保存的页锚点本身就是页首，所以恢复时名次落在页边界，回到同一页；asc 的“回到最新”因此返回真正的最后一页。锚点被删除时落回它本该所在的页；邻居不足才退回旧的“锚点即页首”。

**复测**：真机同一位置从 1 条变为 2 条；新增/更新 Library 与 jsdom 断言（对齐页、asc 最后一页、锚点删除、limit 变更），全量 1086 项通过。

## 4. 关于“真实新增足迹”的边界说明

验收窗口内无法产生一条由大肥鱼自己写下的新足迹：她的作息（午餐至 13:00）阻止了阅读请求，而手动触发阅读属于新增模型调用，本次没有为了验收去强行调用模型。

因此新记录链路用“真实数据 + 真实查询”的方式验证：把浏览器持久化的 `lastPresented.all` 调到 885（当前最大 sequence 为 886），重新加载后由真实的 `journal_probe` 返回 `count=1`，`journal_new` 返回该条记录，预览与展开/收起全部走真实服务端与真实 DOM。全程只改浏览器本地的浏览状态，没有写 `history.sqlite` 或 `library.json`。

若要在 13:00 后补验“宠物自己产生新足迹 → 提醒”，只需打开 WebUI 的阅读足迹页等待下一次自主阅读即可，不需要额外操作。

## 5. 未覆盖

- 真实手机/窄屏布局（CSS 已写，但只在桌面宽屏验证）。
- 真实用户自己的浏览器配置文件（本次用独立 Edge 配置，机制同为 localStorage）。
- Coopanion 内嵌 WebView 中的滚动惯性等平台差异。

## 6. 截图

| 文件 | 内容 |
| --- | --- |
| `01-defaults.png` | 首次打开：全部书籍 / 最新在前 / 10 条 |
| `02-book-filter.png` | 搜索并筛选到《西游记》 |
| `03-persisted-state.png` | 恢复前的目标状态（最早在前 / 20 条 / 第 44 页 / 滚动 100） |
| `04-restored.png` | 关闭浏览器 + 重启宿主后恢复 |
| `05-restored-book.png` | 书籍筛选在重启后恢复 |
| `06-banner.png` | “大肥鱼新增了 1 条足迹” |
| `07-preview.png` | 临时预览（历史页不变） |
| `08-collapsed.png` | 整体收起后 |
| `09-scoped-banner.png` | 按《西游记》范围提醒 |
| `10-original-restored.png` | 回滚后旧版界面 |
