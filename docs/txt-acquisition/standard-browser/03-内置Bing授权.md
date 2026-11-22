# 安装时内置 Bing 搜索授权

用户明确要求安装浏览器扩展后默认授权 https://cn.bing.com，不再让普通用户手动添加搜索网站。本次源码4ba8df5d1f3809e8295d75e2884a776b5af4d861，起点a7503ac，浏览器扩展版本0.65.1，协议仍v2；World仍本机0.65.1候选，非正式发布。

manifest必需host_permissions只新增精确 https://cn.bing.com/*。浏览器在扩展安装时统一处理权限；安装被接受后，内部来源策略默认启用该精确HTTPS origin，不要求用户手动写allowedOrigins。没有默认授予所有网站，不包含www.bing.com、子域名、HTTP或非默认端口；其他下载网站仍按需授权。

默认授权不等于绕过浏览器：后台仍调用chrome.permissions.contains，浏览器收回/限制网站访问时拒绝请求。弹窗可停用/恢复Bing来源，保存bingSearchEnabled=false后重启/更新不恢复；即使旧allowedOrigins还含Bing，停用仍优先。停用会中止在途任务。因Bing是manifest必需权限，弹窗停用只禁止本扩展派发，不谎称移除了浏览器必需权限；网站访问权限仍由浏览器扩展管理页决定。恢复被浏览器收回的权限只由用户点击触发request，不在加载时自动请求。

| 验证 | 结果 |
|---|---|
| 扩展Worker、弹窗、搜书与WebUI专项 | PASS：4文件41项，含精确来源、浏览器权限拒绝、持久停用、恢复、旧撤销入口和在途取消 |
| 类型、构建、帮助、官方describe/check | PASS |
| 新鲜安装/升级的真实浏览器权限对话 | NOT_TESTED：保留用户更新文件、重新加载并确认权限 |
| 真实宿主更新 | PASS：12书、1868124确认字符、836episodes、1700tasks及历史sum保持，用户普通模式/桥接/自主找书设置保留，恢复运行 |
| SSM | main blocked0/review10；本次起点blocked0/review0。累计没有阻断项，但仍等待独立审核 |
| 浏览器默认搜索实机效果 | PARTIAL：新版文件已准备，未替换浏览器当前加载的旧扩展或代接受权限 |

相关命令日志在evidence/builtin-bing：定向vitest、typecheck、build:webui、check:help、官方describe/check及SSM。首次弹窗测试因JSDOM URL与Node fs URL类型不兼容、文件在Node类型检查目录而失败；改用路径字符串并移至已有WebUI测试目录，保留初始日志，修复测试夹具后41项通过。没有为测试跳过真实权限contains检查。未重跑全量1059项，不将上一轮结果冒充本次。

交付包artifacts/BookFish-Bridge-0.65.1-builtin-bing-4ba8df5.zip仅含manifest、background、popup JS/HTML与README，解压根目录有manifest。SHA-256：7425b9b07669b4ba83dab77b1903b68553712ecb3b90770489b3871a845621fe。现有用户必须实际更新扩展文件后重新加载；仅重载旧文件不能获得新版行为。安装/升级可能出现浏览器新增网站权限提示，不自动点击确认、不访问个人Cookie/profile。Chrome规则参考：[声明权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[新增权限提示](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)。

无新增模型调用、工具或阅读语义变化，UI只改默认授权说明。未改系统网络、安装安全服务、push、发布或合并main；正式控制器与累计SSM审核边界不变。
