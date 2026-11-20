# 受控浏览器出站实验（仅实验，不可部署）

这组程序验证 Windows WFP 对独立浏览器副本的 TCP/UDP 限制，以及浏览器经固定 IP CONNECT 代理下载公开 TXT 的字节一致性。它不安装 BookFish 扩展、不挂载 Coopanion，也不修改生产代码。

## 范围与前置条件

- Windows x64、管理员权限、BFE 正常运行、本地 .NET Framework 4 编译器、Node + tsx。
- 当前实测浏览器为本机已有 Chrome 158.0.8127.36。不得从日常 profile 拷贝数据。
- 在包内 `_verify/wfp/browser/` 独立复制 chrome.exe 及其版本资源目录。不能改为直接使用 Program Files 的原始 exe。该副本不随交付包分发；浏览器受其自身许可约束。
- WfpLab 只接受 `_verify/wfp/` 内的 manifest，且目标 exe 必须在同一实验目录下。没有全机默认策略变更，也没有禁用系统或浏览器沙箱。

## 程序

- `WfpLab.cs`：P/Invoke 使用 Windows 自带 fwpuclnt.dll。每个目标路径三条过滤器：V4 精确 127.0.0.1:实验端口 的 TCP permit，V4 默认 deny，V6 默认 deny。专用 sublayer/GUID；事务添加。过滤器及 sublayer 持久化，使控制器退出不会自动撤防；清理必须按清单显式删除。
- `SocketProbe.cs`：TCP/UDP 正向/负向测试客户端。UDP send 返回成功不等于目标收到；必须结合目标端计数。
- `verify-wfp.mts`：真实 Chrome headless、独立配置文件、TCP 连接计数与 STUN UDP 接收计数的对照实验。测试前先检查 canary 正向可达。只允许实验端口，主动用 `--no-proxy-server` 验证浏览器绕过代理配置也不能访问其他端点。
- `verify-public-browser.mts`：独立 Node 固定 IP 参考下载 + Chrome 正常 TLS 经 CONNECT 下载 RFC 1149 TXT；比较大小与 SHA-256，并测试删除代理配置、停止代理。

编译示例（在包根 PowerShell 中）：

```powershell
$labRoot = (Resolve-Path _verify/wfp).Path
$sourceRoot = (Resolve-Path scripts/txt-egress-lab).Path
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /platform:x64 "/out:$labRoot\WfpLab.exe" "$sourceRoot\WfpLab.cs"
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /platform:x64 "/out:$labRoot\SocketProbe.exe" "$sourceRoot\SocketProbe.cs"
node --import tsx scripts/txt-egress-lab/verify-wfp.mts
node --import tsx scripts/txt-egress-lab/verify-public-browser.mts
```

脚本会短暂在主机的一个 IPv4 局域网接口开设只返回测试文字的 TCP canary，以及回环 TCP/UDP 端点；不会访问其他局域网主机。实验只证明所记录端点/协议的行为，不等于所有网络机制均已覆盖。

## 恢复与限制

正常结束和已捕获的断言失败均执行 finally：结束浏览器测试，关闭实验服务并按 GUID 清除 WFP 对象，查询应为 found=0。若进程被强杀或机器断电，持久化过滤器会留下，保持实验副本被限制；先终止该副本的全部进程，再对对应 manifest 执行：

```powershell
& "$labRoot\WfpLab.exe" remove "$labRoot\filters-实际编号.txt"
& "$labRoot\WfpLab.exe" verify "$labRoot\filters-实际编号.txt"
```

verify 在全部过滤器不存在时输出 found=0 并返回 exit 2；不能将这一清理核验退出码当作规则安装失败。清理器只删除 manifest 中的专用 GUID，不枚举或修改其他程序的过滤器。不要删除整个 WFP 策略、关闭 BFE 或改全机防火墙默认值来恢复。

这些是实验工具，没有签名安装器、受限提权服务、完整产品级生命周期或代理认证/租约。共享系统服务（如系统 DNS）代发流量、BFE/系统重启、完整 QUIC 服务器、远端公网 canary 与产品扩展链路仍未专项验收。不得把实验工具装入生产环境。
