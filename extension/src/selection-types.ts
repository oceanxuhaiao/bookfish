import { normalizeIdentity, type CandidateMatch } from './novel-match.ts';

/**
 * Durable state for the pet's own reading wishes.
 *
 * This is deliberately separate from Persona Memory and from the reading
 * frontier. It records only externally visible wishes, mechanical acquisition
 * state and the queue the World is allowed to execute. A fulfilled wish is not
 * a reading confirmation.
 */
export type SelectionIntentStatus =
  | 'proposed'
  | 'searching'
  | 'awaiting_choice'
  | 'acquiring'
  | 'fulfilled'
  | 'reading'
  | 'completed'
  | 'deferred'
  | 'failed'
  | 'cancelled'
  | 'abandoned';

export type SelectionFailureCode =
  | 'no_result'
  | 'catalog_rejected'
  | 'fetch_failed'
  | 'integrity_failed'
  | 'import_failed'
  | 'book_not_found'
  | 'network_disabled'
  | 'engine_unavailable'
  | 'disk_full'
  | 'cancelled'
  | 'restart_interrupted'
  | 'policy_changed'
  | 'already_in_library'
  | 'duplicate_work'
  | 'daily_limit'
  | 'cooldown'
  | 'round_exhausted'
  | 'round_paused'
  | 'self_selected_unfinished';

export interface SelectionFailure {
  code: string;
  message: string;
  at: number;
}

export interface SelectionCandidate {
  id: string;
  title: string;
  author: string;
  url: string;
  revision: string;
  latestChapter: string;
  source: { id: number; name: string };
  match: CandidateMatch;
  expiresAt: number;
}

export interface SelectionIntent {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  author: string;
  reason: string;
  status: SelectionIntentStatus;
  origin: 'autonomous' | 'user';
  candidates: SelectionCandidate[];
  searchJobId?: string;
  selectedCandidateId?: string;
  acquisitionTaskId?: string;
  bookKey?: string;
  /** Automatic mode queues on import; the model may still confirm the queue. */
  queueOnImport: boolean;
  failure?: SelectionFailure;
  /** Last terminal fact already announced to the model; prevents duplicate wakeups. */
  notified?: string;
}

export interface ReadingQueueItem {
  id: string;
  intentId: string;
  bookKey: string;
  title: string;
  source: 'pet' | 'user';
  status: 'queued' | 'active' | 'done' | 'cancelled';
  addedAt: number;
  updatedAt: number;
  notBefore?: number;
}

export interface SelectionRound {
  id: string;
  day: string;
  startedAt: number;
  workKeys: string[];
  status: 'open' | 'succeeded' | 'exhausted' | 'paused';
  cooldownUntil: number | null;
}

export interface FailedWork {
  workKey: string;
  day: string;
  intentId: string;
  message: string;
  at: number;
}

export interface SelectionState {
  schema: 1;
  generation: number;
  intents: SelectionIntent[];
  queue: ReadingQueueItem[];
  failures: FailedWork[];
  round?: SelectionRound;
  lastOpportunityDay?: string;
  lastOpportunityAt?: number;
}

const INTENT_STATUSES: readonly SelectionIntentStatus[] = [
  'proposed', 'searching', 'awaiting_choice', 'acquiring', 'fulfilled', 'reading',
  'completed', 'deferred', 'failed', 'cancelled', 'abandoned',
];
const MATCHES: readonly CandidateMatch[] = ['exact', 'title', 'author', 'other'];
const CANDIDATE_LIMIT = 12;

export function emptySelection(): SelectionState {
  return { schema: 1, generation: 0, intents: [], queue: [], failures: [] };
}

export function workKey(title: string, author: string): string {
  return `${normalizeIdentity(title)}\n${normalizeIdentity(author)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid autonomous selection record');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid autonomous selection ${name}`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid autonomous selection ${name}`);
  return value;
}

function stamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8_640_000_000_000_000) throw new Error(`Invalid autonomous selection ${name}`);
  return value as number;
}

function optionalStamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return stamp(value, name);
}

function validateCandidate(raw: unknown, expiresAt: number): SelectionCandidate {
  const value = record(raw);
  const id = text(value.id, 'candidate id', 80);
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid autonomous selection candidate id');
  const title = text(value.title, 'candidate title', 200);
  const author = text(value.author, 'candidate author', 100);
  const url = text(value.url, 'candidate url', 500);
  const revision = text(value.revision, 'candidate revision', 64);
  if (!/^[a-f0-9]{8,64}$/u.test(revision)) throw new Error('Invalid autonomous selection candidate revision');
  const source = record(value.source);
  if (!Number.isSafeInteger(source.id) || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100) throw new Error('Invalid autonomous selection candidate source');
  if (typeof value.match !== 'string' || !MATCHES.includes(value.match as CandidateMatch)) throw new Error('Invalid autonomous selection candidate match');
  return {
    id, title, author, url, revision,
    latestChapter: optionalText(value.latestChapter, 'candidate latest chapter', 200) ?? '',
    source: { id: source.id as number, name: source.name },
    match: value.match as CandidateMatch,
    expiresAt: value.expiresAt === undefined ? expiresAt : stamp(value.expiresAt, 'candidate expiry'),
  };
}

function validateIntent(raw: unknown): SelectionIntent {
  const value = record(raw);
  const id = text(value.id, 'intent id', 80);
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid autonomous selection intent id');
  const status = value.status;
  if (typeof status !== 'string' || !INTENT_STATUSES.includes(status as SelectionIntentStatus)) throw new Error('Invalid autonomous selection intent status');
  const candidates = value.candidates === undefined ? [] : value.candidates;
  if (!Array.isArray(candidates) || candidates.length > CANDIDATE_LIMIT) throw new Error('Invalid autonomous selection candidate list');
  const createdAt = stamp(value.createdAt, 'intent created time');
  const updatedAt = stamp(value.updatedAt, 'intent updated time');
  let failure: SelectionFailure | undefined;
  if (value.failure !== undefined) {
    const f = record(value.failure);
    failure = { code: text(f.code, 'failure code', 80), message: text(f.message, 'failure message', 1000), at: stamp(f.at, 'failure time') };
  }
  return {
    id, createdAt, updatedAt,
    title: text(value.title, 'intent title', 200),
    author: text(value.author, 'intent author', 100),
    reason: text(value.reason, 'intent reason', 1000),
    status: status as SelectionIntentStatus,
    origin: value.origin === 'user' ? 'user' : 'autonomous',
    candidates: candidates.map((candidate) => validateCandidate(candidate, createdAt + 30 * 60_000)),
    ...(optionalText(value.searchJobId, 'search job id', 80) ? { searchJobId: value.searchJobId as string } : {}),
    ...(optionalText(value.selectedCandidateId, 'selected candidate id', 80) ? { selectedCandidateId: value.selectedCandidateId as string } : {}),
    ...(optionalText(value.acquisitionTaskId, 'acquisition task id', 80) ? { acquisitionTaskId: value.acquisitionTaskId as string } : {}),
    ...(optionalText(value.bookKey, 'book key', 150) ? { bookKey: value.bookKey as string } : {}),
    queueOnImport: value.queueOnImport !== false,
    ...(failure ? { failure } : {}),
    ...(optionalText(value.notified, 'notification key', 200) ? { notified: value.notified as string } : {}),
  };
}

function validateQueue(raw: unknown): ReadingQueueItem {
  const value = record(raw);
  const id = text(value.id, 'queue id', 80);
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid autonomous selection queue id');
  if (!['queued', 'active', 'done', 'cancelled'].includes(String(value.status))) throw new Error('Invalid autonomous selection queue status');
  if (value.source !== 'pet' && value.source !== 'user') throw new Error('Invalid autonomous selection queue source');
  return {
    id, intentId: text(value.intentId, 'queue intent id', 80),
    bookKey: text(value.bookKey, 'queue book key', 150),
    title: text(value.title, 'queue title', 200), source: value.source,
    status: value.status as ReadingQueueItem['status'],
    addedAt: stamp(value.addedAt, 'queue added time'), updatedAt: stamp(value.updatedAt, 'queue updated time'),
    ...(optionalStamp(value.notBefore, 'queue not-before time') !== undefined ? { notBefore: value.notBefore as number } : {}),
  };
}

function validateRound(raw: unknown): SelectionRound | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw);
  if (!['open', 'succeeded', 'exhausted', 'paused'].includes(String(value.status))) throw new Error('Invalid autonomous selection round status');
  if (!Array.isArray(value.workKeys) || value.workKeys.length > 3 || value.workKeys.some((key) => typeof key !== 'string' || !key || key.length > 500)) throw new Error('Invalid autonomous selection round attempts');
  const cooldownUntil = value.cooldownUntil === null || value.cooldownUntil === undefined ? null : stamp(value.cooldownUntil, 'round cooldown');
  return {
    id: text(value.id, 'round id', 80), day: text(value.day, 'round day', 10),
    startedAt: stamp(value.startedAt, 'round start'), workKeys: [...value.workKeys] as string[],
    status: value.status as SelectionRound['status'], cooldownUntil,
  };
}

/** Validate persisted autonomous-selection state. Missing state is a clean migration, never fabricated history. */
export function validateSelection(raw: unknown): SelectionState {
  if (raw === undefined || raw === null) return emptySelection();
  const value = record(raw);
  if (value.schema !== 1) throw new Error('Unsupported autonomous selection schema');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error('Invalid autonomous selection generation');
  if (!Array.isArray(value.intents) || value.intents.length > 50) throw new Error('Invalid autonomous selection intents');
  if (!Array.isArray(value.queue) || value.queue.length > 50) throw new Error('Invalid autonomous selection queue');
  if (!Array.isArray(value.failures) || value.failures.length > 200) throw new Error('Invalid autonomous selection failures');
  const intents = value.intents.map(validateIntent);
  const ids = new Set<string>(), candidateIds = new Set<string>();
  for (const intent of intents) {
    if (ids.has(intent.id)) throw new Error('Duplicate autonomous selection intent id');
    ids.add(intent.id);
    for (const candidate of intent.candidates) {
      if (candidateIds.has(candidate.id)) throw new Error('Duplicate autonomous selection candidate id');
      candidateIds.add(candidate.id);
    }
  }
  const queue = value.queue.map(validateQueue);
  const queueIds = new Set<string>(), queuedIntents = new Set<string>();
  for (const item of queue) {
    if (queueIds.has(item.id) || queuedIntents.has(item.intentId)) throw new Error('Duplicate autonomous selection queue entry');
    queueIds.add(item.id); queuedIntents.add(item.intentId);
    if (!ids.has(item.intentId)) throw new Error('Autonomous selection queue references a missing intent');
  }
  const failures = value.failures.map((rawFailure) => {
    const item = record(rawFailure);
    return {
      workKey: text(item.workKey, 'failure work key', 500), day: text(item.day, 'failure day', 10),
      intentId: text(item.intentId, 'failure intent id', 80), message: text(item.message, 'failure message', 500),
      at: stamp(item.at, 'failure time'),
    };
  });
  return {
    schema: 1, generation: value.generation as number, intents, queue, failures,
    ...(validateRound(value.round) ? { round: validateRound(value.round)! } : {}),
    ...(optionalText(value.lastOpportunityDay, 'last opportunity day', 10) ? { lastOpportunityDay: value.lastOpportunityDay as string } : {}),
    ...(optionalStamp(value.lastOpportunityAt, 'last opportunity time') !== undefined ? { lastOpportunityAt: value.lastOpportunityAt as number } : {}),
  };
}
