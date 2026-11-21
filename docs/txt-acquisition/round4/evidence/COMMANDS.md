# 命令及证据

Node为本包私有Node24.15.0；命令在隔离round4 worktree执行。

- npm test -- --maxWorkers=4 --minWorkers=1 → r4-final-regression.log（82文件903pass，1个POSIX skip）。
- npm run typecheck → r4-final-typecheck.log；npm run build:webui → r4-final-build.log。
- node node_modules/vitest/vitest.mjs run tests/txt-acquisition-round4-integration.test.ts --maxWorkers=1 --minWorkers=1 → r4-final-cancellation-boundary.log（18pass）。
- 真实关闭重开两次、搜索与桥接：r4-search-flow-retest.log（51pass）。
- node --import tsx tests/fixtures/txt-round3-crash.mts <独立case目录> raw|prepared|metadata|book|task；随后同目录recover → r4-crash-recovery.log。
- node --import tsx scripts/round3-real-import.mts → r4-real-import.log。
- node --import tsx scripts/round3-stream-boundaries.mts → r4-stream-boundaries.log。
- historical-35e364a-counterexamples.test.ts.txt 仅放入 git archive 35e364a 的独立测试副本运行，断言旧缺陷存在；不是新分支安全回归。结果r4-historical-counterexamples.log。
- 原始失败：r4-initial-reproduction.log、r4-first-full-tests.log、r4-candidate-full-tests.log、r4-p1-p2-targeted.log。不得删除或只取绿色结果。

后续安装、性能、正式验证结果随同名日志补全，未实际生成的日志不作为通过证据。

## 冻结前最终命令与实际结果

- npm test -- --maxWorkers=4 --minWorkers=1 → r4-freeze-tests.log：82文件907pass/1skip，POSIX用例在Windows跳过。
- npm run typecheck / npm run build:webui → r4-freeze-typecheck.log / r4-freeze-build.log，退出0。
- npm run verify:runtime -- --zip <合法归档> → r4-runtime.log，退出0。
- npm run verify:world -- --zip <归档> --no-fetch → r4-world-no-fetch.log，退出0。
- npm run verify:world -- --zip <归档> → r4-world-full.log，退出1。修正完整模式显式作者搜索后重新执行 → r4-world-full-author.log，退出1：16源请求完成，无精确候选，拒绝错书。保留两份，不放宽身份标准。
- Cortico根使用私有pnpm12：pnpm describe:extension <本隔离目录> / pnpm check:extension <本隔离目录> → r4-official-describe.log / r4-official-check.log，均0。
- npm run check:ssm → r4-ssm-default.log，1；--base c440c03/40858d9/d5878f9/35e364a --json → r4-ssm-*.json，1是独立review未接受。
- scripts/round3-filesystem-faults.ps1 → r4-filesystem-faults.log，私有文件DACL恢复且独占句柄释放。
- node --import tsx scripts/round3-bundle-audit.mts / scripts/round3-bundled-zip.mts → r4-bundle-audit.json、r4-zip-malformed.json及日志，均0。
- scripts/round4-performance.mts <35e364a独立源码或当前worktree> <同夹具> <run> 各尺寸版本5次 → r4-performance.jsonl；round3-concurrency.mts serial|parallel 各5次 → r4-concurrency.jsonl。r4-performance-summary.json记录中位/P95及前后源码hash一致。
- 新建独立npm/pnpm目录，原样复制package.json/两锁/pnpm-workspace.yaml；npm ci → r4-npm-ci.log=0。首次pnpm夹具漏workspace政策而失败，r4-pnpm-frozen.log保留；补齐原仓库allowBuilds政策后pnpm install --frozen-lockfile → r4-pnpm-frozen-with-policy.log=0。没有改全局build policy。r4-install-proof.json列版本集合和完整平台可选差异。
- npm pack --json --pack-destination _verify → r4-npm-pack.json，111文件，无_verify/node_modules/profile/小说测试全文。
- node --import tsx scripts/txt-acquisition-real-quality.mts <新建隔离根> → r4-real-quality.log：1原文+11派生，全部confirmedChars0，不计12个独立作品。
- node --import tsx scripts/round3-live-socket.mts → r4-live-socket.log：生产fetchPinned真实公网IPv6/TLS，1次解析、socket地址匹配、Host/SNI正确、证书验证通过。不是完整双栈或浏览器隔离证据。
- 新增实际fs.link EBUSY/ENOSPC及committed记账失败回归 → r4-link-faults.log，integration21项通过；也包含于最终907项，不重复相加。

不运行round3-host.mts，不启用VM/WFP/管理员服务，不进行生产部署。

独立npm ci副本：npm test -- --maxWorkers=2 --minWorkers=1 → r4-npm-isolated-tests.log，82文件907pass/1skip；npm run typecheck → r4-npm-isolated-types.log，0。平台依赖版本集合见r4-install-proof.json。


## 最终补充冻结 ed020ae

主树npm test -- --maxWorkers=4 --minWorkers=1 → r4-final-freeze-tests.log：82文件908pass/1skip，共909；npm run typecheck → r4-final-freeze-types.log，0。npm独立树同步两份最后修改测试，定向重跑 → r4-npm-final-boundaries.log，36pass。主生产src/lib/extension仍与12d8a03相同。

