# 第二轮开发基线与安全阻断报告

日期：2026-11-21（Asia/Shanghai）。状态：阶段 0 已执行，依赖冻结安装未通过；阶段 1 安全审查触发停止条件，尚未实施修复。不能发布或部署。

## 工作区保护与版本接力

- 原 SSM 包位于 `../cortico-world-bookfish`，分支 `fix/coopanion-0.2.21`，HEAD `3875801`，有大量已修改及未跟踪内容；没有切换、清理、覆盖、stash 或提交这些内容。
- 实际 GitHub checkout 位于原包的 `output/github-bookfish`，原本为干净的 `main`，本地 HEAD `ea9b45b`。远程为 `https://github.com/oceanxuhaiao/bookfish.git`。
- 执行 fetch/prune 后：origin/main=`c440c03f2f1aed7ed451659ddf4f38b0d4b9b38d`，package 0.63.0；origin/feature/txt-acquisition=`08e0c7e590cdb1917c9eeb469088c011fd225407`，与任务书一致。本地 main 保持原提交。
- 本轮独立 worktree：`E:/项目/桌面宠物/扩展/cortina/state/packages/bookfish-txt-acquisition-hardening`；分支 `codex/txt-acquisition-hardening`，基于上述功能分支。
- 已检查 branches、log、remote、stash、worktree。原 SSM 仓库没有 remote；GitHub checkout 不存在本地领先提交。本轮没有替换生产实例、操作生产书架或真实阅读数据，没有调用模型。
- Cortina 工作区 commit `08f84671b98514852da2e2fb8a54a38ffe4ee420`；本地官方 Cortico checkout commit `c376b91`（0.2.13）。本轮未更新有状态的官方 checkout；当前上游 main 和目标宿主版本未核实，不能据此声明宿主契约验收通过。

## 修改代码前的实测基线

Node 24.14.1，npm 11.11.0，corepack pnpm 12.15.0。

| 检查 | 真实结果 |
|---|---|
| npm ci | exit 1；无 package-lock.json/npm-shrinkwrap.json |
| corepack pnpm install --frozen-lockfile | exit 1；packageManagerDependencies 与锁不匹配 |
| 备用 npm install --no-save --package-lock=false --ignore-scripts | exit 0；228 包；未冻结版本，不能视为可复现安装通过 |
| npm test | exit 0；71 文件 / 745 用例通过 |
| npm run typecheck | exit 0，包含两份 tsconfig |
| npm run build:webui | exit 0 |
| npm run verify:world，首次 | exit 1；默认路径缺运行时 ZIP |
| npm run verify:runtime，首次 | exit 1；同上 |
| npm run check:ssm | exit 1；blocked=0 review=7 allowed=53；未 accept-review |
| 恢复归档后 verify:runtime | exit 0；实际 Java/bridge 自检和联网 source probe 通过 |
| 恢复归档后 verify:world -- --no-fetch | exit 0；真实运行时 + FakeHost 挂载及旧书源搜索；没有文件下载，不是 Coopanion 验收 |
| 恢复归档后 verify:world 完整默认命令 | 结果见本报告补记及 `_verify/recovered-verify-world.log` |

SSM allowed 数量受本地未跟踪文件及构建产物影响；53 是上述运行时刻的实际输出，不能与旧报告的 47/66 直接混用。review 仍为既有七个共享文件。本轮没有修改 SSM、严格导入或正文数据结构。

备用安装提示 7 个依赖漏洞（4 moderate/1 high/2 critical）；这是安装器报告，尚未完成依赖漏洞可达性分析，未执行强制升级。安装/构建对隔离工作区锁文件与生成文件的改动已保存 diff 到 `_verify/`，随后恢复到 HEAD；没有将机器路径相关构建差异混入本轮提交。

原始命令输出在本 worktree 的 `_verify/`。依赖解析快照为 `baseline-dependencies.json`。锁安装失败仍是阶段 0 遗留问题，备用安装不代替该门槛。

## 本机已有运行时恢复

从原包 `output/novel-runtime/bookfish-novel-runtime-1.12.0-bf1-win32-x64.zip` 只读复制到隔离工作区默认路径；未下载替代文件。大小 85,784,286 字节；SHA-256 `b9f16f858150a8370fb59a2c4df582b99f133b2b60419434c579d7485060b71e`，与本分支 builtin-manifest 完全一致。运行时验证在临时数据目录执行，不是生产安装。

## 可复现的 P0 缺陷

复现脚本 `_verify/p0-probe.mts`，结果 `_verify/p0-probe.log`。只有回环桥请求和临时文件，没有真实浏览器或目标网络请求。

1. **初始 URL 没有统一预检**：`bridge.ts` 的 fetchPage/fetchFile 直接派活；runDiscovery 有预检，但候选/直接导入的桥下载路径没有统一门禁。直接桥调用派发 `http://127.0.0.1:9/private` 已复现，不代表真的访问了该地址。
2. **重复领取**：两个并行 GET /bridge/jobs 返回同一 job id，已复现。nextJob 没有 claim/lease，notify 也会把同一任务发给多个等待者。
3. **临时文件和哈希不一致**：预置 `retry.part=OLD`，桥下载 NEW 并 done，实际文件 OLDNEW，实际大小 6，回报大小 3，回报 SHA 与磁盘不一致，已复现。fetchFile 仅取 partialPath，chunk 用 appendFileSync，未独立初始化。
4. **重定向事后检查**：background.js 两次 fetch 都是 redirect:follow；bridge 的 verifyLanded 在 page/done 回传后运行。不能阻止浏览器先访问不安全重定向目标。
5. **CDP 的其他出站路径**：browser-client.ts 的 PageSession.navigate 直接 Page.navigate；acquisition.ts 在导航后检查落地 URL，无法限制加载期间的脚本、子资源或页面发起的导航。只拦 HTTP 302 不足以覆盖 CDP 页面的网络行为。
6. **DNS 重绑定**：checkUrl 的 Node lookup 与扩展 fetch/CDP 导航独立解析；未绑定实际连接 IP，事后重新 lookup 不能证明连接目标安全。Node download.ts 的默认 fetch 也没有把已检查的地址绑定到连接，需纳入同一审查。
7. **其他已确认静态缺口**：pageUrl 原文持久化及工具回执；bridge assertContentType 将完整 URL 拼入错误；页面 response.text() 全量读取；无按来源凭据授权；失败路径缺少桥自身的 .part 清理。尚未逐项修复或验收。

## 请求前安全边界与停止分析

[Fetch 标准](https://fetch.spec.whatwg.org/#http-fetch) 定义 redirect:error 可拒绝自动重定向，而 manual 返回 opaque-redirect；因此可以在不增加权限的情况下拒绝重定向，但不能把 manual 当成浏览器内可读 Location 的逐跳代理。

[Chrome webRequest 官方文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest) 说明普通 MV3 扩展通常不能使用 webRequestBlocking；文档中的 ip 是请求已经发送到的服务器地址。不能用响应事件观察 IP 来冒充连接前的阻断。以上接口事实不构成对所有未来浏览器能力的“不可能”证明；本次确认的是当前实现和已核对接口不足以建立任务书要求的保证。

当前权限下，改成 redirect:error 只能解决 HTTP 自动重定向；仍无法用现有 fetch 选项绑定 DNS 预检结果。直接把 URL host 换为 IP 会影响 TLS/SNI/虚拟主机与 Cookie 语义，不能宣称为同等体验的修复。只关闭浏览器路径虽可 fail-closed，但无法满足本轮正常公开域名访问目标。

据用户方案书“无法在浏览器侧实现可靠的请求前安全检查”停止条件，暂停相关实施及真实浏览器联调；不新增 debugger/proxy/nativeMessaging 等权限，不用自动化全绿掩盖该门槛。

建议下一步：先审核受控测试浏览器的出站边界设计（例如连接层固定 DNS/IP 且拒绝私网的代理或系统级隔离），明确所有浏览器请求如何受约束、凭据如何保留、是否需要新权限、CDP/扩展/直连如何一致 fail-closed，再恢复阶段 1。该方案尚未实现，不能视为已解决；需要用户确认是否扩大到该架构设计范围。另一选择是先禁用浏览器获取，单独收尾本地导入与桥的文件完整性，但这不能作为本轮完整发布验收。

## 分阶段状态

- 已通过：版本接力与隔离工作区；71/745 自动化；两端类型检查；WebUI 构建；本机运行时清单核验与 runtime 实测。
- 未通过：冻结依赖安装；浏览器请求前安全；现有 .part/并发/隐私门槛；SSM review 未审核。
- 环境阻塞：首次 ZIP 缺失已恢复，不再沿用“主电脑缺归档”；真实宿主隔离测试环境尚未建立。
- 尚未测试：第二轮修复后回归、真实 Edge/Chrome、实际 Coopanion、自主选书真实端到端、12 类真实质量样本、20/50/100MiB 性能、最终官方 describe/check、发布包检查。
- 已知风险：现有浏览器/CDP/Node 出站 DNS 与预检脱节；CDP 可产生子资源请求；旧报告把事后防护当作请求前防护。
- 需要用户确认：超出现有网络实现的受控出站架构设计范围。未合并、未升级、未部署、未推送本轮分支。

本报告是阶段 0 与 P0 审查检查点，不是第二轮最终 16 项审核包。阶段 0 完整门槛未达成，阶段 1–6 未完成。

## 完整 world 验证补记

恢复 ZIP 后重新运行默认 `npm run verify:world`：隔离 FakeHost 搜索命中《狂人日记》作者“猪尾巴”（脚本仅按标题选 exact，不是鲁迅作品身份已确认），下载 74/74 章后仍处 validating。因本轮安全停止条件已触发，主动结束已核实命令行的该验证 Node 进程树（PID 14524，及其子进程），未等到脚本的 30 分钟上限；这不是测得超时，也不据此认定必现死锁。未获得完整入架结果，记为中止/未完成，不能写验证通过。进程证据、原始日志与中止说明位于 `_verify/`；临时目录保留供复查，没有操作生产书架。
