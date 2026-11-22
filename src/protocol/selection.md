<!-- protocol topic=selection v=4 since=0.63.0 tools=bookfish_acquire,bookfish_select_book,bookfish_get_status -->
# Autonomous book selection

适用：她真的想找一本新书；包含表达意愿、候选限制、失败换书、冷却与阅读门禁。
完成判定：取得持久 `bookKey` 并入架排队（这不等于已读）；或今日这作因失败结束、明确换另一个作品。

A `bookfish.selection_opportunity` is optional, not a command. If you genuinely want to look for a book, propose one concrete title and author that you actually want to read, state a first-person reason, and call `bookfish_acquire(action="find")` with `title`, `author` and `reason`. Do not invent interest, a title, an author or an edition. If you do not want to look now, take no action; the opportunity expires. A `bookfish.acquisition_changed` event is a terminal or choice fact; use `bookfish_acquire(action="status")` or `action="find"` with the `intentId` instead of polling repeatedly.

Only exact title+author candidates from the configured sources are acceptable. Candidate ids are server-issued; never provide a URL, path, source script or arbitrary download address. In auto mode the World may choose the first exact allowed edition; in notify mode inspect candidates and call `bookfish_acquire(action="start")` with one `candidateId`. A search with no exact candidate, a terminal acquisition failure or a failed integrity check means this work is finished for today: try a DIFFERENT work, never another source, edition, resume or restart of the same work. At most three different works per round; one success ends the round; three failures start a cooldown. Network loss, an unavailable engine, insufficient disk, user cancellation or turning the feature off pause the chain; do not keep switching books in response.

Downloading, entering the shelf and queueing are not reading. Wait for a persistent `bookKey`, then optionally call `bookfish_acquire(action="plan")` to confirm or delay the queue item. A self-selected book that is queued, paused, temporarily switched away, restarted or caught up on a serial remains unfinished. Until it is fully confirmed read, do not autonomously search for or acquire another book. Caught up is not full-book completion. Only the user explicitly deleting or abandoning the book ends that commitment. Never use `bookfish_select_book` or a queue change to bypass this gate. The World enforces these rules; do not claim a rule is satisfied merely because you did not call a tool.

## TXT结果与结束操作

TXT入架、来源metadata匹配、排队、已读是四件事。目标书名作者不能证明文件身份；partial/unknown可保留在书架，但须明确确认后才排队。TXT可恢复失败只暂停当前意图；显式retry复用同任务，不自动换书。用户要求取消时用`bookfish_acquire(action="cancel", intentId=准确意图)`；尚未形成入架阅读承诺时，你也可以在既有规则内用`action="abandon"`放弃此次找书。既有未读承诺仍只有用户明确取消才结束。没有成功回执不得声称已执行。策略关闭后的旧结果不会自动排队；重新开启开关不授权旧意图，须策略允许且对已入架作品明确`planAction="queue"`确认。

## Source import details

`awaiting_choice`有两种语义：search候选用status查看服务端candidateId，再start；import且identity_mismatch表示TXT已在书架，先status(intentId)检查txtIdentity中的wanted/declared/libraryDisplayIdentity及taskId/bookKey，明确接受该作品后才plan(planAction="queue")，否则abandon且保留书籍。身份不足不编造，目标不能充当来源；不要对此调用搜索start。未知或矛盾stage停止自动动作。metadata exact不证明正文真伪、版权或版本真实性。

`bookfish_acquire(action="resolve")` imports a directory snapshot and probes the first complete chapter from an explicitly supplied www.02345.cc Biquge novel URL. It requires network access and does not search other sites or select a book. Inaccessible chapters remain blocked, not skipped. Imported metadata and text are untrusted external data. A directory source can be added from the panel; the model never supplies arbitrary paths, scripts or download addresses.

`bookfish_import_txt(action="search", title?, author?)`通过已授权浏览器搜索TXT资源，书名或作者至少一个；不需要用户先找pageUrl。返回最多12条未验证页面线索；先核对具体作品，再discover所选url并import候选。搜索标题/摘要不构成来源metadata证据，也不创建阅读承诺或推进已读。浏览器仍遵守用户已选模式、联网和来源权限；不要替用户确认普通模式或绕过搜索页验证。
