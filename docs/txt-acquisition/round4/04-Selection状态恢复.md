# P1-3/P1-4 Selection恢复与终态

源码候选：`12d8a03dfbcc96e41f4ccc53d927a4c789d4818c`。版本0.63.0，分支codex/txt-acquisition-round4。

专项 PASS。partial/unknown身份入架后持久queueOnImport=false、awaiting_choice；恢复和reconcileQueue均排除自动接入，明确plan queue才确认。新测试真正关闭Library并重开两次，队列仍空。

abandoned/cancelled/completed/failed受统一终态保护，onTaskTerminal、onExternalImport、fulfill与plan不复活终态；迟到重复回调不重复承诺。已取消任务若已有书架提交可记录已存在书，但不改变取消状态、不排队。

tests/txt-acquisition-selection.test.ts；源码src/selection.ts。旧的Selection持久化失败、队列写入失败、announce失败、回放幂等回归继续通过。没有改变真实已读语义。

源码定位（1基行号）：

- `src/selection.ts`：9, 19, 155, 156, 168, 238, 411, 447, 483, 486, 497, 591, 745, 785, 802

证据统一索引：[evidence/COMMANDS.md](evidence/COMMANDS.md)。所有历史失败保留；报告是执行者待审查主张。

最终ed020ae四种终态用例均真正关闭并重开Library后再发送迟到/重复回调；全量908项通过。
