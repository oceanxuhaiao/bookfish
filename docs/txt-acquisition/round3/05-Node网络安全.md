# Node 网络安全与固定 socket

状态：PARTIAL；生产代码单测与一次真实 IPv6/TLS socket 观察通过，完整攻击环境矩阵尚未全部实网验证。不是浏览器隔离验收。

生产路径 `url-policy.ts → pinned-http.ts → download.ts`：默认 DNS lookup 使用 all:true，逐项检查全部返回地址；任一禁止地址拒绝整组。固定 lookup 回调只提供已检查地址，agent:false 避免连接池复用；请求保留原 URL Host/SNI，由 TLS 默认校验证书。每次重定向重新调用策略，最多五跳；没有自动代理或自动重定向回退。自定义端口现已拒绝，保留标准 HTTP/HTTPS。公网地址不意味着来源身份正确，verify:world 继续严格匹配作者及书名。

第三轮实际 socket：`scripts/round3-live-socket.mts` 订阅 Node diagnostics_channel，直接观察生产 fetchPinned，未替换 transport。example.com DNS 一次返回两项 A、两项 AAAA；remoteAddress=`2606:4700:10::ac42:93f3`、port=443，位于检查集合；Host/SNI 均 example.com，authorized=true，HTTP200，577 字节，未复用连接。证据 `evidence/r3-live-socket.json`。观察器初版订阅时机晚于 socket 分配，断言失败；修正观察器读取已分配 socket 后通过，未因此修改生产下载实现。

|矩阵|本轮证据/结果|
|---|---|
|IPv4/IPv6/IPv4-mapped 禁止范围|url 测试；生产 fetchPinned 混合答案拒绝测试 PASS|
|多答案混合|A+回环、AAAA+回环、A+mapped-private；请求事件数为0，PASS|
|DNS 后权限撤销|生产 fetchPinned 实际入口、异步 resolver 撤销后请求事件0，PASS|
|固定 socket/Host/SNI/证书|一次真实 IPv6 HTTPS PASS；真实 IPv4 独立探针 NOT_TESTED|
|重绑定|自定义 socket lookup 固定已验证 IP；一次解析证据 PASS；攻击 DNS 实网 PARTIAL|
|逐跳重定向/公网转内网/五跳限制|生产 beginDownload 注入响应测试 PASS；不宣称实际站点重绑定演练|
|HTTP↔HTTPS|两协议仅标准端口；双向实网重定向 NOT_TESTED|
|取消/超时/写盘错误|下载及桥接回归 PASS；ENOSPC 为注入，未填满真实磁盘|

命令：`node --import tsx scripts/round3-live-socket.mts`；`vitest run tests/txt-acquisition-pinned-round3.test.ts tests/txt-acquisition-url.test.ts tests/txt-acquisition-download.test.ts`，3文件26项通过，日志 `r3-pinned-matrix.log`。旧下载/URL测试同时重新运行，并非继承上一轮通过结论。

HTML 发现统一 decodeHtml 优先级，TXT 原始下载字节不经文本解码。下载与导入原件完整性见 02/03/04。此处没有管理员网络修改，也没有将 URL 校验结果替代真实 socket 地址证据。
