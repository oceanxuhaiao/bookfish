# 最终工程验证

生产源码冻结：77a5af8094d34ea728b5b731ddfabc6846a0ea00。文档/证据最终提交见审核包根目录02-提交与验证.json。版本0.63.0；分支codex/txt-acquisition-round4-supplement。以下PASS仅指注明范围的实际执行结果，不等于独立批准或真实宿主验收。

Windows、Node24.15.0，主pnpm依赖树。命令通过私有Node显式执行npm-cli；官方命令在state/cortico c376b91/API6根仓库运行。原始日志详见evidence，最终工程退出码supp-final-exitcodes.json。

| 命令 | 实际结果 |
|---|---|
| npm test | PASS，84文件945通过/1跳过（POSIX权限专用），总946 |
| npm run typecheck | PASS，Node端及WebUI端 |
| npm run build:webui | PASS |
| npm run verify:runtime -- --zip <既有运行包> | PASS |
| npm run verify:world -- --zip <既有运行包> --no-fetch | PASS，不是完整抓取/真实宿主 |
| npm run verify:world -- --zip <既有运行包> | FAIL，没有书名和作者均匹配的合法候选，拒绝错书；完整日志保留 |
| npm run check:ssm | 退出1，没有阻断项，但仍等待独立审核 |
| pnpm describe:extension <隔离包> | PASS，16工具/10事件/1提示词 |
| pnpm check:extension <隔离包> | PASS |
| npm pack --ignore-scripts --json --pack-destination _verify | PASS，只验证打包，不发布 |

### SSM

| 比较基线 | blocked | review | 结论 |
|---|---:|---:|---|
| 71cf8f3 | 0 | 3 | 待独立审核 |
| 12d8a03 | 0 | 3 | 待独立审核 |
| 35e364a | 0 | 4 | 待独立审核 |
| d5878f9 | 0 | 4 | 待独立审核 |
| 40858d9 | 0 | 6 | 待独立审核 |
| 08e0c7e | 0 | 6 | 待独立审核 |
| c440c03 | 0 | 7 | 待独立审核 |
| origin/main | 0 | 7 | 待独立审核 |

七个main共享review文件原文/差异放在审核包SSM基线和差异目录；本轮直接改到world、tool-schemas、describe三个review文件。ENV_PROMPT/config/library/stream相对71cf8f3未改。没有accept-review，没有删除SSM保护测试；技术回归不能代替产品负责人和SSM规则负责人的分别确认。

### 完整入架成本

不改流式算法，不重做20/50/99MiB昂贵矩阵。相同Node、1,048,532字节、相同SHA256 cf4500dcba368ddae40accf39cf3639a6c5ec04eaa80b2f0a5170c93f3255f77，baseline/current各5次交替独立进程。注入确定性响应，包含原件哈希/快照、入架和Selection回执，不含真实网络/模型；每次书架confirmed0/队列1。

| 源码 | 次数 | 中位ms | P95ms | 最高峰值RSS MiB |
|---|---:|---:|---:|---:|
| 71cf8f3 | 5 | 1542.6 | 1627.7 | 111.9 |
| 77a5af8 | 5 | 1523.4 | 1651.0 | 130.8 |

P95采用nearest-rank，小样本5次即最大值，不能外推所有小说。未单独测量本轮磁盘IO/解码阶段或并发性能，不宣称提速、Token收益。源码冻结后测量；比较差异完整保留。

首次重复章节标题的1MiB样本在旧71cf8f3和当前均报Noncanonical source whitespace。旧版意图卡acquiring，新版deferred并保留原件；没有为了测速放宽校验。已换连续正文进行上述可用样本对照，原失败诊断全部保留。这是尚未修复的既有规范化边界，不能写成全部数据可靠性闭环。复现方法：Buffer.alloc(1048576)，循环拷贝Buffer.from('第1章 海风\n她把信折好，回到窗口等船。\n')至恰好填满；原SHA256 67337c83e1cc2c55633145fe5440278dabc4fda3148dd4436d4a68edab9bf1e6，分别通过同一TXT入口导入。

### 工具与提示词成本

工具数16→16；模型可见schema字符13150→13224（+74）；常驻ENV_PROMPT 680字符逐字不变；按需Selection协议2870→3217字符。确定性状态/身份/回执本地执行，新增模型调用0。实际Token未测，字符不能等同Token；相关工具预算/冻结契约测试通过。

### 依赖及包

没有改依赖或锁文件，未执行强制audit升级。本轮新audit仍6项；实际zip-worker与重打包结果一致，包含yauzl3.2.1，worker SHA256 e7130b26ee5749ef65316ff6fe4cf327401eb89f7721b4e5bf45d752e95ae2ab；畸形ZIP时间字段在最终全量通过。npm打包文件表供检查，私有测试/数据不进入发行包。

| 依赖 | 严重度 | 受影响范围（audit） | 建议升级vitest |
|---|---|---|---|
| @vitest/mocker | moderate | <=4.1.11 | 5.1.1 |
| esbuild | moderate | <=0.24.2 | 5.1.1 |
| tinypool | critical | <=2.1.1 | 5.1.1 |
| vite | high | <=6.4.3 | 5.1.1 |
| vite-node | moderate | <=2.2.0-beta.2 | 5.1.1 |
| vitest | critical | <=4.1.10 | 5.1.1 |

上述均测试/开发工具链；worker元文件无此六项。用户TXT运行入口不能直接触达测试UI/开发服务器，不因此认定运行时可利用，也不忽略开发服务器暴露/不可信测试项目风险。建议隔离开发测试服务并另行验证vitest5.1.1跨主版本迁移，兼容性未测试，不能自动强升。正式发布前依赖风险需独立接受或修复；Node24满足本次验证环境，下限engine未新增复测。双锁安装一致性沿用前轮证据标记，本轮没有重做新安装，不伪称已复测。
