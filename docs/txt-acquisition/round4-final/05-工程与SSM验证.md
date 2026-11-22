# 冻结工程结果

源码冻结：9a2300bf5637c74c57e342acaa8d002aa61c69a2；完整审核快照见审核包02-提交与验证.json。分支codex/txt-acquisition-round4-final；候选0.63.0，未合并真实main新版。

Node24.15.0，Windows，主pnpm依赖树；通过私有Node显式执行npm-cli，官方命令在state/cortico c376b91/API6执行。最终结果来自9a2300b源码，而非上轮945项。

| 命令 | 结果 |
|---|---|
| npm test | PASS，85文件963通过/1 POSIX跳过，总964 |
| npm run typecheck | PASS，双端 |
| npm run build:webui | PASS |
| npm run verify:runtime -- --zip <既有包> | PASS |
| npm run verify:world -- --zip <既有包> --no-fetch | PASS，不替代完整模式 |
| npm run verify:world -- --zip <既有包> | FAIL，无exact书名作者候选则拒绝错书 |
| npm run check:ssm | 1退出，没有阻断项，但仍等待独立审核 |
| pnpm describe:extension <dir> | PASS，16工具、10事件、1提示词 |
| pnpm check:extension <dir> | PASS |
| npm pack --ignore-scripts --json | PASS，不发布 |

| SSM比较 | blocked | review |
|---|---:|---:|
| 7332574 | 0 | 0 |
| 77a5af8 | 0 | 0 |
| 71cf8f3 | 0 | 3 |
| 12d8a03 | 0 | 3 |
| 35e364a | 0 | 4 |
| d5878f9 | 0 | 4 |
| 40858d9 | 0 | 6 |
| 08e0c7e | 0 | 6 |
| c440c03 | 0 | 7 |
| origin/main | 0 | 7 |

相对本轮7332574无新增受保护共享文件修改；相对历史main及真实origin/main仍有累计review，不能用本轮0review替代独立审核。没有accept-review。没有删除SSM测试或改已读边界。

工具数量16不变，tool-schemas/常驻ENV_PROMPT相对7332574的Git规范化文本未变；按需selection协议字符（trim口径）3197→3529，新增确定性代码不调用模型。通知增加task/三身份说明，只在相关事件/查询提供，不常驻。实际模型Token与模型表现NOT_MEASURED，不宣称节省收益。无解码算法修改，未重做大文件性能；前轮性能不能改标本轮。

依赖/锁未改，运行worker仍yauzl3.2.1；畸形ZIP字段在最终全量通过。前轮六项开发audit未在本轮修复或重新审计，不把开发工具当运行可达，也不视为自动接受风险。新pack仅私有本地检查，不含测试数据/profile。最终源码与冻结后报告之间src/lib/describe diff应为空。
