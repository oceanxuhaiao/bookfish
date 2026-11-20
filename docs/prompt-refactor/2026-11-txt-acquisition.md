# 2026-11 浏览器辅助 TXT 获取：常驻提示词与工具预算调整

## 背景

0.63.0 增加独立的浏览器辅助 TXT/Markdown 文件获取模块（`src/txt-acquisition/`），
并按任务书要求把入口收敛成一个模型工具 `bookfish_import_txt`
（action: discover / import / status / retry / repair / cancel）。

这带来两处常驻预算变化，本文件记录理由与实测数字，供后续审查。

## 变更

| 项目 | 0.63.0 | 现在 | 上限 |
| --- | --- | --- | --- |
| 模型可见工具数 | 15 | 16 | 断言改为 16 |
| 模型可见工具 schema 字符数 | 12 473 | 13 150 | 13 000 → 13 400 |
| `src/ENV_PROMPT.md` 字符数 | 424 | 667 | 600 → 800（余量保留） |

实测口径与 `tests/context-budget.test.ts` 一致：
`JSON.stringify(BOOKFISH_TOOL_DECLS.map(({name, description, parameters}) => ({name, description, parameters})))`。

新增工具自身占 676 字符（含 7 个参数与 6 值 action 枚举），整体 schema 因此 +677 字符，
其中 name/description/parameters 是模型决策必需的最小面：
`discover` 需要页面地址，`import` 需要候选或直链，`retry`/`repair`/`cancel` 需要任务号，
`intentId` 是自主选书唯一关联凭据。

## 为什么没有更低成本的替代

- 已删除 `encoding` 参数：`repair` 会自动尝试 UTF-8 / GB18030 / UTF-16LE / UTF-16BE 并取替换字符最少者，
  模型无需指定，省约 100 字符。
- 已把五个参数描述压缩为 `maxLength`，省约 160 字符。
- 未合并 `retry` 与 `repair`：两者语义不同（重放导入 vs 换编码生成新版本），
  合并会让模型在"文件能读但有乱码"时误用重放，反而增加一轮往返。
- 常驻提示词只增加一段获取原则（243 字符），详细流程不进常驻提示，
  仍由 `bookfish_help` 与工具回执按需提供。

## Token 影响

每次请求增加 677 字符 schema + 243 字符提示词（其中大部分是汉字）。按 ASCII 约 4 字符/词元、汉字约 1 词元估算，约 +370 tokens/请求。这是估算值，未在真实宿主上取过基线；如需精确数字应在启用该工具前后各取一次实测并回填本节。
换取的能力是：在没有预设书源时，仍能把现成 TXT/Markdown 文件带回书架并开始阅读。
该能力无法用本地确定性逻辑替代（需要页面发现、浏览器取字节、质量判断）。


