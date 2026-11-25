/**
 * Batch import: preview, per-item state machine and bounded concurrency.
 *
 * This module owns *scheduling*, never parsing. Every byte still goes through the
 * existing `ImportJob` worker -> `Library.adoptValidatedImport` path, so encoding
 * detection, body normalization, paged storage and duplicate identity are exactly
 * the single-file rules. Nothing here invents a second parser or a second shelf.
 */
import { createHash } from 'node:crypto';
import { suggestSeries, volumeOf, type SeriesSuggestion } from './reading-plan.ts';

export const BATCH_SCHEMA = 1 as const;
/** One batch may never exceed the library revision limit by much; keep it bounded. */
export const BATCH_ITEM_LIMIT = 100;
/** A single novel may not exceed the library's own per-book ceiling. */
export const MAX_BATCH_FILE_BYTES = 100 * 1024 * 1024;
/** Total *declared* bytes of one batch. Enforced at add time and re-checked per chunk. */
export const BATCH_STAGING_BYTES = 1024 * 1024 * 1024;
/** Raw archive bytes accepted before extraction. The worker enforces its own caps too. */
export const ZIP_MAX_BYTES = 512 * 1024 * 1024;
export const BATCH_ARCHIVE_LIMIT = 20;
/** Two parsers at a time: each is a worker thread doing decode + segment index. */
export const BATCH_CONCURRENCY = 2;
/** One automatic attempt plus one manual retry before an item needs a reselect. */
export const BATCH_ATTEMPT_LIMIT = 2;
export const BATCH_NAME_LIMIT = 260;

export type BatchSource = 'files' | 'folder' | 'zip';
export type BatchStatus = 'preview' | 'running' | 'completed' | 'cancelled';
export type BatchItemStatus =
  /** staged or accepted, waiting for a free slot */
  | 'pending'
  /** bytes are being written to the staging file */
  | 'importing'
  /** the worker is normalizing and indexing the body */
  | 'processing'
  /** the validated blob is being committed to the library */
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** the staged source vanished or is truncated; only the user can supply it again */
  | 'needs_reselect';

export type DuplicateHint = 'identical' | 'new_version' | 'in_batch';

export interface BatchItem {
  id: string;
  /** Relative path as picked, '/'-separated, already sanitized. Display only. */
  name: string;
  size: number;
  status: BatchItemStatus;
  title: string;
  author?: string;
  /** File name inside the staging directory; never an absolute path. */
  staged?: string;
  bookKey?: string;
  error?: string;
  attempts: number;
  duplicate?: DuplicateHint;
  duplicateOf?: string;
  /** Grouping proposal key from `suggestSeries`, decided in the preview. */
  group?: string;
  /** `false` when the extension is not a supported novel format. */
  supported: boolean;
  /**
   * SHA-256 of the bytes the user originally picked, computed server-side when
   * the upload completed. This is the entry's content identity: a re-picked file
   * must match it, so two same-length files can never be confused.
   *
   * Absent means "identity was never established" — an entry staged before this
   * rule existed, or one whose first upload never completed. Such an entry can
   * only be re-imported, never silently re-attached.
   */
  sourceSha256?: string;
  /** The relative path exactly as the picker reported it, for reselect matching. */
  sourceName?: string;
}

/**
 * Upload identity of an archive batch.
 *
 * `size` is what the picker declared; the upload may never exceed it. `sha256`
 * is computed by the server once the bytes have all arrived, and it is the
 * identity a recovery must match — a re-picked archive with the same length but
 * different content is refused. `claimedSha256` is only what the client said
 * before uploading, kept so a mismatch can be reported instead of trusted.
 */
export interface BatchZip {
  name: string;
  size: number;
  sha256?: string;
  claimedSha256?: string;
  state: 'uploading' | 'needs_reselect' | 'ready' | 'extracted';
  /**
   * Why the last extraction attempt did not finish. `ready` is kept for every
   * one of these: a disk that filled up, a refused rename or a worker hiccup
   * never means the archive itself is gone, so ZIP-level recovery stays
   * available. Only a missing or unverifiable archive needs the user to pick the
   * file again.
   */
  failure?: ZipFailure;
  /** Human-readable reason, bounded; evidence for the user, never an input. */
  error?: string;
  /** Measured maximum of the batch directory during extraction, in bytes. */
  peakBytes?: number;
  /**
   * Structured explanation of a whole-archive refusal. Persisted, so the reason
   * survives a restart and a closed panel — `failure` alone says "over_limit"
   * but not whether the count, the bytes or an unreadable index caused it.
   */
  rejection?: ZipRejection;
}

export type ZipFailure =
  /** The stored archive vanished or no longer has its declared length. */
  | 'missing'
  /** Bytes on disk no longer hash to the digest this batch accepted. */
  | 'unverifiable'
  /** The archive holds more books / bytes than one batch may take. */
  | 'over_limit'
  /** Free space is unknown or insufficient; nothing was written. */
  | 'disk'
  /** Anything else: worker fault, refused rename, permissions, cancellation. */
  | 'transient';

/**
 * Which archive-level rule refused the whole package.
 *
 * `count` — more importable books than one batch may hold.
 * `bytes` — the expansion does not fit the batch/workspace budget.
 * `entry` — one book inside the archive exceeds the per-book ceiling.
 * `disk`  — the filesystem does not have the free space.
 * `plan`  — the archive's index could not be read AND the extraction still could
 *           not be bounded, so the archive cannot be trusted with a partial run.
 */
export type ZipRejectionKind = 'count' | 'bytes' | 'entry' | 'disk' | 'plan';

/**
 * Everything the user needs to understand a whole-archive refusal, in the same
 * shape whether the numbers came from the central directory or from a real,
 * isolated extraction. `null` always means "not measured", never zero.
 */
export interface ZipRejection {
  kind: ZipRejectionKind;
  /** Human-readable reason, the same text the throw carries. */
  reason: string;
  /** True when the numbers come from a real extraction, not the archive index. */
  measured: boolean;
  /** Uncompressed bytes the archive claims (index) or actually produced (extract). */
  totalBytes: number | null;
  /** Bytes this batch could have taken at that moment. */
  budgetBytes: number | null;
  /** Importable books found; null when the archive could not be enumerated. */
  books: number | null;
  /** Books one batch may take, for context in the panel. */
  limit: number;
  /** Books already accepted before the refusal (a retry over an existing batch). */
  accepted: number;
  /** Always false: a whole-archive refusal never stages a single entry. */
  partiallyStaged: false;
  /** True — the original archive is kept so the user can split and retry. */
  archiveKept: true;
  /** Names of the books found, bounded; empty when unknown. */
  names: string[];
  /** What the user should do next, in one sentence. */
  nextStep: string;
}

/** One rejection category: the count is always exact, names are display-only. */
export interface RejectedGroup { count: number; names: string[] }

/** What a batch refused to take in, kept so nothing is ever dropped silently. */
export interface BatchRejected {
  unsupported: RejectedGroup;
  tooLarge: RejectedGroup;
  overBudget: RejectedGroup;
  duplicate: RejectedGroup;
  /** Entries beyond the per-batch item limit. */
  overflow: RejectedGroup;
}

/** Names kept per category; the count keeps the truth past this window. */
export const REJECTED_NAME_LIMIT = 100;

export function emptyRejected(): BatchRejected {
  return {
    unsupported: { count: 0, names: [] },
    tooLarge: { count: 0, names: [] },
    overBudget: { count: 0, names: [] },
    duplicate: { count: 0, names: [] },
    overflow: { count: 0, names: [] },
  };
}

function addNames(group: RejectedGroup, names: readonly string[]): void {
  // Names are deduplicated on purpose: the same archive is re-offered on every
  // retry, and recounting "封面.png" per attempt would invent refusals that
  // never happened. The count therefore tracks distinct refused names.
  for (const name of names) {
    if (group.names.includes(name)) continue;
    group.count += 1;
    if (group.names.length >= REJECTED_NAME_LIMIT) continue;
    group.names.push(name.slice(0, BATCH_NAME_LIMIT));
  }
}

export interface ImportBatch {
  schema: typeof BATCH_SCHEMA;
  id: string;
  createdAt: number;
  updatedAt: number;
  source: BatchSource;
  status: BatchStatus;
  /** Present only for `source === 'zip'`. */
  zip?: BatchZip;
  /** Separated from importing: a batch never queues reading unless asked. */
  toPlan: boolean;
  items: BatchItem[];
  /**
   * Everything this batch refused to take in, accumulated across add requests.
   * Without it a ZIP that hit the 100-book or 1 GiB limit would hand back a
   * partial shelf and look like a complete success.
   */
  rejected?: BatchRejected;
  error?: string;
}

const ITEM_STATUSES: readonly BatchItemStatus[] = ['pending', 'importing', 'processing', 'validating', 'completed', 'failed', 'cancelled', 'needs_reselect'];
const BATCH_STATUSES: readonly BatchStatus[] = ['preview', 'running', 'completed', 'cancelled'];
const SOURCES: readonly BatchSource[] = ['files', 'folder', 'zip'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SUPPORTED = /\.(txt|md|epub|pdf)$/iu;
const ACTIVE: readonly BatchItemStatus[] = ['importing', 'processing', 'validating'];
const RUNNABLE: readonly BatchItemStatus[] = ['pending'];
const TERMINAL_ITEM: readonly BatchItemStatus[] = ['completed', 'failed', 'cancelled', 'needs_reselect'];

export function isSupportedNovel(name: string): boolean {
  return SUPPORTED.test(name);
}

/** A persisted content digest must be a lowercase hex SHA-256, never free text. */
export function digestOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid content digest');
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid batch text');
  return value.trim();
}

/** Only the basename is ever a path; a relative name is metadata for grouping. */
export function safeBatchName(raw: string): string {
  const flat = raw.replace(/\\/gu, '/').trim();
  if (!flat || flat.length > BATCH_NAME_LIMIT) throw new Error('文件名过长或为空');
  if (flat.includes('\0')) throw new Error('文件名包含空字节');
  const parts = flat.split('/').filter(Boolean);
  if (!parts.length) throw new Error('文件名过长或为空');
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error('文件名包含路径穿越');
    if (/[<>:"|?*\u0000-\u001f]/u.test(part)) throw new Error('文件名包含非法字符');
  }
  return parts.join('/');
}

export function batchStagingName(itemId: string): string {
  if (!UUID.test(itemId)) throw new Error('Invalid batch item id');
  return itemId + '.src';
}

/** Staging files this module owns; anything else in a batch directory is left alone. */
export const BATCH_STAGING_EXT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.src$/;

export function newBatch(input: { id: string; source: BatchSource; toPlan?: boolean }, now: number): ImportBatch {
  if (!UUID.test(input.id)) throw new Error('Invalid batch id');
  if (!SOURCES.includes(input.source)) throw new Error('Invalid batch source');
  return { schema: BATCH_SCHEMA, id: input.id, createdAt: now, updatedAt: now, source: input.source,
    status: 'preview', toPlan: input.toPlan === true, items: [] };
}

function emptyItem(input: { id: string; name: string; size: number; title: string; author?: string; supported?: boolean; sourceSha256?: string; sourceName?: string }): BatchItem {
  return { id: input.id, name: input.name, size: input.size, status: 'pending', title: input.title,
    ...(input.author ? { author: input.author } : {}), attempts: 0,
    ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
    ...(input.sourceName ? { sourceName: input.sourceName } : {}),
    supported: input.supported ?? isSupportedNovel(input.name) };
}

export interface BatchItemInput { id: string; name: string; size: number; title: string; author?: string; sourceSha256?: string; sourceName?: string }

export interface BatchAddResult {
  added: BatchItem[];
  /** Same normalized path already in this batch. */
  duplicates: string[];
  /** Unsupported extension: kept out of the batch so it cannot fail every run. */
  unsupported: string[];
  /** Larger than the per-book ceiling; refused before anything is staged. */
  tooLarge: string[];
  /** Over the batch's 1 GiB disk budget; refused before anything is staged. */
  overBudget: string[];
  overflow: number;
  /** The books past the item limit, bounded; display-only. */
  overflowNames: string[];
}

/** Bytes this batch has promised to stage. Every item is capped by its own size. */
export function batchDeclaredBytes(batch: ImportBatch): number {
  return batch.items.reduce((total, item) => total + item.size, 0);
}

function pathKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Exported so an archive's content check uses the batch's own identity rule. */
export function pathKeyOf(name: string): string {
  return pathKey(name);
}

/**
 * Classify a pick list against a batch's current contents, without mutating it.
 *
 * `addBatchItems` and the archive content check share this one function on
 * purpose: a second, subtly different rule set is how a 101-book ZIP gets
 * accepted by one path and refused by the other. Budget ceilings are injected so
 * the caller decides which limit applies (a declared upload vs an extraction).
 */
export function classifyInputs(inputs: readonly BatchItemInput[], state: {
  /** Names already in the batch, already normalized with `pathKey`. */
  seen: ReadonlySet<string>;
  itemCount: number;
  declaredBytes: number;
  itemLimit: number;
  fileBytes: number;
  batchBytes: number;
}): { accepted: BatchItemInput[]; duplicates: string[]; unsupported: string[]; tooLarge: string[]; overBudget: string[]; overflow: number; overflowNames: string[] } {
  const accepted: BatchItemInput[] = [];
  const duplicates: string[] = [];
  const unsupported: string[] = [];
  const tooLarge: string[] = [];
  const overBudget: string[] = [];
  const seen = new Set(state.seen);
  let overflow = 0;
  // Names past the item limit are kept (bounded): "20 books did not fit" is far
  // less useful than knowing which 20, and a caller that drops them has to guess.
  const overflowNames: string[] = [];
  let declared = state.declaredBytes;
  for (const input of inputs) {
    let name: string;
    try { name = safeBatchName(input.name); } catch { duplicates.push(String(input.name)); continue; }
    if (!Number.isSafeInteger(input.size) || input.size < 1) { duplicates.push(name); continue; }
    if (!isSupportedNovel(name)) { unsupported.push(name); continue; }
    if (seen.has(pathKey(name))) { duplicates.push(name); continue; }
    if (input.size > state.fileBytes) { tooLarge.push(name); continue; }
    if (declared + input.size > state.batchBytes) { overBudget.push(name); continue; }
    if (state.itemCount + accepted.length >= state.itemLimit) {
      overflow += 1;
      if (overflowNames.length < REJECTED_NAME_LIMIT) overflowNames.push(name);
      continue;
    }
    seen.add(pathKey(name));
    declared += input.size;
    accepted.push(input);
  }
  return { accepted, duplicates, unsupported, tooLarge, overBudget, overflow, overflowNames };
}

/**
 * Accept items, refusing anything that cannot fit the batch budget *before* a
 * single byte is written. The budget is enforced again per chunk, so a batch can
 * never grow past it through repeated requests.
 */
export function addBatchItems(batch: ImportBatch, inputs: readonly BatchItemInput[], now: number): BatchAddResult {
  const verdict = classifyInputs(inputs, {
    seen: new Set(batch.items.map((item) => pathKey(item.name))),
    itemCount: batch.items.length,
    declaredBytes: batchDeclaredBytes(batch),
    itemLimit: BATCH_ITEM_LIMIT,
    fileBytes: MAX_BATCH_FILE_BYTES,
    batchBytes: BATCH_STAGING_BYTES,
  });
  const added: BatchItem[] = [];
  const misplaced: string[] = [];
  for (const input of verdict.accepted) {
    try {
      added.push(emptyItem({ id: input.id, name: safeBatchName(input.name), size: input.size, title: text(input.title, 200),
        ...(input.author === undefined || input.author === '' ? {} : { author: text(input.author, 100) }),
        ...(input.sourceSha256 === undefined ? {} : { sourceSha256: digestOf(input.sourceSha256) }),
        sourceName: text(input.sourceName ?? input.name, BATCH_NAME_LIMIT) }));
    } catch {
      // The classifier accepted it, so only a text field can fail here; the file
      // is refused by name rather than crashing the whole request.
      misplaced.push(input.name);
    }
  }
  if (added.length) { batch.items.push(...added); batch.updatedAt = now; }
  return { added,
    duplicates: [...verdict.duplicates, ...misplaced],
    unsupported: verdict.unsupported, tooLarge: verdict.tooLarge,
    overBudget: verdict.overBudget, overflow: verdict.overflow, overflowNames: verdict.overflowNames };
}

/**
 * Merge one add request's rejections into the batch's running report. The count
 * is exact even once the name window is full, so a partial import can never be
 * presented as a complete one.
 */
export function recordRejected(batch: ImportBatch, groups: {
  unsupported?: readonly string[]; tooLarge?: readonly string[]; overBudget?: readonly string[];
  duplicate?: readonly string[]; overflow?: number; overflowNames?: readonly string[];
}): void {
  const rejected = batch.rejected ?? emptyRejected();
  if (groups.unsupported?.length) addNames(rejected.unsupported, groups.unsupported);
  if (groups.tooLarge?.length) addNames(rejected.tooLarge, groups.tooLarge);
  if (groups.overBudget?.length) addNames(rejected.overBudget, groups.overBudget);
  if (groups.duplicate?.length) addNames(rejected.duplicate, groups.duplicate);
  if (groups.overflow) {
    rejected.overflow.count += groups.overflow;
    for (const name of groups.overflowNames ?? []) {
      if (rejected.overflow.names.length >= REJECTED_NAME_LIMIT) break;
      rejected.overflow.names.push(name.slice(0, BATCH_NAME_LIMIT));
    }
  }
  const used = rejected.unsupported.count + rejected.tooLarge.count + rejected.overBudget.count
    + rejected.duplicate.count + rejected.overflow.count;
  if (used > 0) batch.rejected = rejected;
}

export function findBatchItem(batch: ImportBatch, itemId: string): BatchItem {
  const item = batch.items.find((row) => row.id === itemId);
  if (!item) throw new Error('Import item not found');
  return item;
}

export function setItemStatus(batch: ImportBatch, itemId: string, status: BatchItemStatus, patch: { error?: string; bookKey?: string; staged?: string; duplicate?: DuplicateHint; duplicateOf?: string } = {}, now = Date.now()): BatchItem {
  if (!ITEM_STATUSES.includes(status)) throw new Error('Invalid import item status');
  const item = findBatchItem(batch, itemId);
  // An item only ever moves forward: a late progress tick must not un-finish it.
  if (TERMINAL_ITEM.includes(item.status) && !TERMINAL_ITEM.includes(status)) throw new Error('Import item already finished');
  item.status = status;
  if (patch.error !== undefined) { if (patch.error) item.error = patch.error.slice(0, 500); else delete item.error; }
  if (patch.bookKey !== undefined) item.bookKey = patch.bookKey;
  if (patch.staged !== undefined) item.staged = patch.staged;
  if (patch.duplicate !== undefined) item.duplicate = patch.duplicate;
  if (patch.duplicateOf !== undefined) item.duplicateOf = patch.duplicateOf;
  batch.updatedAt = now;
  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'needs_reselect') settleBatch(batch, now);
  return item;
}

/** A batch is only ever terminal once nothing can still run. */
function settleBatch(batch: ImportBatch, now: number): void {
  if (batch.status === 'cancelled') return;
  const live = batch.items.some((item) => item.status === 'pending' || ACTIVE.includes(item.status));
  if (live) batch.status = 'running';
  else if (batch.items.length) batch.status = 'completed';
  batch.updatedAt = now;
}

export function beginBatch(batch: ImportBatch, now: number): ImportBatch {
  if (!batch.items.length) throw new Error('Import batch is empty');
  if (batch.status === 'completed' || batch.status === 'cancelled') throw new Error('Import batch is already finished');
  // Unsupported entries never made it in, so a non-empty batch can always start.
  batch.status = 'running';
  for (const item of batch.items) if (item.status === 'needs_reselect') item.status = 'pending';
  batch.updatedAt = now;
  return batch;
}

export function cancelBatch(batch: ImportBatch, now: number, reason = 'Batch cancelled by the user'): string[] {
  const stopped: string[] = [];
  for (const item of batch.items) {
    if (item.status === 'completed' || item.status === 'cancelled') continue;
    if (ACTIVE.includes(item.status) || item.status === 'pending') stopped.push(item.id);
    item.status = 'cancelled';
  }
  batch.status = 'cancelled';
  batch.error = reason;
  batch.updatedAt = now;
  return stopped;
}

export function cancelItem(batch: ImportBatch, itemId: string, now: number, reason = 'Cancelled by the user'): boolean {
  const item = findBatchItem(batch, itemId);
  if (item.status === 'completed' || item.status === 'cancelled') return false;
  const running = ACTIVE.includes(item.status);
  item.status = 'cancelled';
  item.error = reason;
  settleBatch(batch, now);
  return running;
}

/** Retry reuses the staged bytes, so a transient parse failure needs no reselect. */
export function retryItem(batch: ImportBatch, itemId: string, now: number): BatchItem {
  const item = findBatchItem(batch, itemId);
  if (item.status === 'completed') throw new Error('Item already imported');
  if (ACTIVE.includes(item.status)) throw new Error('Item is still running');
  item.status = 'pending';
  item.attempts = 0;
  delete item.error;
  batch.status = 'running';
  batch.updatedAt = now;
  return item;
}

/**
 * Recovery: an in-flight item lost its worker with the process. Keeping the
 * staged bytes lets it run again; a missing or truncated file can only be fixed
 * by the user picking it again.
 */
export function reconcileBatch(batch: ImportBatch, stagedSize: (item: BatchItem) => number | null, now: number): { resumed: string[]; reselect: string[] } {
  const resumed: string[] = [];
  const reselect: string[] = [];
  for (const item of batch.items) {
    if (!ACTIVE.includes(item.status)) continue;
    const size = item.staged ? stagedSize(item) : null;
    if (size !== null && size === item.size) { item.status = 'pending'; resumed.push(item.id); }
    else { item.status = 'needs_reselect'; item.error = '导入被中断，暂存文件已不可用；请重新选择这个文件'; reselect.push(item.id); }
    batch.updatedAt = now;
  }
  if (batch.status === 'running') settleBatch(batch, now);
  if (batch.status === 'completed' && batch.items.some((item) => item.status === 'pending')) batch.status = 'running';
  return { resumed, reselect };
}

/** The items a runner may start right now, respecting per-item attempt limits. */
export function dispatchable(batch: ImportBatch, running: number, limit = BATCH_CONCURRENCY): BatchItem[] {
  if (batch.status !== 'running') return [];
  const room = Math.max(0, limit - running);
  if (!room) return [];
  const out: BatchItem[] = [];
  for (const item of batch.items) {
    if (out.length >= room) break;
    if (!RUNNABLE.includes(item.status)) continue;
    if (item.attempts >= BATCH_ATTEMPT_LIMIT) continue;
    out.push(item);
  }
  return out;
}

export function runningCount(batch: ImportBatch): number {
  return batch.items.filter((item) => ACTIVE.includes(item.status)).length;
}

// ------------------------------------------------------------------ duplicates

/**
 * The library's own identity: `sha256(title NFC + "\n" + author NFC)`. A batch
 * cannot know the body revision before parsing, so the preview only ever claims
 * a *possible* duplicate; the commit is the authoritative check.
 */
export function titleAuthorId(title: string, author: string): string {
  return createHash('sha256').update(`${title.normalize('NFC')}\n${author.normalize('NFC')}`).digest('hex');
}

export interface ExistingBook { key: string; id: string; title: string; author: string }

export function hintDuplicate(item: BatchItem, existing: readonly ExistingBook[]): { duplicate: DuplicateHint; duplicateOf: string } | null {
  const id = titleAuthorId(item.title, item.author ?? '');
  const same = existing.find((book) => book.id === id);
  return same ? { duplicate: 'new_version', duplicateOf: same.key } : null;
}

/** Items inside one batch pointing at the same title/author — one novel picked twice. */
export function markInBatchDuplicates(batch: ImportBatch): void {
  const byId = new Map<string, BatchItem>();
  for (const item of batch.items) {
    const id = titleAuthorId(item.title, item.author ?? '');
    const first = byId.get(id);
    if (!first) { byId.set(id, item); continue; }
    if (item.duplicate === undefined) { item.duplicate = 'in_batch'; item.duplicateOf = first.id; }
  }
}

// -------------------------------------------------------------------- preview

export interface BatchPreviewItem { id: string; name: string; title: string; author: string; size: number; supported: boolean;
  status: BatchItemStatus; attempts: number; bookKey?: string; error?: string;
  duplicate: DuplicateHint | null; duplicateOf: string | null; group: string | null }

export interface BatchGroup {
  key: string;
  name: string;
  itemIds: string[];
  evidence: SeriesSuggestion['evidence'];
  confidence: SeriesSuggestion['confidence'];
  /** true when the rows may equally be one novel split into several files. */
  mayBeSplitNovel: boolean;
  ambiguous: boolean;
}

export interface BatchPreview {
  batchId: string;
  source: BatchSource;
  status: BatchStatus;
  toPlan: boolean;
  count: number;
  supported: number;
  unsupported: string[];
  estimatedBytes: number;
  /** Already on the shelf with the same title and author (a different revision). */
  suspectedDuplicates: number;
  /** Identical title and author twice inside this batch. */
  inBatchDuplicates: number;
  items: BatchPreviewItem[];
  groups: BatchGroup[];
  cancelled: number;
  failed: number;
  needsReselect: number;
}

/**
 * `suggestSeries` groups by folder / shared base title / filename stem. A group
 * whose rows carry no volume number is reported as "possibly one novel split
 * into N files" and is never merged on the user's behalf.
 */
function groupSuggestions(batch: ImportBatch): BatchGroup[] {
  const candidates = batch.items.map((item) => ({ bookKey: item.id, title: item.title, filename: item.name.split('/').pop() ?? item.name, relativePath: item.name }));
  return suggestSeries(candidates).map((suggestion) => {
    const volumes = suggestion.bookKeys.map((id) => volumeOf(batch.items.find((item) => item.id === id)?.title ?? ''));
    const numbered = volumes.filter((row) => row !== null);
    const distinct = new Set(numbered.map((row) => row!.volume));
    const mayBeSplitNovel = distinct.size <= 1;
    return { key: suggestion.key, name: suggestion.name, itemIds: [...suggestion.bookKeys], evidence: suggestion.evidence,
      confidence: suggestion.confidence, mayBeSplitNovel,
      ambiguous: suggestion.ambiguous || mayBeSplitNovel };
  });
}

export function previewBatch(batch: ImportBatch, existing: readonly ExistingBook[]): BatchPreview {
  const items = batch.items.map((item) => {
    const hint = item.status === 'completed' && item.bookKey
      ? (item.duplicate ? { duplicate: item.duplicate, duplicateOf: item.duplicateOf ?? item.bookKey } : null)
      : item.duplicate ? { duplicate: item.duplicate, duplicateOf: item.duplicateOf ?? '' }
      : hintDuplicate(item, existing);
    return { id: item.id, name: item.name, title: item.title, author: item.author ?? '', size: item.size,
      supported: item.supported, status: item.status, attempts: item.attempts,
      ...(item.bookKey ? { bookKey: item.bookKey } : {}), ...(item.error ? { error: item.error } : {}),
      duplicate: hint?.duplicate ?? null, duplicateOf: hint?.duplicateOf ?? null,
      group: item.group ?? null };
  });
  const groups = groupSuggestions(batch);
  const groupOf = new Map<string, string>();
  for (const group of groups) for (const id of group.itemIds) groupOf.set(id, group.key);
  for (const item of items) item.group = groupOf.get(item.id) ?? null;
  return {
    batchId: batch.id, source: batch.source, status: batch.status, toPlan: batch.toPlan,
    count: items.length, supported: items.filter((row) => row.supported).length,
    unsupported: items.filter((row) => !row.supported).map((row) => row.name),
    estimatedBytes: batch.items.reduce((total, item) => total + item.size, 0),
    suspectedDuplicates: items.filter((row) => row.duplicate === 'new_version' || row.duplicate === 'identical').length,
    inBatchDuplicates: items.filter((row) => row.duplicate === 'in_batch').length,
    items, groups,
    cancelled: batch.items.filter((item) => item.status === 'cancelled').length,
    failed: batch.items.filter((item) => item.status === 'failed').length,
    needsReselect: batch.items.filter((item) => item.status === 'needs_reselect').length,
  };
}

// ------------------------------------------------------------------ validation

export function validateBatches(raw: unknown, now = 0): ImportBatch[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Invalid import batches');
  if (raw.length > BATCH_ARCHIVE_LIMIT + 4) throw new Error('Too many import batches');
  const ids = new Set<string>();
  const out: ImportBatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid import batch');
    const batch = entry as ImportBatch;
    if (batch.schema !== BATCH_SCHEMA || typeof batch.id !== 'string' || !UUID.test(batch.id) || ids.has(batch.id)) throw new Error('Invalid import batch');
    ids.add(batch.id);
    if (!SOURCES.includes(batch.source) || !BATCH_STATUSES.includes(batch.status)) throw new Error('Invalid import batch');
    if (!Number.isSafeInteger(batch.createdAt) || batch.createdAt < 0 || !Number.isSafeInteger(batch.updatedAt) || batch.updatedAt < batch.createdAt) throw new Error('Invalid import batch timing');
    if (typeof batch.toPlan !== 'boolean' || !Array.isArray(batch.items) || batch.items.length > BATCH_ITEM_LIMIT) throw new Error('Invalid import batch');
    if (batch.zip !== undefined) {
      if (batch.source !== 'zip') throw new Error('Invalid import batch archive metadata');
      const zip = batch.zip;
      if (!zip || typeof zip !== 'object' || typeof zip.name !== 'string' || !zip.name || zip.name.length > BATCH_NAME_LIMIT) throw new Error('Invalid import batch archive name');
      if (!Number.isSafeInteger(zip.size) || zip.size < 1 || zip.size > ZIP_MAX_BYTES) throw new Error('Invalid import batch archive size');
      if (!['uploading', 'needs_reselect', 'ready', 'extracted'].includes(zip.state)) throw new Error('Invalid import batch archive state');
      if (zip.sha256 !== undefined) digestOf(zip.sha256);
      if (zip.claimedSha256 !== undefined) digestOf(zip.claimedSha256);
      if (zip.peakBytes !== undefined && (!Number.isSafeInteger(zip.peakBytes) || zip.peakBytes < 0)) throw new Error('Invalid import batch archive peak');
      if (zip.failure !== undefined && !['missing', 'unverifiable', 'over_limit', 'disk', 'transient'].includes(zip.failure)) throw new Error('Invalid import batch archive failure');
      if (zip.error !== undefined && (typeof zip.error !== 'string' || zip.error.length > 500)) throw new Error('Invalid import batch archive error');
      if (zip.rejection !== undefined) validateZipRejection(zip.rejection);
    }
    if (batch.error !== undefined && (typeof batch.error !== 'string' || batch.error.length > 500)) throw new Error('Invalid import batch error');
    if (batch.rejected !== undefined) validateRejected(batch.rejected);
    const itemIds = new Set<string>();
    for (const item of batch.items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !UUID.test(item.id) || itemIds.has(item.id)) throw new Error('Invalid import item');
      itemIds.add(item.id);
      if (typeof item.name !== 'string' || !item.name || item.name.length > BATCH_NAME_LIMIT || item.name.includes('\\') || item.name.includes('\0')) throw new Error('Invalid import item name');
      if (!ITEM_STATUSES.includes(item.status) || typeof item.supported !== 'boolean') throw new Error('Invalid import item status');
      if (item.sourceSha256 !== undefined) digestOf(item.sourceSha256);
      if (item.sourceName !== undefined && (typeof item.sourceName !== 'string' || !item.sourceName || item.sourceName.length > BATCH_NAME_LIMIT || item.sourceName.includes('\0'))) throw new Error('Invalid import item source name');
      if (!Number.isSafeInteger(item.size) || item.size < 0 || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 99) throw new Error('Invalid import item counters');
      if (typeof item.title !== 'string' || typeof item.bookKey !== 'undefined' && typeof item.bookKey !== 'string') throw new Error('Invalid import item text');
      if (item.author !== undefined && (typeof item.author !== 'string' || item.author.length > 100)) throw new Error('Invalid import item author');
      if (item.staged !== undefined && (typeof item.staged !== 'string' || item.staged !== batchStagingName(item.id))) throw new Error('Invalid import item staging name');
      if (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 500)) throw new Error('Invalid import item error');
      if (item.duplicate !== undefined && !['identical', 'new_version', 'in_batch'].includes(item.duplicate)) throw new Error('Invalid import item duplicate hint');
      if (item.duplicateOf !== undefined && typeof item.duplicateOf !== 'string') throw new Error('Invalid import item duplicate pointer');
      if (item.group !== undefined && typeof item.group !== 'string') throw new Error('Invalid import item group');
      if (item.status === 'completed' && !item.bookKey) throw new Error('Completed import item has no book');
    }
    out.push({ ...batch, items: batch.items.map((item) => ({ ...item })) });
  }
  void now;
  return out;
}

/** Keep the newest finished batches and every unfinished one. */
export function trimBatches(batches: readonly ImportBatch[], limit = BATCH_ARCHIVE_LIMIT): ImportBatch[] {
  const live = batches.filter((batch) => batch.status !== 'completed' && batch.status !== 'cancelled');
  const done = batches.filter((batch) => batch.status === 'completed' || batch.status === 'cancelled')
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit - live.length));
  const keep = new Set([...live, ...done].map((batch) => batch.id));
  return batches.filter((batch) => keep.has(batch.id));
}

/** Books a finished batch can offer to the plan, in the batch's own order. */
export function completedBookKeys(batch: ImportBatch): string[] {
  return batch.items.filter((item) => item.status === 'completed' && item.bookKey).map((item) => item.bookKey!);
}

/**
 * The complete outcome of a batch: what came in, what reached the shelf, and
 * everything that was refused. A batch is finished only when the caller can see
 * all three — "accepted items completed" alone is not a success report.
 */
export interface ImportBatchReport {
  /** Entries the batch accepted. */
  accepted: number;
  /** Entries that actually reach the shelf. */
  shelfAdded: number;
  pending: number;
  failed: number;
  cancelled: number;
  needsReselect: number;
  duplicate: number;
  unsupported: number;
  tooLarge: number;
  overBudget: number;
  overflow: number;
  /** Refused names, display-only; the counts stay exact past this window. */
  rejectedNames: { duplicate: string[]; unsupported: string[]; tooLarge: string[]; overBudget: string[]; overflow: string[] };
  /** True when at least one picked file never made it into the batch. */
  incomplete: boolean;
  /** Set when the whole archive was refused; null when it was not. */
  archiveRejected: ZipRejection | null;
}

export function batchReport(batch: ImportBatch): ImportBatchReport {
  const count = (status: BatchItemStatus) => batch.items.filter((item) => item.status === status).length;
  const rejected = batch.rejected;
  const shelfAdded = batch.items.filter((item) => item.bookKey !== undefined).length;
  const refusal = {
    duplicate: rejected?.duplicate.count ?? 0,
    unsupported: rejected?.unsupported.count ?? 0,
    tooLarge: rejected?.tooLarge.count ?? 0,
    overBudget: rejected?.overBudget.count ?? 0,
    overflow: rejected?.overflow.count ?? 0,
  };
  return {
    accepted: batch.items.length,
    shelfAdded,
    pending: count('pending') + runningCount(batch),
    failed: count('failed'),
    cancelled: count('cancelled'),
    needsReselect: count('needs_reselect'),
    ...refusal,
    rejectedNames: {
      duplicate: rejected?.duplicate.names ?? [],
      unsupported: rejected?.unsupported.names ?? [],
      tooLarge: rejected?.tooLarge.names ?? [],
      overBudget: rejected?.overBudget.names ?? [],
      overflow: rejected?.overflow.names ?? [],
    },
    incomplete: Object.values(refusal).some((value) => value > 0) || count('failed') > 0 || count('needs_reselect') > 0
      || batch.zip?.rejection !== undefined,
    archiveRejected: batch.zip?.rejection ?? null,
  };
}

/**
 * A persisted refusal must be self-consistent: "unknown" is `null`, and a count
 * that claims to be measured has to be a real number. Anything else would be a
 * fabricated figure in a review document.
 */
function validateZipRejection(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid archive rejection');
  const value = raw as Record<string, unknown>;
  if (!['count', 'bytes', 'entry', 'disk', 'plan'].includes(String(value.kind))) throw new Error('Invalid archive rejection kind');
  if (typeof value.reason !== 'string' || !value.reason || value.reason.length > 500) throw new Error('Invalid archive rejection reason');
  if (typeof value.measured !== 'boolean') throw new Error('Invalid archive rejection measurement flag');
  for (const field of ['totalBytes', 'budgetBytes', 'books']) {
    const number = value[field];
    if (number !== null && (!Number.isSafeInteger(number) || (number as number) < 0)) throw new Error('Invalid archive rejection figure');
  }
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1) throw new Error('Invalid archive rejection limit');
  if (!Number.isSafeInteger(value.accepted) || (value.accepted as number) < 0) throw new Error('Invalid archive rejection accepted count');
  if (value.partiallyStaged !== false || value.archiveKept !== true) throw new Error('Invalid archive rejection invariants');
  if (!Array.isArray(value.names) || value.names.length > REJECTED_NAME_LIMIT) throw new Error('Invalid archive rejection names');
  for (const name of value.names) {
    if (typeof name !== 'string' || !name || name.length > BATCH_NAME_LIMIT) throw new Error('Invalid archive rejection name');
  }
  if (typeof value.nextStep !== 'string' || !value.nextStep || value.nextStep.length > 500) throw new Error('Invalid archive rejection next step');
}

function validateRejected(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid import batch rejections');
  const value = raw as Record<string, unknown>;
  const group = (name: string): void => {
    const entry = value[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid import batch rejection group');
    const row = entry as { count?: unknown; names?: unknown };
    if (!Number.isSafeInteger(row.count) || (row.count as number) < 0) throw new Error('Invalid import batch rejection count');
    if (!Array.isArray(row.names) || row.names.length > REJECTED_NAME_LIMIT) throw new Error('Invalid import batch rejection names');
    for (const item of row.names) {
      if (typeof item !== 'string' || !item || item.length > BATCH_NAME_LIMIT) throw new Error('Invalid import batch rejection name');
    }
  };
  for (const name of ['unsupported', 'tooLarge', 'overBudget', 'duplicate', 'overflow']) group(name);
}

export function batchSummary(batch: ImportBatch): { id: string; source: BatchSource; status: BatchStatus; toPlan: boolean;
  total: number; completed: number; failed: number; cancelled: number; needsReselect: number; pending: number;
  title: string; createdAt: number; updatedAt: number } {
  const count = (status: BatchItemStatus) => batch.items.filter((item) => item.status === status).length;
  const first = batch.items[0];
  // An archive batch may have no items yet (interrupted upload); name it by the
  // archive so it is recognisable in the history list.
  const title = batch.items.length === 0 ? (batch.zip?.name ?? '导入')
    : batch.items.length === 1 && first ? first.title : `${first?.title ?? '导入'} 等 ${batch.items.length} 本`;
  return { id: batch.id, source: batch.source, status: batch.status, toPlan: batch.toPlan, total: batch.items.length,
    completed: count('completed'), failed: count('failed'), cancelled: count('cancelled'),
    needsReselect: count('needs_reselect'), pending: count('pending') + runningCount(batch),
    title: title.slice(0, 120), createdAt: batch.createdAt, updatedAt: batch.updatedAt };
}
