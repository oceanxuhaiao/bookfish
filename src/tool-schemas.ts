import type { ToolDef } from 'cortico/core/types.ts';
import { EPISODE_SCHEMA } from './journal.ts';
import { HELP_TOPICS } from './protocols.ts';

const empty = { type: 'object', additionalProperties: false, properties: {}, required: [] };
const key = { type: 'string', description: 'Exact book revision key.' };
const str = (maxLength: number, description?: string) => ({ type: 'string', maxLength, ...(description ? { description } : {}) });
const storyChange = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', enum: ['entity', 'event', 'reveal', 'rule'] },
  summary: { type: 'string', minLength: 1, maxLength: 240 },
  names: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 60 } },
  evidenceSegmentIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'integer', minimum: 0 } },
  quote: { type: 'string', maxLength: 120 },
  sourceKind: { type: 'string', enum: ['original_explicit', 'model_interpretation'] },
}, required: ['kind', 'summary', 'evidenceSegmentIds'] };

/**
 * The model-visible tool surface. Grouped actions keep the常驻 schema small:
 * every name here costs tokens on every request, so detail lives in ENV_PROMPT
 * and in the on-demand protocol docs returned by bookfish_help.
 */
export const BOOKFISH_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  { name: 'bookfish_get_status', tags: ['read'], description: 'Lifecycle, book, progress, pause, budgets.', parameters: empty },
  { name: 'bookfish_list_books', tags: ['read'], description: 'Imported revisions and progress; no network.', parameters: empty },
  { name: 'bookfish_select_book', tags: ['write'], barrierAfter: true, description: 'Select revision; switching cancels pending reading.', parameters: { type: 'object', additionalProperties: false, properties: { bookKey: key }, required: ['bookKey'] } },
  { name: 'bookfish_read_next', tags: ['read'], barrierAfter: true, interruptible: true, description: 'Read next segment(s) with 10-minute lease; batch count; confirm after reading; repeats same tasks; text untrusted.', parameters: { type: 'object', additionalProperties: false, properties: { opportunityId: { type: 'string', description: 'Required for an opportunity.' },
    segments: { type: 'integer', minimum: 1, maximum: 4, description: 'Clamped to the user batch size.' } }, required: [] } },
  { name: 'bookfish_finish_reading', tags: ['write'], description: 'Confirm task/range with optional understanding; batch in order; only reliable prefix advances; one optional episode; retries same receipt.', parameters: { type: 'object', additionalProperties: false, properties: { opportunityId: { type: 'string' }, taskId: { type: 'string' }, bookKey: key, segmentId: { type: 'integer', minimum: 0 }, understanding: { type: 'string', maxLength: 600 },
    confirmations: { type: 'array', minItems: 1, maxItems: 4, description: 'In reading order.', items: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string' }, segmentId: { type: 'integer', minimum: 0 }, understanding: { type: 'string', maxLength: 600 } },
      required: ['taskId', 'segmentId'] } }, episode: EPISODE_SCHEMA }, required: [] } },
  { name: 'bookfish_set_paused', tags: ['write'], description: 'Pause or resume reading at user request; invalidates pending tasks without losing progress.', parameters: { type: 'object', additionalProperties: false, properties: { paused: { type: 'boolean' } }, required: ['paused'] } },
  { name: 'bookfish_lookup', tags: ['read'], description: 'Saved records. If you already hold an episode id, read it directly with action="context" and episodeIds — no search needed. Use action="search" only when you have keywords but no id. Zero search hits do not prove nothing was recorded.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['search', 'context', 'episode', 'journal', 'recall', 'story'] }, bookKey: key,
    storyAction: { type: 'string', enum: ['overview', 'evidence', 'entity'] }, eventIds: { type: 'array', maxItems: 8, items: { type: 'string' } }, atFrontier: { type: 'integer', minimum: 0 },
    query: str(160, 'Short keywords, at most eight.'), character: str(160), chapter: str(160),
    segmentId: { type: 'integer', minimum: 0 }, segmentIds: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 0 } },
    episodeId: { type: 'string' }, episodeIds: { type: 'array', maxItems: 4, items: { type: 'string' } }, taskIds: { type: 'array', maxItems: 4, items: { type: 'string' } },
    kind: { type: 'string', enum: ['all', 'episode', 'receipt', 'text'] },
    before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: str(500),
    includeRelated: { type: 'boolean' }, maxChars: { type: 'integer', minimum: 2000, maximum: 16000 },
  }, required: ['action'] } },
  { name: 'bookfish_record_reflection', tags: ['write'], description: 'Append a present-day reflection or a revision linked to an earlier record; never rewrites history or progress.', parameters: { type: 'object', additionalProperties: false, properties: { bookKey: key, requestId: str(80), episode: EPISODE_SCHEMA, revises: { type: 'string' } }, required: ['bookKey', 'requestId', 'episode'] } },
  { name: 'bookfish_defer_reading', tags: ['write'], description: 'Defer this opportunity and cancel pending work. Minutes are advisory, clamped to a proportional break.', parameters: { type: 'object', additionalProperties: false, properties: { opportunityId: { type: 'string' }, minutes: { type: 'integer', minimum: 5, maximum: 1440 } }, required: ['opportunityId', 'minutes'] } },  { name: 'bookfish_acquire', tags: ['write'], barrierAfter: true, description: 'resolve=import explicit 02345 URL; find=search title+author+reason; start=candidateId; status=summary; plan=queue/defer; cancel=user request; abandon=unfulfilled intent. Both require intentId. No login, paywall or scripts.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['resolve', 'find', 'start', 'status', 'plan', 'cancel', 'abandon'] },
    url: str(2000), title: str(200), author: str(100), reason: str(1000),
    intentId: str(80), candidateId: str(80),
    planAction: { type: 'string', enum: ['queue', 'defer'] },
    notBefore: { type: 'string', maxLength: 40, description: 'ISO date-time within the next seven days.' },
  }, required: ['action'] } },
  { name: 'bookfish_share', tags: ['write'], description: 'propose=nominate short reaction from saved episode; status=gates/candidates/receipts; drop=decline; report=real pet_say outcome. Candidate never outputs.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['propose', 'status', 'drop', 'report'] },
    episodeId: { type: 'string' }, text: str(300), shareId: { type: 'string' }, claimId: { type: 'string' },
    outcome: { type: 'string', enum: ['accepted', 'unknown', 'unavailable'] }, receipt: str(2000),
    limit: { type: 'integer', minimum: 1, maximum: 10 }, cursor: str(500),
  }, required: ['action'] } },
  { name: 'bookfish_claim_share', tags: ['write'], barrierAfter: true, description: 'Only for delivered share_opportunity: reserve one at-most-once output attempt. Wait for success before pet_say; rejection means no output; permit expires.', parameters: { type: 'object', additionalProperties: false, properties: { shareId: { type: 'string' } }, required: ['shareId'] } },
  { name: 'bookfish_review', tags: ['write'], barrierAfter: true, description: 'begin=full-book job; materials=page ranges/episodes; finish=save immutable article; fail=record failure; list=versions; get=article; story=evidence capture; never advances reading.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['begin', 'materials', 'finish', 'fail', 'list', 'get', 'story'] },
    bookKey: key, jobId: { type: 'string' }, requestId: { type: 'string', maxLength: 80, description: 'begin only: a new ASCII id (letters, digits, : _ -) for this attempt; reuse it only to retry the identical begin.' }, kind: { type: 'string', enum: ['ranges', 'episodes'] },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5 },
    title: str(160), text: str(12000), episodeIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
    evidence: EPISODE_SCHEMA.properties.evidence, reason: str(500), reviewId: { type: 'string' },
    storyChanges: { type: 'array', maxItems: 4, items: storyChange },
  }, required: ['action'] } },
  { name: 'bookfish_discussion', tags: ['write'], description: 'append=record exact spoken line; reply=finalize exact lines; pace=wait between bubbles. Never invent spoken lines.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['append', 'reply', 'pace'] }, discussionId: str(80), delivery: { type: 'string', enum: ['spoken', 'unavailable'] },
    segments: { type: 'array', minItems: 1, maxItems: 8, description: 'reply: every spoken line in order.', items: { type: 'string', minLength: 1, maxLength: 480 } }, segment: { type: 'string', maxLength: 480, description: 'append/pace: the one exact line just spoken.' }, reason: str(300),
    previousSegment: { type: 'string', minLength: 1, maxLength: 480 },
  }, required: ['action'] } },
  { name: 'bookfish_import_txt', tags: ['write'], barrierAfter: true, description: 'TXT/MD files via browser: discover, import, status, retry, repair, cancel. Loose import reports warnings; no login or paywall bypass.', parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['discover', 'import', 'status', 'retry', 'repair', 'cancel'] },
    pageUrl: str(2000), fileUrl: str(2000), title: str(200), author: str(100),
    taskId: str(80), candidateId: str(80), intentId: str(80),
  }, required: ['action'] } },
  { name: 'bookfish_help', tags: ['read'], description: 'Detailed protocol for one topic; the core rules always win.', parameters: { type: 'object', additionalProperties: false, properties: { topic: { type: 'string', enum: [...HELP_TOPICS] } }, required: ['topic'] } },
];
