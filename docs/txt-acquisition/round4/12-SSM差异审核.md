# SSM差异与独立审核

源码候选：`12d8a03dfbcc96e41f4ccc53d927a4c789d4818c`。版本0.63.0，分支codex/txt-acquisition-round4。

执行者只提交技术差异与回归证据，不自动accept-review。分别保留c440c03、40858d9、d5878f9、35e364a检查。main的七项共享文件完整基线与差异在审核包。blocked=0且review>0应读作“没有阻断项，但仍等待独立审核”。产品语义与SSM保护负责人结论均未取得，不能报告完整PASS。新增新书confirmedChars0，无伪造阅读Episode，无未读Persona注入；确定性本地逻辑未增加模型调用，不虚构Token收益。

证据统一索引：[evidence/COMMANDS.md](evidence/COMMANDS.md)。所有历史失败保留；报告是执行者待审查主张。

## 本轮SSM实际结果

|比较|blocked|review|结论|
|---|---:|---:|---|
|固定main c440c03→当前候选|0|7|没有阻断项，但仍等待独立审核|
|40858d9→当前候选|0|4|没有阻断项，但仍等待独立审核|
|d5878f9→当前候选|0|2|没有阻断项，但仍等待独立审核|
|35e364a→当前候选|0|2|没有阻断项，但仍等待独立审核|

本轮两个共享文件为stream-import.ts（宽容流式导入的实际消费认证，不改严格入口）和world.ts（创建时关联、取消及设置变更传递）。完整七文件原文放入审核包SSM基线。此次检查退出1是review待批准，不写成全部通过。日志r4-ssm-*.json和r4-ssm-default.log；未使用accept-review。

源码定位：src/stream-import.ts:196；src/world.ts:83。

