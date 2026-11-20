# 第二轮代码收尾与人工审核包（2026-11-21）

状态：隔离分支上的安全修复和自动验证已完成；发布验收尚未完成。版本仍为 0.63.0。未推送、合并、部署或触碰生产书库。

## 代码与安全边界

- 分支 codex/txt-acquisition-hardening；基线 origin/main c440c03，上一实验提交 88e6847。原 SSM 脏工作区未修改。
- 桥接协议 v2：任务消费者租约、attempt、独立 wx 临时文件、分块序号、过期回收、取消与失败清理、磁盘 SHA256 重算和字节数核对。旧客户端不能继续上传。
- 初始页、下载和最终地址均校验；Node 原生 HTTP/TLS 固定已验证 DNS 地址，跳转逐跳检查。浏览器桥接缺少独立 authorize 保护即拒绝，正式 World 目前未接入产品级 WFP 控制器，因此浏览器获取保持阻断。
- CDP 在导航前禁脚本／服务工作线程，拦截 Document 和响应流，拒绝跳转、子资源和超过 8MiB 的页面。此路径对压缩文档暂时拒绝，属于兼容性限制。
- 扩展移除固定 all_urls，按来源申请可选权限，运行时精确 origin 白名单；撤销来源／配对设置时中止。页面 8MiB、文件 100MiB，保留原始非 UTF8 字节，HTTPS 才带登录态，不导出 Cookie。
- 任务记录只保留 origin、URL 哈希和重新发现标记；错误信息去凭据。重启后有路径／查询的资源必须重新发现。既存 corrupt 备份仍可能含历史敏感数据，需按本机文件权限处理，不能宣称历史全盘擦除。
- 原件按内容哈希不可覆盖；配额计入受保护原件，不能安全回收时报告不足；不因重复导入删除其他失败任务引用的原件。
- 宽松路径允许短篇、多文字体系和有可读正文的局部损坏，保留质量警告；严格导入入口和共享 stream-import.ts 本轮未改。没有互联网搜索或模型调用。

## 实际验证

| 验证 | 结果与范围 |
| --- | --- |
| 全量测试 | 75 文件、778 项通过；另撤销授权专项 6 项通过 |
| 类型／构建 | 双端 tsc、build:webui 均通过 |
| 官方契约 | describe:extension、check:extension 通过；为临时默认配置构造检查，start 未调用，不是宿主验收 |
| 依赖 | npm ci 与 pnpm frozen 安装恢复，Cortico 固定基线 0.2.13；新增 npm 锁及更新 pnpm 锁，package.json 直接依赖未变 |
| 打包 | npm pack dry-run 成功，110 文件，包含 extension 和新增运行时代码；不含 _verify、output、测试与实验脚本；最终重查 1598274 字节（dry-run），扩展说明已更新 |
| 真实浏览器 WFP | Chrome 副本的直连 TCP4/6、回环、局域网接口和 STUN UDP4/6 强制阻断；正向对照、错误代理、控制器退出、代理停止均有计数证据。所有实验规则按 GUID 清除 found=0 |
| 真实 Chrome 公共 TXT | CONNECT 获取 RFC1149 3215 字节，SHA256 a8660fa4f47bd5e3db1cd5d5baad983d8b6f3f1e8a1a04b8552f3c2ce8f33c18；生产 Node 固定地址传输结果相同 |
| 真实 CDP 生产代码 | 正常页可读，302 和 8MiB+1 被拒，禁止目标连接与子请求均为 0；局部夹具，未安装 MV3、未加载 Coopanion |
| 容错矩阵 | 12 合成／派生可读样本入架、4 负对照拒绝，原件不变，confirmedChars=0；真实小说来源 HTTP503，真实小说数量0、人工阅读评审未完成 |
| 性能 | 20/50/99MiB 合成文件分别约 decode 379/618/1038ms、import 1326/3302/7138ms；99MiB 峰值 503922688 字节（约481MiB）。这是修改前基线，无优化效果声明 |
| runtime/world | real Java21 桥接健康与来源探测通过；World --no-fetch 用 FakeHost+真实runtime/search，通过但不是实际宿主。搜索返回同名“狂人日记”作者“猪尾巴”，未视为鲁迅作品或继续导入；先前完整下载中断未通过 |

原始脱敏日志在 round2-evidence/p0；WFP 前阶段证据见 round2-evidence/wfp 和 ROUND2-WFP-BROWSER-VERIFICATION.md。所有自动验证均未调用模型；没有可报告的模型 Token 节省实测。

## 仍须人工审核／实际操作

1. SSM 负责人审核：相对 origin/main 仍 blocked=0、review=7（describe、env_prompt、config、library、stream-import、tool-schemas、world）；相对本轮 88e6847 仅新增 describe.json review。官方生成纠正了既存 lookup 描述不一致并带入环境提示词换行变化，没有修改对应业务源码。未执行 accept-review，检查退出1是审核门槛，不是通过。
2. 审核受限提权控制器的产品化边界：当前 WFP 是管理员实验工具，没有签名安装器、受限提权服务、完整代理鉴权和生命周期。共享系统 DNS 服务、BFE／系统重启、完整 QUIC、远端实体 canary 均未证明。不得解除正式入口保护或将实验脚本当生产组件部署。
3. 审核后在独立浏览器手工加载 extension：本机品牌 Chrome 不再支持命令行 load-extension；需要开发者模式加载操作，随后验证真实 MV3 来源授权／撤销、登录态、租约、故障清理。再用独立数据目录的 Coopanion 验证完整宿主链路，不能拿日常实例或生产书库代替。
4. 提供有权使用的真实历史拒收样本／小说，执行人工可读性检查、缺章／混编码／正文保真和实际宿主进度核对。合成样本不能代替这项验收。
5. 审核依赖已知风险：npm audit 7项（4中、1高、2严重），主要旧测试工具链；yauzl 3.2.0 也被打包 worker 使用，不能简单排除 devDependencies 宣称运行时安全。未自行跨版本升级。

下一步：先审阅本包和 SSM 差异；确定控制器方案及隔离 MV3／Coopanion 手工操作安排后继续联调。目前不可发布。
