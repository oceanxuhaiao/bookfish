# Codex 第二轮后续执行任务书：BookFish TXT 获取模块可靠性修复与 MV3 隔离联调

**仓库：** oceanxuhaiao/bookfish

**当前分支：** `codex/txt-acquisition-hardening`

**当前 HEAD：** `40858d931641f42fe40c84470f848b1361bb63c1`

**产品版本：** 0.63.0

**任务性质：** 代码缺陷修复、导入容错完善、浏览器扩展隔离联调、真实小说验证。

**开发原则：** 不推倒重写，不破坏已经完成的 WFP 实验和现有 SSM。

## 一、首先接管现有工作区

在开始任何修改前，检查：

```powershell
git status --short --branch
git branch -vv
git log --oneline --decorate -15
git remote -v
git worktree list
git fetch origin --prune
```

必须确认：

1. 当前工作区是否位于 `codex/txt-acquisition-hardening`。
2. HEAD 是否为 40858d9 或其后续提交。
3. 原有 `feature/txt-acquisition` 是否存在。
4. 第二轮分支是否已经推送。
5. 是否存在未提交修改。

本轮已经有独立开发分支，不要无意义地重新建立分支。

原有 SSM 工作区可能包含其他开发成果，禁止覆盖、清理、强制重置或切换其工作区。

所有修改继续在当前独立 Worktree 中进行。

阅读：

- `AGENTS.md`
- `docs/txt-acquisition/PROGRESS.md`
- `docs/txt-acquisition/ROUND2-IMPLEMENTATION-REVIEW.md`
- `docs/txt-acquisition/ROUND2-CONTROLLED-EGRESS-DESIGN.md`
- `docs/txt-acquisition/ROUND2-WFP-BROWSER-VERIFICATION.md`

## 二、阶段1：修复现有 P1 代码缺陷

允许连续自主完成，不需要每项修改单独等待审核。

### 1.1 修复 failed_recoverable 状态转换

涉及：

- `src/txt-acquisition/types.ts`
- `src/txt-acquisition/acquisition.ts`
- 对应测试文件。

确保保留原始文件的 `failed_recoverable` 任务可以正常执行：

- retry。
- repair。
- validating。
- importing。
- completed / completed_with_warning。

增加测试：

1. 下载成功、导入阶段发生可恢复异常。
2. 原始文件被保留。
3. 任务进入 failed_recoverable。
4. retry 能从原始文件重新导入。
5. repair 能从原始文件生成新版本。
6. 旧书籍和阅读进度不受影响。

不能只测试网络失败后重新下载。

### 1.2 修复混合编码自动修复

涉及：

- `src/txt-acquisition/repair.ts`
- `src/txt-acquisition/quality.ts`
- `src/txt-acquisition/acquisition.ts`

取消单纯以最少替换字符数决定全局编码的策略。

新增真实中文混合编码测试：

- UTF-8 中文正文。
- 后半部分追加较长 GBK 正文。
- 另一个反向顺序的测试。
- 普通 UTF-8 文件只有少量损坏字节。
- 完整 GBK 文件。
- UTF-16 文件。

要求：

- 不得为了减少替换字符而损坏原本正确的正文。
- 不确定的部分可以保留替换字符。
- 自动修复不能比原始导入结果更差。
- 必须保留原始字节文件。
- 修复后的新版本不能覆盖旧版本。

对于不能安全自动修复的混合编码，允许输出 warning，并保留人工指定编码的修复入口。

### 1.3 修复网页中文编码

涉及：

- `extension/background.js`
- `src/txt-acquisition/bridge.ts`
- `src/txt-acquisition/link-discovery.ts`

支持：

- UTF-8。
- UTF-8 BOM。
- GBK / GB18030。
- HTML meta charset。
- HTTP Content-Type charset。

不能把所有 HTML 都默认当作 UTF-8。

增加 GBK 中文资源网页测试，确认：

- 页面标题正确。
- TXT 链接正确。
- 作者识别不被乱码破坏。
- 相对下载链接仍能正确解析。

下载的 TXT 文件继续原始字节无损传输。

### 1.4 让原始文件配额真正生效

涉及：

- `src/txt-acquisition/acquisition.ts`
- `src/txt-acquisition/staging.ts`
- `src/txt-acquisition/records.ts`
- 必要的设置界面。

目前 `prune()` 没有实际调用者。

需要建立自动安全清理机制：

- 初始化后检查。
- 任务完成后检查。
- 任务失败后检查。
- 不存在活动任务时才能执行删除。
- 优先清理无引用的过期原始文件。
- 不得删除仍然被失败任务、warning 任务引用的唯一原件。
- 任务记录被 trim 时，必须考虑对应原始文件的引用关系。
- 超过配额但无法安全删除时，明确记录原因。

不能为了严格达到配额而牺牲补正能力。

### 1.5 解决大文件内存问题

涉及：

- `src/stream-import.ts`
- `src/txt-acquisition/repair.ts`
- `src/txt-acquisition/acquisition.ts`

当前99MiB样本峰值约481MiB。

优先实现：

- 流式解码。
- 流式规范化。
- 增量统计质量指标。
- 避免完整 Buffer、完整字符串和规范化字符串同时驻留。
- 对大型导入设置合理的并发限制。

保持原有100MiB文件上限，不能通过简单降低上限来掩盖问题。

测试20MiB、50MiB、99MiB。

提供新的峰值内存对比。

### 1.6 修复导入回调异常隔离

涉及：

- `src/txt-acquisition/acquisition.ts`
- `src/selection.ts`

文件已经成功导入后，SelectionCoordinator 回调异常不能反过来把文件导入状态标记为失败。

分别记录：

- 文件导入结果。
- 自主选书队列接入结果。

确保队列接入失败不破坏已入架书籍。

### 1.7 修复浏览器就绪状态

涉及：

- `src/txt-acquisition/acquisition.ts`
- `src/world.ts`
- `src/config.ts`
- `src/webui/settings.ts`

当前浏览器桥接运行不代表浏览器保护控制器就绪。

修改状态语义：

- transportConnected：扩展已连接。
- controllerReady：安全保护控制器已就绪。
- browserReady：允许真正派发浏览器任务。

没有控制器时：

- browserReady 必须为 false。
- 不得向模型报告浏览器可用。
- 不得因为桥接配对成功就允许任务执行。
- 设置界面明确显示当前不可用原因。

同时修正「日常浏览器」相关描述。

不能让用户误以为启用扩展后就能安全地操作日常浏览器。

## 三、阶段2：完善隔离 WFP 实验，真实联调 MV3

这一阶段继续使用独立实验环境，不操作日常浏览器。

### 2.1 修正 WFP 端点规则

当前实验只允许一个精确的本机 TCP 端点。

扩展实际需要：

1. 固定 IP 代理端点。
2. BookFish 本地桥接端点。

扩展必须能够：

- 连接桥接服务。
- 获取任务。
- 发送心跳。
- 上传文件分块。
- 提交完成回执。

代理必须能够：

- 转发经过验证的公网请求。
- 拒绝未授权主机。
- 拒绝非80/443端口。
- 固定已验证的公网 IP。

其他 TCP/UDP 和任意回环端口必须继续阻断。

### 2.2 解决精确回环例外

重点验证：

`--proxy-bypass-list=<-loopback>`

与扩展访问本地桥接服务之间的关系。

必须证明：

- 访问代理端点走受控代理。
- 访问桥接端点只走精确授权的本地连接。
- 其他127.0.0.1端口不能直接访问。
- 不允许通用 loopback bypass。
- 不允许 DIRECT 回退。

不得凭启动参数推断正确，必须使用真实浏览器和服务端连接计数验证。

### 2.3 使用独立浏览器可执行文件

WFP 按 AppId / 可执行文件路径识别浏览器。

独立 user-data-dir 不足以隔离日常浏览器。

继续使用 `_verify/wfp/` 内独立浏览器副本或经过验证的独立浏览器发行包。

不得把 WFP 规则安装到日常 Chrome 或 Edge 的可执行文件路径。

### 2.4 真实 MV3 扩展测试

在独立 Chrome 配置文件中实际加载 `extension/`。

验证：

1. 配对。
2. 连接。
3. discover 页面。
4. 返回候选。
5. 下载 TXT。
6. 4MiB 分块传输。
7. 完成哈希复核。
8. 取消。
9. 撤销来源权限。
10. 修改令牌。
11. 扩展重启。
12. 浏览器重启。
13. 双消费者竞争。
14. 任务租约过期。
15. 下载失败后重试。

必须确认：

- 撤销权限会立即取消正在进行的任务。
- 旧任务迟到数据不会污染新任务。
- 浏览器桥接与代理端口都受到精确限制。
- 代理停止后不能直接连接公网。

先完成 Chrome，之后再验证 Edge。

### 2.5 完善网络负向测试

继续使用受控 canary，测试：

- TCP IPv4/IPv6 直连。
- 回环其他端口。
- 本机局域网地址。
- UDP IPv4/IPv6。
- 实际 QUIC。
- WebRTC。
- DNS 泄漏。
- 代理停止。
- 代理错误配置。
- 扩展卸载。
- 系统 DNS 服务代发流量。
- 保护规则重启和清理。

不能把一般 UDP canary 成功等同于 QUIC 已验收。

所有测试仅在 `_verify/wfp/` 隔离实验范围内进行，结束后核对所有 WFP 规则已经清理。

不得修改日常浏览器、全机默认防火墙、系统代理或生产 Coopanion。

## 四、阶段3：真实小说端到端验证

### 3.1 样本要求

不再仅依靠合成样本。

优先使用用户提供的、过去曾经被严格机制拒绝但人工阅读判断质量尚可的 TXT 文件。

如果样本不足，可以使用合法公开的公版小说。

至少覆盖：

- 正常 UTF-8 小说。
- GBK/GB18030 小说。
- 少量乱码。
- 混合编码。
- 章节标题错误。
- 缺章。
- 重复章节。
- 广告。
- 末尾截断。
- 部分正文。

### 3.2 实际获取测试

使用合法公开的资源网页。

完整验证：

资源网页 → TXT 链接发现 → 文件下载 → 原始字节校验 → 宽松导入 → 书架。

记录原始文件与暂存文件 SHA-256。

不能使用仅有RFC测试文档的下载结果代替小说测试。

### 3.3 阅读质量验证

每本测试小说检查：

- 开头正文。
- 中间正文。
- 末尾正文。
- 章节分段。
- 编码损坏情况。
- 阅读索引。

对warning和partial文件，重点验证是否仍然能够正常阅读。

导入测试不得自动增加 confirmedChars。

Gold Data 不进入普通用户阅读流程。

## 五、阶段4：产品浏览器控制器方案设计

这一阶段先形成产品设计，不得直接修改用户系统网络配置。

需要提交：

1. 独立浏览器可执行文件方案。
2. 独立配置文件方案。
3. 固定 IP 代理方案。
4. 代理与桥接双端点白名单。
5. WFP 安装和卸载生命周期。
6. 管理员权限需求。
7. 控制器崩溃后的 fail-closed 行为。
8. 系统重启后的恢复。
9. 浏览器升级后的 AppId 重新验证。
10. DNS 与共享系统服务边界。
11. 登录态使用说明。
12. 安装、卸载和回滚方案。

第一版优先考虑 MV3，CDP 继续保持独立实验或关闭，不要同时扩大两条浏览器控制路径。

用户必须在独立浏览器配置文件中正常登录自己有权访问的网站。

不导出日常浏览器 Cookie。

不安装本地根证书。

不绕过 DRM、登录、验证码和付费墙。

需要新增管理员级系统权限、持久 WFP 规则或签名安装器时，先提交方案等待用户确认。

## 六、阶段5：SSM、依赖与发布收尾

### 6.1 SSM

执行：

`npm run check:ssm`

保留现有 review 项。

不得执行 `--accept-review`。

不得修改：

- 阅读进度。
- 阅读确认。
- 阅读回执。
- Persona Memory。
- Story Index。
- 阅读足迹自主决策。
- Gold Data 使用边界。

### 6.2 依赖

检查 npm audit 的7项问题。

优先处理已被打包进运行时的 `yauzl`。

更新后重新构建 `lib/zip-worker.mjs`，执行 ZIP 导入和 runtime 验证。

其他 devDependencies 单独评估，不使用 `npm audit fix --force` 盲目升级。

明确 pnpm-lock 和 package-lock 的权威关系。

### 6.3 完整验证

```powershell
npm test
npm run typecheck
npm run build:webui
npm run verify:world
npm run verify:runtime
npm run check:ssm
pnpm describe:extension
pnpm check:extension
```

按项目实际 AGENTS 工作流补充冻结安装、打包和回归命令。

必须重新统计测试文件和测试用例。

### 6.4 交付

更新所有审核文档。

特别注明：

- 已通过。
- 尚未通过。
- 环境阻塞。
- 真实浏览器验证范围。
- 未完成的产品控制器。
- 真实小说质量结果。
- 内存性能变化。
- SSM review 状态。
- npm audit 处理结果。

继续保持0.63.0，只有正式发布验收通过后才提出版本升级。

## 七、提交与权限边界

允许：

- 连续自主修改代码。
- 新增测试。
- 修复问题。
- 完成隔离浏览器实验。
- 更新审核文档。
- 提交当前开发分支。
- 经过本地验证后推送 `codex/txt-acquisition-hardening`。

禁止：

- 合并 main。
- 覆盖原 SSM 工作区。
- 安装日常浏览器 WFP 规则。
- 修改全机防火墙默认策略。
- 操作日常浏览器登录态。
- 自动接受 SSM review。
- 部署生产版本。
- 把实验结果伪装成产品验收。

## 八、阶段停止条件

完成本地代码修复、隔离 MV3 联调和真实小说测试后，提交完整审核包。

涉及正式 WFP 控制器、系统权限、专用浏览器安装器和生产网络策略时，必须先提交设计等待用户审核。

不得因为隔离实验通过，就自行实施生产级系统变更。

**最终目标不是让浏览器扩展显示已连接，而是让大肥鱼真正能够安全地发现资源、获取小说、宽松导入，并在失败时恢复，同时不损害原有 SSM。**