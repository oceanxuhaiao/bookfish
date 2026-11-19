# BookFish Bugfix 开发模板

**任务编号：** BF-DSH-GIT-20261119
**适用：** 新电脑（Bugfix 路线）上的每一个独立任务
**前置：** 已读 `docs/dev/BookFish-SSM-PROVISIONAL-PROTECTED-PATHS.md`

---

## 1. 开工（5 分钟）

```powershell
cd D:\学习\项目\bookfish
git status --short --branch        # 必须干净
git switch main
git pull --ff-only origin main
git switch -c bugfix/<任务名>       # 例：bugfix/reading-status、bugfix/token-accounting
```

命名：`bugfix/<现象>`，小写、连字符，不写成 `fix2`、`test`、`tmp`。

**开工前必须回答**（写进任务笔记，不用交给谁）：

1. 现象是什么？如何稳定复现？
2. 可能涉及哪些文件？
3. 这些文件在保护清单里吗？（blocked / review / 都不在）

如果命中 `blocked` → **现在停止**，先按 §5 走冲突分析，不要开始写代码。

---

## 2. 复现与定位（先证据，后代码）

```powershell
node node_modules/vitest/vitest.mjs run tests/<相关>.test.ts   # 先跑现有测试
```

要求：

- 复现步骤要能被第二个人照着做出来；
- 记录修复前的失败输出（贴进 PR）；
- 定位到**最小**改动面；不做"顺手重构"。

---

## 3. 实现边界

**可以做**

- 修复与 SSM 无关的 Bug
- UI 显示、独立阅读状态、独立模块优化
- 与 SSM 无关的新功能
- 补测试、补必要文档

**不可以做**

- 改 `src/story/`、`src/protocol/story.md`、SSM 回归测试（blocked）
- 改保护清单里 review 文件的 SSM 区段（未授权）
- 升级整套依赖、重写锁文件、无故改 `package.json`
- 删除"看起来没用"的 SSM 模块
- 改其他分支的代码

---

## 4. 测试矩阵（缺一不可）

| # | 项目 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | 复现用例 | 新增/已有的定向测试 | 修复前失败，修复后通过 |
| 2 | 相关回归 | `node node_modules/vitest/vitest.mjs run tests/<模块>*.test.ts` | 全绿 |
| 3 | 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| 4 | Web 类型检查 | `node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit` | exit 0 |
| 5 | 全量测试 | `node scripts/build-worker.mjs; node node_modules/vitest/vitest.mjs run` | 无**新增**失败 |
| 6 | SSM 闸门 | `npm run check:ssm -- --staged` | exit 0 |
| 7 | 变更审计 | `git diff --check; git diff --stat` | 无空白错误；范围与任务一致 |

**基线提醒**：本机 `main` 现有 6 项 `selection*` 既有失败（见治理目录 `_evidence/baseline.txt`）。PR 中必须写明"非本次引入"，并给出对照。

> 为什么用 `node node_modules/vitest/vitest.mjs` 而不是 `pnpm test`：pnpm 12 会在命令后自动改写 `pnpm-lock.yaml`（该文件与 `package.json` 既有漂移），把无关改动混进工作区。

---

## 5. 命中受保护文件怎么办

1. **立即停止**该文件的修改。
2. 找替代实现：新模块、适配层、在调用侧修复、在测试侧覆盖。
3. 绕不开 → 写《SSM 冲突分析报告》，至少包含：
   - 文件与具体行/函数；
   - 冲突点（我要改什么 vs SSM 依赖它什么）；
   - 影响面（数据契约？证据锚点？关闭语义？归档恢复？）；
   - 2–3 个可选方案与代价；
   - 回滚方式。
4. 等用户决定。授权后仍要在 PR 里单独标注，请 SSM 侧复核。

---

## 6. 提交与 PR

```powershell
git status --short
git diff --check
git diff --stat
git add <逐个审核过的文件>          # 禁止 git add -A
npm run check:ssm -- --staged       # 必须 exit 0
git commit -m "fix: <一句话现象>"
git push -u origin bugfix/<任务名>
```

PR 模板（复制即用）：

```markdown
## 现象
<用户能看到什么>

## 复现
1. ...
2. ...

## 原因
<定位到的根因，附文件:行>

## 修复
<改了什么，为什么是最小改动>

## 测试
- [ ] 新增/修改的定向测试：<文件>（修复前红 → 修复后绿）
- [ ] 相关回归：<命令> → <结果>
- [ ] 类型检查：tsc exit 0
- [ ] 全量测试：<passed>/<total>；既有失败 6 项 selection*（非本次引入）
- [ ] `npm run check:ssm -- --staged` exit 0
- [ ] 构建：`build-worker.mjs` 成功

## SSM 影响
- [ ] 未触及受保护文件
- [ ] 触及 review 文件，已获授权：<理由>
- [ ] 需要 SSM 侧复核

## 风险与回滚
<如何撤回>
```

**不自动合并 main。** 合并需用户授权。

---

## 7. 收工

```powershell
git status --short --branch   # 干净，或明确记录未提交内容
git log --oneline -3
```

- 未推送 → 明确告知用户"本地未推送"。
- 换电脑 → 记录分支 / HEAD / 工作区状态 / 备份路径。
