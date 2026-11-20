# BookFish TXT 获取模块 · 04 TXT 导入容错报告

核心结论：**导入成功率优先于表面上的零质量问题**。原来的严格导入入口保持原样不动，新增的宽松入口 `Library.importFileBestEffort` 有真实代码路径支持，不是「把错误提示改成警告」。

## 一、两条入口的分工

| 入口 | 行为 | 是否变更 |
|---|---|---|
| `Library.importFile` / `importFileBlob` / `canonicalize` | 严格：非法编码、控制字符、末尾残字、二进制一律抛错 | **未改**（测试 `leaves the strict import entry untouched` 断言严格入口仍抛 `Binary or control characters`） |
| `Library.importFileBestEffort` / `decodeFileBestEffort` / `importFileBlobBestEffort` | 宽松：识别编码、容忍少量坏字节、截尾、规范化换行与控制字符、给出结构化质量报告 | 新增 |

宽松路径真正绕过的硬条件只有四项：编码识别失败、坏字节预算、控制字符、末尾残字。**其余仍是硬拒绝**：空文件、二进制、非文本、登录/验证码页、超限、违反网络策略、存储不可用。

## 二、编码覆盖（`tests/txt-acquisition-import.test.ts`，19 例）

| 输入 | 判定 | 结果 |
|---|---|---|
| UTF-8（含大量中文） | `utf-8` | 正常导入，`quality: clean` |
| UTF-8 BOM | `utf-8-bom` | 去 BOM 后导入，正文不含 `\uFEFF` |
| GBK / GB18030 | `gb18030` | 正常导入（`imports a GB18030 novel that the strict decoder would also accept, and reports no damage`） |
| UTF-16LE（无 BOM） | `utf-16le` | 正常导入 |
| UTF-16BE（无 BOM） | `utf-16be` | 正常导入 |
| 少量孤立坏字节（`0xA4`） | 最近编码 | 保留替换标记 + `replacement_characters` 警告，导入成功 |
| 末尾半个字符（`0xE4,0xB8`） | 最近编码 | 截掉残字、`tail_truncated`、`quality: partial`，前面章节完整 |
| 混合编码 | 替换字符最少的编码 | 尽力解码并报告质量 |
| 纯二进制（NUL / 高比例非文本） | — | 拒绝 `binary_file` |

### 编码识别算法（`src/txt-acquisition/repair.ts`）

1. BOM：`EF BB BF` → `utf-8-bom`；`FF FE` → `utf-16le`；`FE FF` → `utf-16be`。
2. 无 BOM 但存在明显 pair-NUL 结构（奇数位 NUL 高、偶数位低，或反之）→ 对应 UTF-16。
3. 前 1 MiB 样本按 UTF-8 解码零替换 → `utf-8`。
4. 否则对 `utf-16le`、`utf-16be`、`gb18030`、`utf-8` 逐个解码并计算**可信度分**（`plausibility`）：ASCII 可打印/空白 +1、约 400 个常用汉字 +1、中文标点 +0.6、全角 +0.3、区间内罕见汉字 +0.2，再按替换率与 NUL 率扣分；取最高分。

> 第 4 步是本次调试发现的关键修正：以中文为主的 UTF-16 文本几乎不含 NUL 字节，早期「奇数位 NUL > 30%」的启发式会把它误判成 GB18030，随后又被 `looksBinary` 判成二进制，导致 UTF-16 小说被拒。改为可信度打分后 UTF-16LE/BE 与 GB18030 三类用例全部通过。
>
> `looksBinary` 同样改为编码感知：宽字符编码跳过 NUL 判据、按检测到的编码解码后统计可读字符占比。

## 三、质量容错覆盖

| 样本 | 旧机制 | 现在 | 测试 |
|---|---|---|---|
| 章节编号偶尔错误/倒退 | 可能拒绝 | 导入 + `chapter_numbers_irregular` | `imports a novel with an out-of-order chapter number and warns` |
| 少量章节缺失 | 可能拒绝 | 导入 + `chapters_missing`，不截断正文 | `imports a novel with a missing chapter and warns, without truncating anything` |
| 少量重复章节 | 可能拒绝 | 导入 + `duplicate_chapters` | 同上系列 |
| 章节标题格式不统一 | 可能拒绝 | 导入 + `heading_style_mixed` | `imports mixed heading styles and repeated headings` |
| 完全没有章节标题 | 可能拒绝 | 按普通正文 1200 字分段导入，章节名 `正文`，`no_chapters` | `imports prose with no chapter headings at all` |
| 少量广告文字 | 可能拒绝或删改 | **保留原文** + `ad_lines` 警告（不擅自删） | `keeps advertising lines and reports them as warnings` |
| 末尾截断/残卷 | 可能拒绝 | 导入 + `tail_truncated` / `possible_truncation`，`quality: partial` | `imports an obviously partial copy and marks it partial` |
| 书名/作者不符 | 可能拒绝 | 导入 + `identity_mismatch`，`identity: 'partial'`，**不自动排队** | `imports a title that does not match the request but reports the mismatch` |
| 登录/验证码页 | 可能误判为正文 | 拒绝 `not_a_book` | `refuses a login or captcha page` |
| 空文件 | 拒绝 | 拒绝 `empty_file` | `refuses an empty file` |
| 二进制 | 拒绝 | 拒绝 `binary_file` | `refuses a binary file` |
| 大面积不可解码（`0xFF` 填充） | 拒绝 | 拒绝 `unreadable_text` / `binary_file` | `refuses a body that is mostly undecodable` |

## 四、质量报告结构

```ts
interface QualityReport {
  quality: 'clean' | 'warning' | 'partial';
  encoding: DetectedEncoding;
  readableChars: number;
  totalChars: number;
  warnings: { code: string; message: string; count?: number }[];
  repairs: { code: string; message: string; count?: number }[];
  truncated: boolean;
  suspectedPartial: boolean;
}
```

`Library.importFileBestEffort` 返回 `{ imported, duplicate, book, quality, readableChars, identity, repairs }`；拒绝时抛 `BestEffortRejected`（带 `code`），由编排层记录为失败任务并**保留原始字节**。

## 五、与 `novel-integrity` 的关系

`src/novel-integrity.ts` **未参与** TXT 文件导入判定。没有拿书源目录去逐章比对，没有要求标准章节编号，没有把「章节数不确定」当无效。完整性只以 `suspectedPartial`/`partial` 的形式进入质量报告，供模型与用户判断，不构成一票否决。
