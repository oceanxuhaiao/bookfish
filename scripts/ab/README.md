# 提示词 A/B 脚手架

这三个脚本用来对比"常驻提示词"与"按需协议"的成本和行为。它们**不进生产运行路径**，也不会被包内测试加载。

| 文件 | 作用 |
|---|---|
| `context.mts` | 用宿主真实前缀快照 + 某一臂的 `ENV_PROMPT` 拼出系统提示词与工具表 |
| `model.mts` | ollama 与 DeepSeek 两个最小聊天客户端 |
| `runner.mts` | 隔离 World 的装配、工具执行、机会事件取文本 |
| `run.mts` | 八场景（聊天/阅读/足迹/回查/讨论/分享/评论/选书）× 两臂 |
| `reading.mts` | 只重复阅读循环，用来量确认成功率 |
| `reading-deepseek.mts` | 同上，但打生产模型；密钥读部署 `.env`，不落盘不打印 |

## 先准备对照臂

`before` 臂读的是 `.old-src/`（已在 `.gitignore` 里）。重建方法：

```powershell
git -C <包目录> worktree add --detach <临时目录> HEAD
Copy-Item <临时目录>/src <包目录>/.old-src -Recurse
git -C <包目录> worktree remove --force <临时目录>
```

如果两臂要比的只是提示词，把本轮同时修好的代码（例如 `bookKey` 反查、`read_next.nextStep`）也同步进 `.old-src`，否则量到的会是"代码 + 提示词"的混合差异。

## 前置

- 本地 ollama 有 `qwen3.5:9b`（或设 `AB_MODEL`）。
- 宿主前缀快照在项目 `output/prompt-refactor/host-prefix-before.json` 与 `host-tool-schemas-before.json`；用运行中宿主的 `GET /api/prompts/prefix`、`GET /api/tool-schemas` 重新抓。

## 跑法

```powershell
node --import tsx scripts/ab/run.mts both -r1
node --import tsx scripts/ab/run.mts both -r2
$env:AB_REPS="4"; node --import tsx scripts/ab/reading.mts
$env:AB_REPS="2"; node --import tsx scripts/ab/reading-deepseek.mts
```

结果写到项目 `output/prompt-refactor/`。

## 注意

- `reading-deepseek.mts` 花的是部署里那套 DeepSeek 额度。跑之前先想清楚要几个样本。
- 每个场景用全新隔离数据目录，不碰真实书架。
- 9B 模型的行为噪声很大：单次结果不能当结论，至少重复 3–4 次。
