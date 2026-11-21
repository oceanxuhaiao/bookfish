# P2 Node网络权限撤销

源码候选：`12d8a03dfbcc96e41f4ccc53d927a4c789d4818c`。版本0.63.0，分支codex/txt-acquisition-round4。

专项 PASS。100ms检查权限撤销并取消传输，同时取消待headers和静默body；chunk、redirect及提交前再次检查。policy_blocked与用户cancel、timeout分别报告，不把网络权限撤销当超时。

测试实际本机受控HTTP仅替换测试传输；生产URL仍公共域名策略及固定IP通道。2种静默等待观察真实连接关闭，last-chunk/redirect撤销不提交、不二次请求。原DNS全答案与固定socket测试由全量回归验证，尚未把假传输算真实外部socket证据。

源码定位（1基行号）：

- `src/txt-acquisition/download.ts`：78, 190

证据统一索引：[evidence/COMMANDS.md](evidence/COMMANDS.md)。所有历史失败保留；报告是执行者待审查主张。
