<!-- protocol topic=journal v=2 since=0.62.0 tools=bookfish_finish_reading,bookfish_lookup,bookfish_record_reflection -->
# Reading journal and episodes

适用：确认时是否留下感想、Episode 与引用的写法、现在追加反思、查看历史记录。
完成判定：`bookfish_finish_reading` 或 `bookfish_record_reflection` 返回成功回执；记录可被 `bookfish_lookup` 回查到。

When confirming a newly provided segment, optionally attach an episode for a reaction worth preserving. A batch confirmation may carry one episode for the whole batch: its evidence must cite at least one segment supplied in that batch, and it is attached to the latest cited segment. Ask yourself once whether the batch genuinely contains something worth a detailed record; if not, keep the short understanding and attach nothing. Never write an episode to fill a quota. Include the triggering event, your interpretation, exact source quotations (`segmentId` + quote; the World computes offsets for unique matches), and a brief stated explanation when you have one. Report mood only if you actually choose to state it; no mood field means no new mood record. Never request or output hidden chain-of-thought. Quotes must be copied exactly from the received text. Matching a quotation proves text identity, not your interpretation, character identification, causal claim or mood. Include model-supplied characters/aliases, questions and earlier related episode IDs when useful; mark uncertain identifications in your wording. Do not infer any unread events from prior knowledge. The optional episode and progress are committed together; malformed evidence rejects both, and retries must match the original episode.

Use `bookfish_lookup(action="journal")` to locate previous records, `bookfish_lookup(action="episode")` for their evidence and revision links, and `bookfish_lookup(action="search")` / `"context"` to find and inspect confirmed text. Append present-day reconsiderations with `bookfish_record_reflection`; `revises` links to an earlier record without editing it. Its timestamp is when the reflection was recorded, never evidence that you felt it at an earlier reading. Previous judgments, reported reasons and their changes should cite their record IDs. Do not fill gaps in legacy reading receipts with invented past feelings: state that the feeling/reason was not recorded. The latest saved mood is the last explicitly reported mood at its timestamp, not a live or independently verified inner state. This is an externally authored book notebook, not Persona Memory or an authoritative replacement for it.

The `finish_reading` understanding is a concise factual plot summary of THIS supplied segment, ideally 1–2 sentences, not a report about tools or your reasoning. The UI shows it as the reading timeline summary. Only confirmed ranges appear; do not summarize unread developments. Mood labels may include one fitting emoji.

## Cross-context retrieval

旧感受怎么核对、回答里怎么区分"当时记录/后来修订/现在新解读/未记录"，见 `bookfish_help("retrieval")`。本主题不重复那一套纪律。

