# P1-7 实际消费字节鉴别

源码候选：`12d8a03dfbcc96e41f4ccc53d927a4c789d4818c`。版本0.63.0，分支codex/txt-acquisition-round4。

专项 PASS，原生路径攻击残余同02。历史35e364a验证后替换snapshot一字节仍可完成入架。当前prepareFileBestEffort在实际打开的同一个fd上对真正消费的字节计算SHA-256，对比任务原始hash/size；不能只相信snapshot路径或预先统计。生成canonical时记hash，Library分页索引实际消费后再次对比；canonical被替换也拒绝提交。

commitRaw哈希固定打开的源fd，检查源身份和link后的目标身份/hash；已存在同hash对象也检查；记账失败不删除有效唯一原件。测试覆盖same-size Snapshot替换、删除、canonical替换、hash后源路径替换，拒绝并保留任务原始hash/原件，不伪造质量失败。

src/stream-import.ts及staging.ts；tests/txt-acquisition-round4*.test.ts。对正常完整原件retry、repair和错误保留的第三轮回归仍通过。

源码定位（1基行号）：

- `src/stream-import.ts`：103, 183, 263
- `src/txt-acquisition/staging.ts`：45, 58, 62, 70, 71, 72, 77, 79, 94, 105, 128, 133, 139, 146, 152, 155, 165, 167, 173, 174, 176, 182, 200, 213, 227, 251, 256, 263, 270, 282, 284

证据统一索引：[evidence/COMMANDS.md](evidence/COMMANDS.md)。所有历史失败保留；报告是执行者待审查主张。

补充r4-link-faults.log：直接注入实际fs.promises.link的EBUSY、ENOSPC，两次均保留源文件，移除故障后可提交；committed阶段记录ENOSPC则保留新raw与part，重试复用相同可信内容。三个用例也纳入全量907项。不是仅mock整个commitRaw方法。
