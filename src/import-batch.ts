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
}

export interface ImportBatch {
  schema: typeof BATCH_SCHEMA;
  id: string;
  createdAt: number;
  updatedAt: number;
  source: BatchSource;
  status: BatchStatus;
  /** Separated from importing: a batch never queues reading unless asked. */
  toPlan: boolean;
  items: BatchItem[];
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

function emptyItem(input: { id: string; name: string; size: number; title: string; author?: string; supported?: boolean }): BatchItem {
  return { id: input.id, name: input.name, size: input.size, status: 'pending', title: input.title,
    ...(input.author ? { author: input.author } : {}), attempts: 0,
    supported: input.supported ?? isSupportedNovel(input.name) };
}

export interface BatchItemInput { id: string; name: string; size: number; title: string; author?: string }

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
}

/** Bytes this batch has promised to stage. Every item is capped by its own size. */
export function batchDeclaredBytes(batch: ImportBatch): number {
  return batch.items.reduce((total, item) => total + item.size, 0);
}

function pathKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Accept items, refusing anything that cannot fit the batch budget *before* a
 * single byte is written. The budget is enforced again per chunk, so a batch can
 * never grow past it through repeated requests.
 */
export function addBatchItems(batch: ImportBatch, inputs: readonly BatchItemInput[], now: number): BatchAddResult {
  const seen = new Set(batch.items.map((item) => pathKey(item.name)));
  const added: BatchItem[] = [];
  const duplicates: string[] = [];
  const unsupported: string[] = [];
  const tooLarge: string[] = [];
  const overBudget: string[] = [];
  let overflow = 0;
  let declared = batchDeclaredBytes(batch);
  for (const input of inputs) {
    let name: string;
    try { name = safeBatchName(input.name); } catch { duplicates.push(String(input.name)); continue; }
    if (!Number.isSafeInteger(input.size) || input.size < 1) { duplicates.push(name); continue; }
    if (!isSupportedNovel(name)) { unsupported.push(name); continue; }
    if (seen.has(pathKey(name))) { duplicates.push(name); continue; }
    if (input.size > MAX_BATCH_FILE_BYTES) { tooLarge.push(name); continue; }
    if (declared + input.size > BATCH_STAGING_BYTES) { overBudget.push(name); continue; }
    if (batch.items.length + added.length >= BATCH_ITEM_LIMIT) { overflow++; continue; }
    seen.add(pathKey(name));
    declared += input.size;
    added.push(emptyItem({ id: input.id, name, size: input.size, title: text(input.title, 200),
      ...(input.author === undefined || input.author === '' ? {} : { author: text(input.author, 100) }) }));
  }
  if (added.length) { batch.items.push(...added); batch.updatedAt = now; }
  return { added, duplicates, unsupported, tooLarge, overBudget, overflow };
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
    if (batch.error !== undefined && (typeof batch.error !== 'string' || batch.error.length > 500)) throw new Error('Invalid import batch error');
    const itemIds = new Set<string>();
    for (const item of batch.items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !UUID.test(item.id) || itemIds.has(item.id)) throw new Error('Invalid import item');
      itemIds.add(item.id);
      if (typeof item.name !== 'string' || !item.name || item.name.length > BATCH_NAME_LIMIT || item.name.includes('\\') || item.name.includes('\0')) throw new Error('Invalid import item name');
      if (!ITEM_STATUSES.includes(item.status) || typeof item.supported !== 'boolean') throw new Error('Invalid import item status');
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

export function batchSummary(batch: ImportBatch): { id: string; source: BatchSource; status: BatchStatus; toPlan: boolean;
  total: number; completed: number; failed: number; cancelled: number; needsReselect: number; pending: number;
  title: string; createdAt: number; updatedAt: number } {
  const count = (status: BatchItemStatus) => batch.items.filter((item) => item.status === status).length;
  const first = batch.items[0];
  const title = batch.items.length === 1 && first ? first.title : `${first?.title ?? '导入'} 等 ${batch.items.length} 本`;
  return { id: batch.id, source: batch.source, status: batch.status, toPlan: batch.toPlan, total: batch.items.length,
    completed: count('completed'), failed: count('failed'), cancelled: count('cancelled'),
    needsReselect: count('needs_reselect'), pending: count('pending') + runningCount(batch),
    title: title.slice(0, 120), createdAt: batch.createdAt, updatedAt: batch.updatedAt };
}
