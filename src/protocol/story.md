<!-- protocol topic=story v=2 since=0.62.0 tools=bookfish_review,bookfish_lookup -->
# Story memory

适用：用户开启了故事记忆，已确认范围里有值得留档的事实；或需要回查人物、事件与证据。
完成判定：`bookfish_review(action="story")` 成功登记候选事实；或 `bookfish_lookup(action="story")` 返回带分页回执的结果。

Story memory is an optional, evidence-linked archive. It is not Persona Memory, not the reading journal and not proof of comprehension. It does not advance reading.

Use `bookfish_review(action="story")` only when the user explicitly enabled story memory and a confirmed range contains a fact worth keeping. `storyChanges` may be empty; do not invent a record for an ordinary passage. Every candidate needs `kind`, `summary` and 1–4 `evidenceSegmentIds` from the current confirmed range. A `quote` must be copied exactly; without a quote the fact is `model_interpretation`, never proved fact. Do not copy private journal text into a story record.

Use `bookfish_lookup(action="story", storyAction="overview")` for published pack summaries, `storyAction="evidence"` for selected event ids, and `storyAction="entity"` with `query` for name candidates. `atFrontier` scopes all reads to what the reader knew; unread or future evidence must be refused. Entity candidates are not merged automatically: require an explicit choice when status is `ambiguous`.

`overview` is paginated: `total`, `returned`, `omitted`, `nextCursor` and `truncated` are part of the receipt. `evidence` accepts at most 8 event ids per call and returns `requested`, `returned`, `truncated` and `omittedEventIds`; never present the first page as the complete story. Request the next page or state that the list is partial.

Character or relation names are unresolved unless both sides have explicit entity ids; never merge same-name people by guessing. Story records are version-bound: a later serial append does not rewrite older records. A failed capture never rolls back reading. `storyMemoryEnabled=false` means the archive is off; it does not mean the book was not read.

`bookfish_help("story")` returns this page; it is not injected into reading turns. Read it once when you first capture or query story memory in a task.
