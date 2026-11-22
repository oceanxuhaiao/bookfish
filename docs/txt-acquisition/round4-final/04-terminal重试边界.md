# 终止失败retry/repair调查

源码冻结：9a2300bf5637c74c57e342acaa8d002aa61c69a2；完整审核快照见审核包02-提交与验证.json。分支codex/txt-acquisition-round4-final；候选0.63.0，未合并真实main新版。

本轮不重构通用API。`src/txt-acquisition/acquisition.ts:689`与`src/txt-acquisition/acquisition.ts:734`允许显式操作；`src/selection.ts:534`在真实World绑定的Selection权威回调中对终态意图取消活动TXT任务，读取/入架前Abort生效。

| 调用 | 实际边界 | 证据 |
|---|---|---|
| autonomous failed_terminal关联failed意图→模型retry | 不重新下载，不调用Library导入，意图仍failed | 新增retry测试PASS |
| 同上→repair | 不重新入架，不创建承诺 | 新增repair测试PASS |
| autonomous failed_recoverable→明确retry | 原任务恢复，不默认换作品 | 前轮补充与本轮全量PASS |
| manual retained原件→用户repair | 通用API仍保留，不依赖自主意图 | 原件/编码修复既有测试本轮PASS |
| 已入架warning→repair | 允许既定用户补正，新revision不覆盖旧进度 | 原有回归本轮PASS |

前两个反例在修复前已通过，未发现本轮需新增的越权路径，因此不改retry/repair API。被终态阻挡的显式尝试可能将TXT失败记录改为cancelled，但Selection失败/当日作品去重和原件保持；不是恢复许可。若未来绕过World关联回调独立使用TxtAcquisition，它本身是通用导入组件，不等价于自主授权器，不能据此推导允许模型独立恢复。

终止失败既有自主协议继续限制同作换源/换版恢复；本轮只明确两个awaiting_choice，不改变旧自主轮次语义。用户若要把失败原件当人工任务处理，需独立明确操作，不复活原failed intent。

结果PASS（已绑定实际World业务逻辑的自动化边界）；真实模型行为与真实宿主尚未验收。
