# 第二轮后续交付与审核结论（2026-11-21）

版本0.63.0，分支codex/txt-acquisition-hardening；本轮比较基线40858d9。代码修复完成并已通过本报告列出的检查；产品浏览器控制器、完整DNS强制隔离、真实Coopanion验收尚未完成，不可生产发布。

## 可靠性修复

失败原件可重新验证／重试／修复；导入成功后Selection回调异常单独报告，不推翻入库结果。自动维护在初始化及完成／失败后执行，活跃任务不删，保留原件引用不会被记录软上限裁掉；100个活跃任务拒绝继续添加。导入队列有界。

实际宽容入口改用磁盘上的流式解码及质量累计，不同时持有整个原始Buffer与多个全文字符串；严格TXT入口保持原逻辑。编码遵循开头证据，删除“替换字符最少即更好”的全局切换；混编码只能标记partial与mixed_encoding_suspected，另一编码部分仍可能乱码，不能宣称恢复全书。HTML按BOM／HTTP／meta／UTF8或GB18030解码，原TXT字节不改。transportConnected、controllerReady、browserReady分开；正式World未接产品控制器，后两项仍false。

## 实际验证

- 类型检查通过，77个测试文件、799项测试通过。覆盖原件重试、异步选择失败、配额和保留引用、混编码、HTML、小GBK及畸形ZIP时间字段。
- Chrome 158与Edge 157均跑通真实MV3、独立exe／配置、代理和桥接双精确端点WFP实验：4MiB分块和尾块、取消、权限撤销、令牌变化、下载失败重试、扩展管理页重启、双消费者30秒真实租约到期、迟到409、新文件哈希不变、浏览器重启、其他回环端口canary零命中、代理停止无DIRECT回退。Edge最终通过；此前原始TCP实验代理未处理RST导致崩溃，修正实验代码并清理后重跑通过。
- Chrome真实公开小说页面→链接→MV3下载→桥接→隔离书库完成。该早期整轮实验随后在“代理403应表现为fetch异常”的错误断言处失败，不能把整轮称通过；随后Chrome／Edge完整回归均为fixtures-only。权限在隔离管理页预批准，正常人工许可对话框未验收；临时调试加载扩展runtime.reload导致禁用，最终使用管理页禁用／启用验证，不能声称两种机制等价。
- 真实HTTP/3 canary有正对照；WFP启用后该请求零新增。局部自签证书仅以canary SPKI允许，没有安装根证书。之前单端点TCP4／TCP6／UDP4／UDP6／STUN负验证与本轮双端点MV3证据范围不同，不能合称所有组合均重跑。
- 关键失败：ETW记录浏览器受AppId规则限制时，Windows Dnscache共享svchost代发A／AAAA查询。直接解析域名52条事件；固定代理加禁用解析规则后，本次第二域名零事件。这是已确认的共享DNS边界缺口，启动参数不是强制隔离证明。见dns-sanitized.json。不得通过改全机DNS／防火墙补救。
- 实验专用过滤器按全部manifest再次查询found=0；无实验路径浏览器存活；临时DNS ETW会话已结束。没有修改日常浏览器配置或全局网络策略。

## 真实正文与内存

公版《红楼梦》Project Gutenberg 24264，GITenberg API与GWDG镜像获得相同2663312字节，SHA256 20c795971786fd8eb2a00d35a1194b6dd3074b2afb4f4cd5a82ba3e10fe5dfaa。1个真实原文加11个派生损坏／编码／章节样本全部进入隔离书库，原件哈希不变，confirmedChars均0，索引与开中尾正文探针可读。混编码仅部分可读；缺章诊断不保证识别中文数字章节。没有用户历史失败文件，没有真人阅读确认，没有真实宿主验收。

同一20／50／99MiB输入、同一40858d9脚本基线：峰值RSS分别213168128／276426752／475484160字节；本轮145833984／214548480／215347200字节。99MiB约下降54.7%，输出ID／字符数一致。解码耗时从187／468／897ms升至2150／5207／10262ms，导入约1294／3125／6091ms；这是单次采样，内存收益伴随CPU和总耗时增加。没有模型调用或Token优化收益主张。

## 工程与保护

yauzl 3.2.0升至3.2.1，修复NTFS时间字段越界；打包zip-worker同步重建。pnpm锁为权威，npm锁兼容保留，冻结安装与npm ci均成功。npm ci有现有Node24.14.1低于部分jsdom传递依赖24.15要求的engine警告。audit仍有6项（3 moderate／1 high／2 critical，旧Vitest／Vite开发工具链），未擅自大版本升级，不是零漏洞。

官方describe／check、构建、runtime检查通过，pack排除实验、测试及输出目录。完整verify:world因缺少精确书名与作者的搜索候选失败，已拒绝下载错书；--no-fetch通过只代表FakeHost和真实Java运行时，不代表Coopanion。SSM相对main检查blocked=0、review=7仍待负责人审核，检查器退出1不能写成全部通过；未使用accept-review。原SSM脏工作区未改动。未合并main、部署或提升版本。

## 人工审核边界

请先审核代码、SSM共享文件和[产品控制器方案](ROUND2-PRODUCT-CONTROLLER-PROPOSAL.md)。DNS共享服务缺口必须确定可强制执行的隔离边界；独立网络环境／VM仅为备选设计，未启用系统功能。正式管理员服务、持久规则、安装器及回滚器没有产品实现。方案审核后才能安排下一轮实现与真实Coopanion验收。不要把安全拒绝浏览器任务解释为产品功能完成。

原始Chrome完整fixtures回归日志的scope字符串误写public novel pipeline（脚本后来修正）；该日志只有大文件fixture，公开小说完成以public-novel-partial-run.jsonl单独为证。
