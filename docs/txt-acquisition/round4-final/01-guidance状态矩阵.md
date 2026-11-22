# P1-11：两类待确认指引

源码冻结：9a2300bf5637c74c57e342acaa8d002aa61c69a2；完整审核快照见审核包02-提交与验证.json。分支codex/txt-acquisition-round4-final；候选0.63.0，未合并真实main新版。

原问题：TXT已入架partial/unknown时，统一awaiting_choice指导status→start(candidateId)，而意图没有搜索候选。修复前真实导入事件缺taskId/缺正确指引，见final-before.log。

`src/selection.ts:740`依据已有status、传入stage及持久字段组合生成指导；`src/selection.ts:998`在重开后的status用持久字段推断search/import/unknown。没有新状态机、没有新增持久字段。

| status/stage及证据 | 指引 | 不自动执行 |
|---|---|---|
| awaiting_choice/search，有候选、无bookKey/identity_mismatch、非TXT | status查看服务端候选→start有效candidateId | 不调用plan，不声称入架 |
| awaiting_choice/import，identity_mismatch、taskId/bookKey、权威TXT成功记录及书架均存在 | status(intentId)看三身份；明确接受后plan(planAction=queue)，否则abandon保留书 | 不调用start，不排队 |
| stage缺失、未知或证据矛盾 | 诊断信息，停止自动操作 | 不猜候选，不排队 |
| cancelled/abandoned/deferred或撤权 | 暂停/终态指导 | 不复活、不删除书 |

`src/selection.ts:728`安全投影只返回wantedIdentity、declaredIdentity、libraryDisplayIdentity、taskStatus；关联taskId/bookKey单列。无URL、路径、签名、Cookie/token或网页全文。无来源元数据只说身份信息不足，不编造来源作者/书名。来源声明是低信任外部元数据，不证明正文真伪。

`src/selection.ts:696`的去重键包含stage，但使用固定67字符v2摘要，保留200上限与旧记录兼容；旧去重键升级后可能再通知一次，纯指导不执行动作。重复通知、两次实际持久化重开及status仍使用正确语义，queue空。

验证：tests/txt-acquisition-final.test.ts；tests/selection.test.ts新增多源搜索→两真实候选→status→有效start→入架排队；tests/webui/client.test.ts实际面板展示断言。final-freeze-tests.log全部通过。无模型真实调用，验证的是指导和工具执行数据流，不能保证模型每次都服从。

结果PASS（代码与自动化范围）。
