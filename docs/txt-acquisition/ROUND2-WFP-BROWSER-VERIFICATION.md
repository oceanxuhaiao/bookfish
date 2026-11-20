# 浏览器强制出站阻断与真实代理联调报告

日期：2026-11-21（Asia/Shanghai）。基于 e00e9a0；本轮用户明确要求“验证浏览器直连、回环和 UDP 的强制阻断，再继续真实浏览器联调”。

结论：在独立 Chrome 副本中完成了请求范围内的 WFP 强制阻断实验，并继续完成真实浏览器经固定 IP CONNECT 代理取得公开 TXT、逐字节摘要一致性与代理停机测试。**没有完成 BookFish MV3 扩展 → World → 正式书架的端到端验证，也不能宣布全部 P0 或可发布性通过。**

## 环境、权限与保护范围

- Windows 10 Pro，build 19045；Hyper-V、Windows Sandbox、VirtualMachinePlatform Disabled，HyperVisorPresent=False。没有启用这些功能或重启系统。
- 当前管理员令牌可调用 WFP；BFE、mpssvc 运行。使用系统 fwpuclnt.dll 和本地 .NET Framework 4 csc 编译实验程序，没有下载或安装第三方网络驱动。
- 复制本机 Chrome 158.0.8127.36 的 exe 与版本资源到工作区 `_verify/wfp/browser/`，每次启动独立 user-data-dir；没有读取日常 profile、Cookie 或密码，没有安装新扩展、关闭沙箱、安装 CA 或解密 TLS。
- WFP 条件按实验副本的 ALE_APP_ID 精确匹配。没有给 Program Files 中的 Chrome/Edge、生产 Coopanion、全机程序添加规则；没有改全机默认防火墙、系统代理或 BFE 服务状态。
- 控制面程序使用独立 sublayer 与 GUID 清单，事务创建 persistent 过滤器，避免动态会话关闭即撤防。测试结束逐清单删除；最终所有清单查询均 found=0，实验 Chrome 进程已退出。
- 实验 canary 只在回环和本机已有一个 IPv4 局域网接口监听随机端口，仅返回测试文字；没有访问其他局域网设备。公网测试没有传入登录态。

## 实验实现

源码位于 `scripts/txt-egress-lab/`：WfpLab.cs、SocketProbe.cs、verify-wfp.mts、verify-public-browser.mts。README 提供编译、执行、故障恢复和边界。

每个被测程序仅有三条 WFP 过滤器：V4 的 exact 127.0.0.1:指定端口 + TCP permit；V4 default deny；V6 default deny。同一 sublayer 内以过滤器 weight 选择例外，未使用 CLEAR_ACTION_RIGHT 去覆盖其他系统安全策略，也未用 Windows Firewall 的“Block All + Allow”伪造优先级。

本轮第一次验证给 Chrome 副本和 SocketProbe 各装三条，第二次公网联调只给 Chrome 副本装三条。没有创建全局按进程名匹配的规则。WFP 管理器在实验过程中正常退出，过滤器仍然存在；另有强杀控制器后的实际探针验证。

实验的“代理端点”也是测试页面服务端点；Chrome 可在这一精确本地端点取得测试页面并执行网络探针。所有其他回环端口照常受阻，不能把允许一个实验端点解释为允许整个 127/8。

## 真实 Chrome 的对照结果

最终通过的完整 canary 运行编号：1795192738606。

| 项目 | 无过滤器的正向对照 | 过滤器安装后 |
|---|---|---|
| 页面 fetch → IPv4 回环 TCP canary | 目标连接数 >0，页面报告 reached | 目标连接增量 0；页面报告 failed |
| 页面 fetch → IPv6 回环 TCP canary | 目标连接数 >0 | 目标连接增量 0 |
| 页面 fetch → 本机局域网地址 TCP canary | 目标连接数 >0 | 目标连接增量 0 |
| RTCPeerConnection/STUN → UDP4 canary | 目标收到 5 个 STUN 数据报 | 接收增量 0，页面已发起 offer |
| RTCPeerConnection/STUN → UDP6 canary | 目标收到 5 个 STUN 数据报 | 接收增量 0，页面已发起 offer |
| UDP → 被允许 TCP 端口的同号端口 | 原生探针正向可达 | 接收增量 0，未把 TCP 许可错误扩大到 UDP |
| exact 本地允许端口 TCP | 正向可达 | 原生客户端成功连接，浏览器页面/hold 请求仍成功 |
| Chrome --no-proxy-server 顶层导航到禁止 canary | 首先已证明该服务可达 | 目标连接增量 0 |
| 错误代理端口且不允许 loopback 绕过 | — | 禁止目标连接增量 0 |
| 控制器被 taskkill 后 | — | 原生 TCP 仍返回 AccessDenied，6 条过滤器仍存在 |
| 完整清理 | — | 6 条过滤器均 not found，专用 sublayer 删除成功 |

TCP 以服务端 connection 计数，UDP 以服务端 message 计数，覆盖预连接而不仅是 HTTP 请求。无规则阶段与加规则阶段均使用真实 Chrome headless；不是 FakeSocket、伪造浏览器或只验证 Node fetch 参数。

原生 SocketProbe 补充验证 IPv4/IPv6 TCP 与 UDP。UDP send 可能返回 sent，但目标不收到；该回执不单独计为失败或成功。Chrome 有时在 dump-dom 中不给出内部 ERR_* 错误页，退出码也可为 0；因此不用浏览器文案或退出码替代目标端计数。

这是对本机这些 canary 端点的证明，不是对远端所有网络类型的穷举。局域网 TCP canary 在本机接口地址上，不等于已对另一台物理 LAN 主机采包验证。

## 真实公网 TXT 与固定 IP 代理联调

完整通过的运行编号：public-1795192958344。

公开测试文件：[RFC 1149 TXT](https://www.rfc-editor.org/rfc/rfc1149.txt)。这是一份合法公开网络协议文档，用于验证字节传输；**不是小说质量或入架测试**。

先由独立 Node HTTPS 下载，所有 DNS 结果经过策略校验，选择已核验 IPv4 并固定 socket lookup，Accept-Encoding: identity。再由受 WFP 限制的 Chrome 通过本机 CONNECT 代理下载同一文件。代理核对 allowed host/443，校验全部 DNS 地址，并用字面 IP 建立上游 TCP；浏览器进行正常端到端 TLS，代理不安装根证书、不读隧道中的 Cookie、签名查询或正文。

| 结果 | 实测 |
|---|---|
| HTTP 状态 | 200 |
| 独立参考字节数 | 3215 |
| Chrome ArrayBuffer 字节数 | 3215 |
| 两条路径 SHA-256 | a8660fa4f47bd5e3db1cd5d5baad983d8b6f3f1e8a1a04b8552f3c2ce8f33c18 |
| 字节数与摘要比较 | 完全一致 |
| 有效文件源站 CONNECT | 1 次 |
| 其他未在实验允许列表中的 CONNECT | 拒绝 6 次；不代表 6 次目标拨号 |
| 保留 WFP、删除代理配置后同一浏览器类型直接 fetch | TypeError，未取得正文 |
| 实际停止代理后新浏览器尝试禁止目标 | 目标连接增量 0，无直连回退 |
| 清理 | 3 条过滤器均 not found；专用 sublayer 删除成功 |

HTTP 200 加两路径字节摘要证明本次受控浏览器传输可行；不证明原 bridge 的 .part 生命周期、入架幂等、实际阅读或模型理解正确。

## 失败记录和修正

1. 初次通过 junction 复用浏览器资源，Windows SxS 启动失败；改用独立资源副本，之后真实 headless 启动成功。未修改日常安装目录。
2. `canary-run.log`：首轮错误要求 UDP SendTo 必须报 AccessDenied。实际上 Windows 可静默丢弃，发送端返回 sent。保留失败日志；断言改为目标端接收增量为 0，没有删除 UDP 测试。
3. `canary-run2.log`：所有 TCP/UDP 目标增量已为0，但额外断言 dump-dom 必须含 ERR_NETWORK_ACCESS_DENIED 不成立。保留该失败；顶层导航测试继续执行，以目标连接计数为验收。
4. `canary-run3.log`：上述对照、阻断、精确允许、控制器强杀及清理全部通过。
5. `public-browser-run.log`：最初选择 raw.githubusercontent.com 参考文件，独立 Node 下载超时，尚未安装 WFP 或启动浏览器该轮联调。保留原始错误；改用正常可访问且允许 CORS 的公开 RFC TXT，后续完整通过。
6. `public-browser-run2.log`：真实 Chrome 公网 TXT 字节、代理配置移除、实际代理停止和清理通过。

没有修改、删除产品测试用例；新增实验脚本不是产品的 745 项用例，不能加到已有自动化测试数量里。

## 验证与证据

- 两个 C# 程序由本机编译成功并在实际 WFP/套接字测试中执行。
- 两个新 TypeScript 实验脚本独立 `tsc --noEmit --strict ...` exit 0。
- `git diff --check` 通过；相对 e00e9a0，src/tests/extension/package.json/pnpm-lock.yaml/describe.json/lib 均无改动。
- 本轮没有改产品实现，未重跑或冒称新增通过 745 项全量产品测试；上一轮基线仍为71文件/745用例。
- 可携带原始结果：`round2-evidence/wfp/`，含三轮 canary、两轮公网尝试、结果 JSON、类型检查及最终清理查询。完整 DOM/stderr、profile、编译输出和浏览器副本只在本地 `_verify/wfp/`，不进入 npm 或审核源码提交。
- 使用的微软公开 SDK 头来自 microsoft/win32metadata 的 RecompiledIdlHeaders；记录内容 SHA-256，未把下载的头作为可执行程序。WFP 结构、GUID 和 ABI 按该原件核对。

## 实际边界与下一步

**本次已通过**：实验 Chrome 的非代理 TCP/回环访问阻断、STUN UDP4/UDP6 阻断、同端口 UDP 不继承 TCP 许可、精确允许、控制器退出后的持续过滤、真实代理 TXT 字节验证和实验对象清理。

**尚未测试或产品化**：Edge 真实运行、MV3 安装与 worker 协议、Coopanion 宿主、浏览器进程/更新生命周期管理、生产级提权与签名安装器、来源授权界面、BFE/系统重启与重装、受控 DNS 重绑定/302矩阵、完整 QUIC 服务器、远端公网/物理 LAN canary、共享系统服务（例如系统 DNS）代发流量的归属和限制。按 exe 路径过滤不能自动证明这些共享服务也按浏览器身份受限。

因此必须保留“实验链路已验证，产品浏览器入口尚未接入保护”的区分。不能把实验脚本直接接入当前 World 后对外开放；现有 P0（.part、领取租约、脱敏、读取限制、初始 URL 和扩展重定向）仍待修复。先完成这些修复和保护机制的产品生命周期设计，再开展真正的 MV3 → 桥 → 宽松导入 → SelectionCoordinator 隔离宿主联调。

本轮无模型调用、无 SSM/阅读进度/人格修改、无生产安装、无远程推送；不宣称 Token 优化效果。

## 官方依据

- [WFP 对象生命周期](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)：dynamic/static/persistent 生命周期区别。
- [FWPM_FILTER0](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0)：persistent 标志与过滤器条件。
- [按应用路径获取 App ID](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmgetappidfromfilename0)：本轮过滤器精确绑定实验 exe。
- [Microsoft SDK 头原件](https://github.com/microsoft/win32metadata/tree/main/generation/WinSDK/RecompiledIdlHeaders)：fwpmu.h / fwpmtypes.h / fwptypes.h。
