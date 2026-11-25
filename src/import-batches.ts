/**
 * Runtime for batch import: staging, bounded concurrency, per-item retry and
 * restart recovery.
 *
 * Parsing is still the single-file `ImportJob` worker and the commit is still
 * `Library.adoptValidatedImport`, so body normalization, encoding repair, paged
 * storage and duplicate identity stay byte-identical to a one-file import.
 * Nothing here advances reading progress.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ImportJob, cleanImportDirectory } from './import-job.ts';
import { detectImportMetadata } from './import-metadata.ts';
import { MAX_BOOK_BYTES } from './books.ts';
import { extractRuntimeZip } from './novel-runtime/archive.ts';
import {
  BATCH_ITEM_LIMIT, BATCH_STAGING_BYTES, BATCH_STAGING_EXT, MAX_BATCH_FILE_BYTES, batchDeclaredBytes,
  batchStagingName, batchSummary, beginBatch, cancelBatch, digestOf,
  cancelItem, completedBookKeys, dispatchable, findBatchItem, markInBatchDuplicates, newBatch,
  previewBatch, reconcileBatch, retryItem, runningCount, setItemStatus, ZIP_MAX_BYTES,
  type BatchAddResult, type BatchItem, type BatchSource, type BatchZip, type ImportBatch,
} from './import-batch.ts';
import type { Library } from './library.ts';

/** Same chunk size the single-file transfer already uses. */
export const BATCH_CHUNK = 256 * 1024;
export { BATCH_STAGING_BYTES, MAX_BATCH_FILE_BYTES, ZIP_MAX_BYTES } from './import-batch.ts';
const TICK_MS = 250;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMPORT_DIR = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.import$/;

interface Active { batchId: string; job: ImportJob; timer?: ReturnType<typeof setInterval>; reported: boolean }

/** Archive metadata as the panel sees it. */
export interface BatchZipView { name: string; size: number; state: BatchZip['state']; sha256?: string; peakBytes?: number;
  /** False when a re-pick cannot be proven to be the same archive (new batch required). */
  reselectable: boolean }

/**
 * SHA-256 of a file, streamed in 256 KiB slices.
 *
 * A batch may hold 1 GiB of books, so nothing here ever loads a file (let alone
 * a batch) into memory: the digest is incremental and the buffer is reused. At
 * most BATCH_CONCURRENCY digests can be in flight, so the peak cost is a few
 * hundred kilobytes regardless of batch size.
 */
export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const fd = openSync(file, 'r');
  try {
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

const baseNameOf = (name: string): string => name.replace(/\\/gu, '/').split('/').filter(Boolean).pop() ?? name;

/**
 * Read exactly `length` bytes at `offset` through one bounded buffer.
 *
 * Chunk replay used to read the whole staged file and slice it, which loads up
 * to 512 MiB to compare a 256 KiB chunk. The read is now bounded by the chunk
 * size by construction; a short result means the file is shorter than claimed.
 */
export function readRange(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let at = 0;
    while (at < length) {
      const read = readSync(fd, buffer, at, length - at, offset + at);
      if (read <= 0) break;
      at += read;
    }
    return buffer.subarray(0, at);
  } finally { closeSync(fd); }
}

function isVanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Logical bytes of every regular file under `dir`, recursively.
 *
 * The flat one-level walk under-counted nested archive layouts ("系列/第一部/
 * 正文/book1.txt"). Symlinks are never followed (they are not content), a
 * directory never counts as its own content, and a path that vanishes mid-walk
 * is simply gone. A directory that cannot be read at all throws: "unknown" must
 * never be reported as zero, or the budget would silently over-allow.
 */
export function dirTreeBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(full); } catch (error) { if (isVanished(error)) continue; throw error; }
    if (stat.isDirectory()) {
      try { total += dirTreeBytes(full); } catch (error) { if (isVanished(error)) continue; throw error; }
    } else if (stat.isFile()) total += stat.size;
  }
  return total;
}

/** Free bytes on the filesystem holding `path`; null when it cannot be measured. */
function diskFreeBytes(path: string): number | null {
  try { const info = statfsSync(path); return info.bavail * info.bsize; } catch { return null; }
}

/**
 * Disk ceilings. Defaults are the shipping values; tests may inject smaller
 * numbers so boundary behaviour can be proven without staging a gigabyte.
 */
export interface BatchBudget { batchBytes: number; fileBytes: number; zipBytes: number; workspaceBytes: number }
export const DEFAULT_BATCH_BUDGET: BatchBudget = {
  batchBytes: BATCH_STAGING_BYTES, fileBytes: MAX_BATCH_FILE_BYTES, zipBytes: ZIP_MAX_BYTES,
  // The archive and the extracted tree coexist for a moment. Entries are then
  // renamed into place, so the real workspace is exactly these two sums — not
  // a third copy of every book.
  workspaceBytes: ZIP_MAX_BYTES + BATCH_STAGING_BYTES,
};

export interface ImportBatchesOptions { now?: () => number; budget?: Partial<BatchBudget>; diskFree?: (path: string) => number | null }

/** What a finished extraction reports; a repeat call sees `alreadyExtracted`. */
export type ZipExtractResult = BatchAddResult & { alreadyExtracted?: boolean };

function emptyAddResult(): BatchAddResult {
  return { added: [], duplicates: [], unsupported: [], tooLarge: [], overBudget: [], overflow: 0 };
}

export interface BatchItemView { id: string; name: string; title: string; author: string; size: number;
  status: string; attempts: number; bookKey?: string; error?: string; duplicate?: string }

export class ImportBatches {
  private readonly dir: string;
  private readonly live = new Map<string, Active>();
  private disposed = false;
  private readonly now: () => number;
  private readonly budget: BatchBudget;
  private readonly diskFree: (path: string) => number | null;
  /** One extraction at a time per batch: repeats, recovery and retries share the flight. */
  private readonly extracting = new Map<string, Promise<ZipExtractResult>>();

  constructor(private readonly library: Library, root: string, options: ImportBatchesOptions = {}) {
    this.dir = join(root, 'batches');
    this.now = options.now ?? Date.now;
    this.budget = { ...DEFAULT_BATCH_BUDGET, ...(options.budget ?? {}) };
    this.diskFree = options.diskFree ?? diskFreeBytes;
    // A workspace smaller than its own parts would silently cap whatever is
    // extracted last; refuse the configuration instead of producing surprises.
    if (this.budget.workspaceBytes < this.budget.zipBytes + this.budget.batchBytes) {
      throw new Error('Batch workspace budget must cover the archive plus the staged books');
    }
  }

  // --------------------------------------------------------------- staging

  private batchDir(batchId: string): string {
    if (!UUID.test(batchId)) throw new Error('Invalid batch id');
    return join(this.dir, batchId);
  }

  private stagedPath(batchId: string, item: BatchItem): string {
    return join(this.batchDir(batchId), batchStagingName(item.id));
  }

  /**
   * Reclaim leftovers of the previous run. Only directories that name a known
   * batch survive, and inside them only the module's own staging shapes are read.
   */
  cleanStale(): void {
    mkdirSync(this.dir, { recursive: true });
    const known = new Set(this.library.importBatches().map((batch) => batch.id));
    for (const name of readdirSync(this.dir)) {
      if (!UUID.test(name)) continue;
      const dir = join(this.dir, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
      if (!known.has(name)) { rmSync(dir, { recursive: true, force: true }); continue; }
      for (const file of readdirSync(dir)) {
        if (IMPORT_DIR.test(file)) cleanImportDirectory(dir, file);
        else if (/\.extract$/u.test(file)) rmSync(join(dir, file), { recursive: true, force: true });
        // An upload cannot survive the process, but an already-accepted archive
        // can: it stays until its extraction has actually succeeded.
        else if (file === 'source.zip') {
          const batch = this.library.importBatches().find((row) => row.id === name);
          if (batch?.zip?.state !== 'ready') rmSync(join(dir, file), { force: true });
        }
        else if (BATCH_STAGING_EXT.test(file) && !this.isReferenced(name, file)) unlinkSync(join(dir, file));
      }
    }
  }

  private isReferenced(batchId: string, file: string): boolean {
    const batch = this.library.importBatches().find((row) => row.id === batchId);
    return !!batch?.items.some((item) => batchStagingName(item.id) === file);
  }

  // ------------------------------------------------------------------ state

  list(): ImportBatch[] { return this.library.importBatches(); }

  /** Compact list for the shelf panel: no per-item payload until one is opened. */
  summaries() { return this.library.importBatches().map((batch) => batchSummary(batch)); }

  status(batchId: string): ReturnType<typeof batchSummary> & ReturnType<typeof previewBatch> & { zip?: BatchZipView } {
    const batch = this.require(batchId);
    const preview = previewBatch(batch, this.library.list());
    const zip = batch.zip ? {
      name: batch.zip.name, size: batch.zip.size, state: batch.zip.state,
      reselectable: !!(batch.zip.sha256 || batch.zip.claimedSha256),
      ...(batch.zip.sha256 ? { sha256: batch.zip.sha256 } : {}),
      ...(batch.zip.peakBytes !== undefined ? { peakBytes: batch.zip.peakBytes } : {}),
    } : undefined;
    return { ...batchSummary(batch), ...preview, ...(zip ? { zip } : {}) };
  }

  /** Upload progress is in-memory only; durability is at item granularity. */
  create(input: unknown): ImportBatch {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid import batch request');
    const value = input as Record<string, unknown>;
    const source = String(value.source ?? 'files') as BatchSource;
    if (!['files', 'folder', 'zip'].includes(source)) throw new Error('Invalid import batch source');
    if (value.toPlan !== undefined && typeof value.toPlan !== 'boolean') throw new Error('Invalid import batch plan flag');
    const batch = newBatch({ id: randomUUID(), source, toPlan: value.toPlan === true }, this.now());
    mkdirSync(this.batchDir(batch.id), { recursive: true });
    return this.library.createImportBatch(batch);
  }

  /**
   * Files, a folder and a ZIP all end up as the same item list. The provisional
   * title only seeds the preview; the parsed body decides the final identity.
   */
  addItems(batchId: string, raw: unknown) {
    const inputs = normalizeInputs(raw);
    // Refuse anything that cannot fit the disk budget before touching disk, and
    // report it instead of dropping it silently.
    const batch = this.require(batchId);
    let declared = batchDeclaredBytes(batch);
    const tooLarge: string[] = [];
    const overBudget: string[] = [];
    const accepted: typeof inputs = [];
    for (const input of inputs) {
      if (input.size > this.budget.fileBytes) { tooLarge.push(input.name); continue; }
      if (declared + input.size > this.budget.batchBytes) { overBudget.push(input.name); continue; }
      declared += input.size;
      accepted.push(input);
    }
    const result = this.library.addImportBatchItems(batchId, accepted.map((input) => ({
      id: randomUUID(), name: input.name, size: input.size,
      title: input.title ?? detectImportMetadata(basename(input.name)).title,
      ...(input.author === undefined ? {} : { author: input.author }),
      ...(input.sourceSha256 === undefined ? {} : { sourceSha256: input.sourceSha256 }),
      ...(input.sourceName === undefined ? {} : { sourceName: input.sourceName }),
    })));
    if (tooLarge.length) result.tooLarge = [...tooLarge, ...(result.tooLarge ?? [])];
    if (overBudget.length) result.overBudget = [...overBudget, ...(result.overBudget ?? [])];
    // Only a request that actually added rows re-marks in-batch duplicates; a
    // retry of an extraction re-offers the same names, and re-marking them would
    // smear "same title as another pick" hints across entries that are fine.
    if (accepted.length) this.library.updateImportBatch(batchId, (draft) => { markInBatchDuplicates(draft); });
    return result;
  }

  /**
   * Stream one staged file, append-only.
   *
   * The staging file's real length is the only accepted write position, so a
   * skipped chunk, an inconsistent overlap or a sparse file pretending to be
   * complete are all impossible: a gap would make `offset !== size`. A replayed
   * chunk is accepted only when its bytes are byte-identical to what is already
   * on disk, which makes a retried request idempotent without letting a client
   * rewrite history.
   */
  stage(batchId: string, itemId: unknown, offset: unknown, base64: unknown) {
    const batch = this.require(batchId);
    const item = findBatchItem(batch, String(itemId));
    if (item.status !== 'pending' && item.status !== 'needs_reselect') throw new Error('Import item is not accepting data');
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid import chunk offset');
    if (typeof base64 !== 'string' || base64.length > Math.ceil(BATCH_CHUNK / 3) * 4) throw new Error('Invalid import chunk');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > BATCH_CHUNK || bytes.toString('base64') !== base64) throw new Error('Invalid import chunk');
    // Budget is re-checked here, not only in the panel: the declared sizes of the
    // whole batch must fit, and the item must fit its own declared size.
    if (batchDeclaredBytes(batch) > this.budget.batchBytes) throw new Error('Import batch exceeds the 1 GiB disk budget');
    if (item.size > this.budget.fileBytes) throw new Error('A single novel must be at most 100 MiB');
    if ((offset as number) + bytes.length > item.size) throw new Error('Import chunk exceeds the declared size');
    const file = this.stagedPath(batchId, item);
    mkdirSync(this.batchDir(batchId), { recursive: true });
    const written = existsSync(file) ? statSync(file).size : 0;
    if ((offset as number) > written) throw new Error('Import chunk skipped bytes; upload the missing part first');
    if ((offset as number) < written) {
      if ((offset as number) + bytes.length > written) throw new Error('Import chunk overlaps the staged data inconsistently');
      const existing = readRange(file, offset as number, bytes.length);
      if (existing.length !== bytes.length || !existing.equals(bytes)) throw new Error('Import chunk replay does not match the staged data');
      return { offset: (offset as number) + bytes.length, complete: written === item.size, replayed: true };
    }
    let fd: number;
    // `w` only for the first chunk of a fresh file; everything else must append
    // to what is already there.
    try { fd = openSync(file, written === 0 ? 'w' : 'r+'); }
    catch { throw new Error('Cannot open the import staging file'); }
    try { let at = 0; while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, (offset as number) + at); }
    finally { closeSync(fd); }
    if (statSync(file).size !== (offset as number) + bytes.length) throw new Error('Staged file length does not match the uploaded offset');
    if (item.staged === undefined || item.status === 'needs_reselect') {
      this.library.updateImportBatch(batchId, (draft) => {
        const row = findBatchItem(draft, item.id);
        row.staged = batchStagingName(item.id);
        if (row.status === 'needs_reselect') row.status = 'pending';
        delete row.error;
      });
    }
    if ((offset as number) + bytes.length < item.size) return { offset: (offset as number) + bytes.length, complete: false };
    // Last byte is on disk. The bytes themselves decide the entry's identity:
    // a resumed upload must hash to exactly what was originally accepted, so two
    // same-length files can never be confused no matter what the client claims.
    const digest = sha256File(file);
    if (item.sourceSha256 && digest !== item.sourceSha256) {
      rmSync(file, { force: true });
      this.library.updateImportBatch(batchId, (draft) => {
        const row = findBatchItem(draft, item.id);
        row.status = 'needs_reselect';
        row.error = '所选文件的内容与最初选择的文件不一致；请重新选择原始文件。';
        delete row.staged;
      });
      throw new Error('The picked file is not the same book: its content differs from the original selection');
    }
    this.library.updateImportBatch(batchId, (draft) => {
      const row = findBatchItem(draft, item.id);
      row.sourceSha256 = digest;
      row.staged = batchStagingName(item.id);
    });
    // Importing may only start once the last byte is on disk and verified. This
    // is also what lets a restored entry rejoin a batch that is already running.
    this.pump();
    return { offset: item.size, complete: true, sha256: digest };
  }

  /**
   * Re-attach a file the user picked again for an item that lost its bytes.
   * The item keeps its id and its position in the batch; only the staging bytes
   * are replaced, so a resume never re-imports the books that already succeeded.
   */
  reselect(batchId: string, itemId: unknown, input: unknown) {
    const batch = this.require(batchId);
    const item = findBatchItem(batch, String(itemId));
    if (item.status !== 'needs_reselect') throw new Error('Only an item that lost its file needs to be picked again');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reselect request');
    // Without a recorded digest there is nothing to prove the replacement is the
    // same book, and pretending otherwise is exactly the bug this rule exists to
    // prevent. The record stays as evidence; the user imports it again instead.
    if (!item.sourceSha256) {
      throw new Error('This entry was saved before content verification, so a replacement cannot be proven to be the original. Start a new batch for it; this record is kept unchanged.');
    }
    const size = (input as { size?: unknown }).size;
    if (!Number.isSafeInteger(size) || (size as number) < 1) throw new Error('Invalid reselect size');
    // The replacement must be the same book, so its length must match what the
    // batch recorded; anything else would silently import a different file.
    if ((size as number) !== item.size) throw new Error(`This entry expects a ${item.size} byte file; the picked file is ${size} bytes`);
    // The name is checked too: a same-length, same-content file under a different
    // title is still a different entry in the user's list.
    const picked = (input as { name?: unknown }).name;
    if (picked !== undefined) {
      if (typeof picked !== 'string' || !picked) throw new Error('Invalid reselect name');
      const expected = baseNameOf(item.sourceName ?? item.name);
      const given = baseNameOf(picked);
      if (given !== expected) throw new Error(`This entry expects “${expected}”; the picked file is “${given}”`);
      const givenPath = picked.replace(/\\/gu, '/');
      if (givenPath.includes('/') && item.sourceName && givenPath !== item.sourceName.replace(/\\/gu, '/')) {
        throw new Error(`This entry expects the path “${item.sourceName}”; the picked file is “${givenPath}”`);
      }
    }
    if (batchDeclaredBytes(batch) > this.budget.batchBytes) throw new Error('Import batch exceeds the 1 GiB disk budget');
    const file = this.stagedPath(batchId, item);
    rmSync(file, { force: true });
    this.library.updateImportBatch(batchId, (draft) => {
      const row = findBatchItem(draft, item.id);
      row.status = 'pending';
      row.attempts = 0;
      row.staged = batchStagingName(item.id);
      delete row.error;
      // The batch had settled into `completed` because this was its only entry.
      // Restoring an entry has to reopen it, or the queue would never restart.
      draft.status = 'running';
    });
    return { batchId, itemId: item.id, size: item.size, offset: 0, chunkBytes: BATCH_CHUNK };
  }

  /**
   * Extract an accepted archive with the existing hardened worker (no traversal,
   * absolute paths, symlinks, device names, case collisions, oversized entries
   * or bombs), then move every accepted entry into its item's staging file.
   *
   * Single-flight per batch: a repeated `zipFinish`, the recovery sweep and a
   * manual retry all join the same in-flight extraction instead of racing it.
   */
  async importZip(batchId: string, zipPath: string, signal?: AbortSignal): Promise<ZipExtractResult> {
    const flight = this.extracting.get(batchId);
    if (flight) return flight;
    const run = this.extractArchive(batchId, zipPath, signal);
    // Registered synchronously, before the first await, so a concurrent caller
    // that arrives between checks and extraction still observes the flight.
    this.extracting.set(batchId, run);
    try { return await run; }
    finally { this.extracting.delete(batchId); }
  }

  private async extractArchive(batchId: string, zipPath: string, signal?: AbortSignal): Promise<ZipExtractResult> {
    const batch = this.require(batchId);
    if (batch.source !== 'zip') throw new Error('This import batch does not accept a ZIP');
    const persisted = batch.zip;
    if (!persisted) throw new Error('This import batch has no archive');
    // State machine: only a verified archive is ever extracted, and an extracted
    // one never re-enters the flow. `ready` here also covers a retry after a
    // failed extraction (the archive on disk is still the verified bytes).
    if (persisted.state === 'extracted') return { ...emptyAddResult(), alreadyExtracted: true };
    if (persisted.state !== 'ready') throw new Error('The archive has not been verified yet; finish the upload first');
    const zipSize = statSync(zipPath).size;
    if (zipSize !== persisted.size) throw new Error('The stored archive does not match its declared size');
    // Budget is recomputed from what the batch directory ACTUALLY holds, not from
    // the zip size alone: a previous attempt that already moved some entries into
    // their `.src` slots (and kept the archive) must not get a second full tree
    // on top of them. `existing` is everything except the archive itself.
    const existing = Math.max(0, dirTreeBytes(this.batchDir(batchId)) - zipSize);
    const ceiling = Math.min(this.budget.batchBytes - existing, this.budget.workspaceBytes - zipSize - existing);
    if (ceiling < 1) {
      throw new Error(`The batch workspace cannot fit another extraction: ${ceiling} bytes of headroom left (already occupied: ${existing})`);
    }
    // Refuse before writing when the disk itself cannot hold the allowed ceiling:
    // failing halfway after filling the volume is exactly what must not happen.
    const free = this.diskFree(this.batchDir(batchId));
    if (free !== null && free < ceiling) {
      throw new Error(`Not enough disk space: ${free} bytes free, this extraction may need up to ${ceiling}`);
    }
    const dir = this.batchDir(batchId);
    const target = join(dir, randomUUID() + '.extract');
    mkdirSync(dir, { recursive: true });
    try {
      // The worker enforces the same ceilings as a manual batch, so an archive
      // cannot expand past the disk budget before being refused.
      const outcome = await extractRuntimeZip(zipPath, target, signal, undefined, {
        maxEntries: BATCH_ITEM_LIMIT * 4, maxTotalBytes: ceiling, maxEntryBytes: this.budget.fileBytes });
      // Measured, not assumed, and recursive: this is the moment the archive and
      // the whole tree (nested directories included) are both on disk.
      const peak = dirTreeBytes(this.batchDir(batchId));
      if (peak > this.workspaceBytes) throw new Error('Archive would peak beyond the batch workspace budget');
      this.library.updateImportBatch(batchId, (draft) => {
        if (!draft.zip) return;
        draft.zip.peakBytes = Math.max(draft.zip.peakBytes ?? 0, peak);
      });
      // Hidden entries are tooling noise (__MACOSX, .DS_Store), never novels.
      const entries = outcome.files.filter((entry) => !entry.path.split('/').some((part) => part.startsWith('.')));
      const tooLarge = entries.filter((entry) => entry.size > this.budget.fileBytes);
      if (tooLarge.length) throw new Error(`${tooLarge.length} archive entries exceed the 100 MiB per-book limit`);
      // An empty entry list (empty archive, hidden-only, or directory-only) is
      // NOT an addItems request: it is a completed extraction with nothing in
      // it, reported as such instead of being refused as "select at least one".
      const result = entries.length
        ? this.addItems(batchId, entries.map((entry) => ({ name: entry.path, size: entry.size,
            title: detectImportMetadata(basename(entry.path)).title, sourceSha256: entry.sha256 })))
        : emptyAddResult();
      // Walk the batch's items, not the freshly added rows: a retry re-offers the
      // same names (all duplicates now), so keying off `result.added` would skip
      // exactly the entries a previous attempt never got to move.
      for (const item of this.require(batchId).items) {
        if (item.staged) continue;
        const from = join(target, ...item.name.split('/'));
        if (!existsSync(from) || !lstatSync(from).isFile() || statSync(from).size !== item.size) continue;
        const to = this.stagedPath(batchId, item);
        rmSync(to, { force: true });
        // Same directory tree, same filesystem: rename is a metadata operation and
        // stays inside the measured budget. A copy fallback is deliberately NOT
        // provided: it would double the entry on disk, outside every ceiling, with
        // a whole-file buffer in memory. A refused rename is a filesystem or
        // permission problem the user must see, not something to work around.
        try { renameSync(from, to); }
        catch (error) {
          throw new Error(`无法把解压出的文件移动到暂存位置（文件系统或权限问题）：${String((error as Error).message ?? error)}；已保留压缩包供重试`);
        }
        if (statSync(to).size !== item.size) throw new Error('Staged entry length does not match the archive entry');
        this.library.updateImportBatch(batchId, (draft) => {
          const row = findBatchItem(draft, item.id);
          row.staged = batchStagingName(item.id);
        });
      }
      // Success: the tree is gone, every accepted entry is a staging file, and
      // only then may the archive be deleted.
      rmSync(target, { recursive: true, force: true });
      const items = this.require(batchId).items;
      if (!items.length) {
        // Nothing importable came out: an empty archive, only hidden files, only
        // directories, or only unsupported formats. The extraction itself
        // succeeded, so the batch gets a terminal state — otherwise every restart
        // would re-extract it forever. No book was queued, so nothing joins the
        // plan; the record can simply be forgotten.
        rmSync(zipPath, { force: true });
        this.library.updateImportBatch(batchId, (draft) => {
          if (draft.zip) draft.zip.state = 'extracted';
          draft.status = 'completed';
        });
        return result;
      }
      if (items.every((item) => item.staged || item.status === 'completed' || !item.supported)) {
        rmSync(zipPath, { force: true });
        this.library.updateImportBatch(batchId, (draft) => { if (draft.zip) draft.zip.state = 'extracted'; });
      }
      return result;
    } catch (error) {
      // Failure: keep the archive (it is already verified) so the extraction can
      // be retried without asking the user for the file again, and keep the
      // already-moved `.src` slots — they are retry inputs, not garbage.
      rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }

  // ------------------------------------------------------------- zip upload

  private zipPath(batchId: string): string { return join(this.batchDir(batchId), 'source.zip'); }

  /**
   * Archive peak budget. The archive and the extracted tree coexist, and the
   * staged files are renames of the tree (no third copy), so the real worst case
   * is `zipBytes + batchBytes` — not 2.5 GiB as a naive copy-based flow allows.
   */
  get workspaceBytes(): number { return this.budget.workspaceBytes; }

  /** The archive itself is transferred contiguously, then extracted once. */
  zipBegin(batchId: string, input: unknown) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip') throw new Error('This import batch does not accept a ZIP');
    if (batch.status !== 'preview') throw new Error('Import batch already started');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid ZIP upload');
    const value = input as { name?: unknown; size?: unknown; sha256?: unknown };
    if (typeof value.name !== 'string' || !/\.zip$/iu.test(value.name) || value.name.length > 260) throw new Error('Only .zip archives are accepted');
    const size = value.size;
    if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > this.budget.zipBytes) throw new Error('ZIP must be 1 byte - 512 MiB');
    // A client digest is only ever an expectation to check the upload against.
    const claimed = value.sha256 === undefined ? undefined : digestOf(value.sha256);
    // A re-upload after a reselect must still be the same archive: the size and
    // (once any upload of it was accepted) the server-side digest are kept.
    const previous = batch.zip;
    if (previous && previous.size !== size) throw new Error(`This batch expects a ${previous.size} byte archive`);
    // Identity is sticky: a re-upload may neither drop nor swap the digest the
    // first selection recorded. Dropping it would admit any same-size archive;
    // swapping it would admit a different one on purpose.
    const priorClaim = previous?.claimedSha256;
    if (claimed !== undefined && priorClaim && claimed !== priorClaim) {
      throw new Error('This batch already pinned a different archive digest; start a new batch for a different ZIP');
    }
    const effectiveClaim = claimed ?? priorClaim;
    mkdirSync(this.batchDir(batchId), { recursive: true });
    const file = this.zipPath(batchId);
    closeSync(openSync(file, 'w'));
    this.library.updateImportBatch(batchId, (draft) => {
      draft.zip = {
        name: value.name as string, size: size as number, state: 'uploading',
        ...(previous?.sha256 ? { sha256: previous.sha256 } : {}),
        ...(effectiveClaim ? { claimedSha256: effectiveClaim } : {}),
      };
    });
    return { offset: 0, chunkBytes: BATCH_CHUNK, size };
  }

  zipChunk(batchId: string, offset: unknown, base64: unknown) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip' || batch.status !== 'preview') throw new Error('Import batch is not accepting a ZIP');
    const zip = batch.zip;
    if (!zip) throw new Error('ZIP upload was not started');
    if (zip.state !== 'uploading') throw new Error('ZIP upload is not accepting data');
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid ZIP chunk offset');
    if (typeof base64 !== 'string' || base64.length > Math.ceil(BATCH_CHUNK / 3) * 4) throw new Error('Invalid ZIP chunk');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > BATCH_CHUNK || bytes.toString('base64') !== base64) throw new Error('Invalid ZIP chunk');
    // The declared size is the ceiling, not the global maximum: a 1 MB archive
    // may not accept a 2 MB body just because 512 MiB is allowed overall.
    if ((offset as number) + bytes.length > zip.size) throw new Error(`ZIP upload exceeds the declared ${zip.size} bytes`);
    const file = this.zipPath(batchId);
    if (!existsSync(file)) throw new Error('ZIP upload was not started');
    // Same integrity rule as a novel: append-only, an identical replay is a
    // no-op, and anything else is a lie about what has already been uploaded.
    const written = statSync(file).size;
    if ((offset as number) > written) throw new Error('ZIP upload skipped bytes; upload the missing part first');
    if ((offset as number) < written) {
      if ((offset as number) + bytes.length > written) throw new Error('ZIP upload overlaps the staged data inconsistently');
      const existing = readRange(file, offset as number, bytes.length);
      if (existing.length !== bytes.length || !existing.equals(bytes)) throw new Error('ZIP upload replay does not match the staged data');
      return { offset: (offset as number) + bytes.length, replayed: true };
    }
    let fd: number;
    try { fd = openSync(file, 'r+'); } catch { throw new Error('Cannot open the ZIP staging file'); }
    try { let at = 0; while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, (offset as number) + at); }
    finally { closeSync(fd); }
    return { offset: (offset as number) + bytes.length };
  }

  /**
   * Finish the archive upload.
   *
   * Length and content are both checked *before* anything is extracted: a
   * truncated body, a body longer than declared, or a different archive with the
   * same length is refused and the entry goes back to `needs_reselect`.
   *
   * State machine: an `uploading` archive is verified and promoted to `ready`
   * here; a `ready` archive (a retry after a failed extraction, or a concurrent
   * duplicate call) goes straight to the single-flight extraction; an `extracted`
   * archive answers `alreadyExtracted` instead of starting a second run.
   */
  async zipFinish(batchId: string, signal?: AbortSignal): Promise<ZipExtractResult> {
    const batch = this.require(batchId);
    const zip = batch.zip;
    if (!zip) throw new Error('ZIP upload was not started');
    if (batch.status !== 'preview') throw new Error('Import batch already started');
    if (zip.state === 'extracted') return { ...emptyAddResult(), alreadyExtracted: true };
    if (zip.state === 'needs_reselect') throw new Error('The archive must be picked again before this batch can continue');
    const file = this.zipPath(batchId);
    if (!existsSync(file)) throw new Error('ZIP upload was not started');
    if (zip.state === 'uploading') {
      const actual = statSync(file).size;
      if (actual !== zip.size) throw new Error(`ZIP is incomplete: declared ${zip.size} bytes, received ${actual}`);
      const digest = sha256File(file);
      const refuse = (message: string): never => {
        rmSync(file, { force: true });
        this.library.updateImportBatch(batchId, (draft) => { if (draft.zip) draft.zip.state = 'needs_reselect'; });
        throw new Error(message);
      };
      // A wrong claim is never deleted. The claim is the identity constraint the
      // replacement must satisfy; clearing it on mismatch would let any
      // same-size archive into this batch under the next attempt.
      if (zip.claimedSha256 && zip.claimedSha256 !== digest) {
        return refuse('The uploaded archive does not match the selected file (content digest differs); re-pick the original archive or start a new batch');
      }
      // `sha256` is set once an archive has been accepted before; a recovery must
      // present the very same archive, not merely one of the same length.
      if (zip.sha256 && zip.sha256 !== digest) {
        return refuse('The uploaded archive has the same length but different content');
      }
      this.library.updateImportBatch(batchId, (draft) => { if (draft.zip) { draft.zip.sha256 = digest; draft.zip.state = 'ready'; } });
    }
    return await this.importZip(batchId, file, signal);
  }

  /**
   * Re-open an interrupted archive upload under the same batch id.
   *
   * The declared size and the content digest are kept, so the replacement
   * archive must be the same file. Refusing to guess is the point: a different
   * archive under the same batch would import different books under the
   * previous batch's history.
   *
   * Conservative identity: without either a server-verified digest (`sha256`,
   * set when an upload completed once) or the digest the first selection
   * claimed (`claimedSha256`, kept from the very first begin), a replacement
   * cannot be proven to be the same archive. That batch must be re-imported in
   * a new batch; this record stays as an unfinished entry the user can forget.
   */
  zipReselect(batchId: string) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip') throw new Error('This import batch does not accept a ZIP');
    if (batch.status !== 'preview') throw new Error('Import batch already started');
    const zip = batch.zip;
    if (!zip) throw new Error('This batch has no archive to re-upload; choose a new ZIP instead');
    if (zip.state === 'extracted') throw new Error('This archive has already been extracted');
    // Only an interrupted upload needs a re-pick: a `ready` archive is verified
    // and will be (re)extracted on its own, and `uploading` is still live.
    if (zip.state !== 'needs_reselect') throw new Error('This archive does not need to be picked again');
    if (batch.items.length) throw new Error('This batch already has entries; start a new batch instead of replacing its archive');
    if (this.extracting.has(batchId)) throw new Error('This archive is being extracted right now');
    if (!zip.sha256 && !zip.claimedSha256) {
      throw new Error('此批次的中断上传没有可验证的内容指纹，无法证明重新选择的仍是同一个压缩包。请新建一个批次重新导入；本条记录保留为未完成状态，可随时清理。');
    }
    // Start from an empty file again so the chunk offsets stay contiguous.
    const file = this.zipPath(batchId);
    rmSync(file, { force: true });
    closeSync(openSync(file, 'w'));
    this.library.updateImportBatch(batchId, (draft) => { if (draft.zip) draft.zip.state = 'uploading'; });
    return { batchId, name: zip.name, size: zip.size, sha256: zip.sha256 ?? zip.claimedSha256 ?? null, chunkBytes: BATCH_CHUNK };
  }

  // -------------------------------------------------------------------- run

  start(batchId: string) {    this.library.updateImportBatch(batchId, (draft) => { beginBatch(draft, this.now()); });
    this.pump();
    return batchSummary(this.require(batchId));
  }

  cancel(batchId: string, reason?: string) {
    const running = this.library.updateImportBatch(batchId, (draft) => cancelBatch(draft, this.now(), reason));
    void running;
    for (const active of this.live.values()) {
      if (active.batchId === batchId && active.job.status.state === 'processing') void active.job.cancel();
    }
    return batchSummary(this.require(batchId));
  }

  cancelOne(batchId: string, itemId: string) {
    this.library.updateImportBatch(batchId, (draft) => { cancelItem(draft, itemId, this.now()); });
    const active = this.live.get(itemId);
    if (active?.batchId === batchId && active.job.status.state === 'processing') void active.job.cancel();
    return batchSummary(this.require(batchId));
  }

  retry(batchId: string, itemId: string) {
    this.library.updateImportBatch(batchId, (draft) => { retryItem(draft, itemId, this.now()); });
    this.pump();
    return batchSummary(this.require(batchId));
  }

  /** Called once at mount: recover interrupted work, then continue it. */
  resume(): { resumed: number; reselect: number; archives: number } {
    this.disposed = false;
    let resumed = 0;
    let reselect = 0;
    let archives = 0;
    for (const batch of this.library.importBatches()) {
      // A half-uploaded archive cannot be resumed byte-wise across a process:
      // its partial file is dropped and the batch exposes an explicit re-pick
      // entry instead of pretending the upload is still running.
      if (batch.zip?.state === 'uploading') {
        rmSync(this.zipPath(batch.id), { force: true });
        this.library.updateImportBatch(batch.id, (draft) => { if (draft.zip) draft.zip.state = 'needs_reselect'; });
        archives += 1;
      }
      if (batch.status !== 'running') continue;
      const report = this.library.updateImportBatch(batch.id, (draft) => reconcileBatch(draft,
        (item) => { try { return statSync(this.stagedPath(batch.id, item)).size; } catch { return null; } }, this.now()));
      resumed += report.resumed.length;
      reselect += report.reselect.length;
    }
    // An archive that arrived intact but never got extracted can simply be
    // retried: the bytes are still on disk and already verified. Recovery is
    // serialized — one archive extracted at a time — so several interrupted
    // batches cannot stack their extraction peaks on restart.
    let chain: Promise<unknown> = Promise.resolve();
    for (const batch of this.library.importBatches()) {
      if (batch.zip?.state !== 'ready') continue;
      if (!existsSync(this.zipPath(batch.id))) continue;
      const id = batch.id, path = this.zipPath(batch.id);
      chain = chain.then(() => this.importZip(id, path)).then(
        () => undefined,
        () => { this.library.updateImportBatch(id, (draft) => { if (draft.zip) draft.zip.state = 'needs_reselect'; }); },
      );
      archives += 1;
    }
    void chain;
    this.pump();
    return { resumed, reselect, archives };
  }

  /** Books a finished batch can hand to the plan; importing never plans on its own. */
  applyToPlan(batchId: string, groups?: unknown) {
    const batch = this.require(batchId);
    const keys = completedBookKeys(batch);
    if (!keys.length) return { added: false, bookKeys: [] as string[], addedToPlan: 0, groups: [] as { name: string; bookKeys: string[] }[] };
    const result = this.library.addToPlan(keys, { source: 'user' });
    const applied: { name: string; bookKeys: string[] }[] = [];
    if (Array.isArray(groups)) {
      for (const raw of groups) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const value = raw as { name?: unknown; bookKeys?: unknown };
        if (typeof value.name !== 'string' || !value.name.trim() || !Array.isArray(value.bookKeys)) continue;
        const name = value.name.trim();
        const members = value.bookKeys.filter((key): key is string => typeof key === 'string' && keys.includes(key));
        if (members.length < 2) continue;
        const view = this.library.planView();
        const itemIds = members.flatMap((key) => view.items.filter((row) => row.bookKey === key).map((row) => row.id));
        if (itemIds.length < 2) continue;
        const created = this.library.editPlanSeries({ action: 'create', name, itemIds });
        const series = created.series.find((row) => row.count === itemIds.length && row.name === name);
        if (series) applied.push({ name: series.name, bookKeys: members });
      }
    }
    return { added: true, bookKeys: keys, addedToPlan: result.added.length, groups: applied };
  }

  private require(batchId: string): ImportBatch {
    const batch = this.library.importBatches().find((row) => row.id === batchId);
    if (!batch) throw new Error('Import batch not found');
    return batch;
  }

  private pump(): void {
    if (this.disposed) return;
    for (const batch of this.library.importBatches()) {
      if (batch.status !== 'running') continue;
      for (const item of dispatchable(batch, runningCount(batch))) {
        if (this.live.has(item.id)) continue;
        this.launch(batch.id, item.id);
      }
    }
  }

  private launch(batchId: string, itemId: string): void {
    const item = findBatchItem(this.require(batchId), itemId);
    const source = this.stagedPath(batchId, item);
    let size: number | null = null;
    try { size = statSync(source).size; } catch { size = null; }
    if (size === null || size !== item.size) {
      this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'needs_reselect',
        { error: '暂存的源文件已丢失或被截断；请重新选择这个文件' }, this.now()));
      this.pump();
      return;
    }
    if (item.size > MAX_BOOK_BYTES) {
      this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'failed', { error: '文件超过 100 MiB' }, this.now()));
      this.pump();
      return;
    }
    // Final gate before the parser: what is on disk must still hash to the bytes
    // the user picked. A file swapped between upload and parse never reaches
    // ImportJob, no matter how it got there.
    if (item.sourceSha256) {
      let actual = '';
      try { actual = sha256File(source); } catch { actual = ''; }
      if (actual !== item.sourceSha256) {
        this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'needs_reselect',
          { error: '暂存文件的内容与最初选择的文件不一致；请重新选择原始文件。' }, this.now()));
        this.pump();
        return;
      }
    }
    this.library.updateImportBatch(batchId, (draft) => {
      const row = findBatchItem(draft, itemId);
      row.attempts += 1;
      setItemStatus(draft, itemId, 'processing', {}, this.now());
    });
    let job: ImportJob;
    try {
      job = new ImportJob(this.batchDir(batchId), itemId, source,
        { filename: basename(item.name), title: item.title, ...(item.author ? { author: item.author } : {}) },
        (file, hash, receipt) => {
          this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'validating', {}, this.now()));
          return this.library.adoptValidatedImport(file, hash, receipt);
        },
        () => { /* the staged `.src` is reclaimed in settle() */ });
    } catch (error) {
      this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'failed', { error: String((error as Error).message ?? error) }, this.now()));
      this.pump();
      return;
    }
    const active: Active = { batchId, job, reported: false };
    this.live.set(itemId, active);
    active.timer = setInterval(() => this.watch(batchId, itemId, active), TICK_MS);
    active.timer.unref?.();
    void job.ended.then(() => {
      if (active.timer) clearInterval(active.timer);
      this.live.delete(itemId);
      this.settle(batchId, itemId, active);
    });
  }

  /** Surface the commit stage while the worker is still finishing. */
  private watch(batchId: string, itemId: string, active: Active): void {
    if (active.reported) return;
    if (active.job.status.state !== 'committing') return;
    active.reported = true;
    if (active.timer) clearInterval(active.timer);
    const item = this.require(batchId).items.find((row) => row.id === itemId);
    // A tick that lands after settlement must not reopen a finished item.
    if (!item || !['importing', 'processing'].includes(item.status)) return;
    try { this.library.updateImportBatch(batchId, (draft) => setItemStatus(draft, itemId, 'validating', {}, this.now())); }
    catch { /* the settle path owns the final state */ }
  }

  private settle(batchId: string, itemId: string, active: Active): void {
    const status = active.job.status;
    const result = status.result as { duplicate?: boolean; book?: { key?: string } } | undefined;
    const batch = this.require(batchId);
    const item = batch.items.find((row) => row.id === itemId);
    // Only a committed import may reclaim the staged bytes: a failed or cancelled
    // item must stay retryable without asking the user to pick the file again.
    if (status.state === 'done' && item?.staged) { try { unlinkSync(this.stagedPath(batchId, item)); } catch { /* already gone */ } }
    this.library.updateImportBatch(batchId, (draft) => {
      const now = this.now();
      if (status.state === 'done') {
        const bookKey = result?.book?.key;
        if (!bookKey) { setItemStatus(draft, itemId, 'failed', { error: '导入完成但未返回书目' }, now); return; }
        setItemStatus(draft, itemId, 'completed', { bookKey, ...(result?.duplicate ? { duplicate: 'identical' as const, duplicateOf: bookKey } : {}) }, now);
        return;
      }
      if (status.state === 'cancelled') { setItemStatus(draft, itemId, 'cancelled', { error: '用户取消' }, now); return; }
      const message = (status.error ?? '导入失败').slice(0, 500);
      // A staging read failure cannot be retried with the same bytes.
      const lostBytes = /ENOENT|no such file|暂存|staging/iu.test(message);
      setItemStatus(draft, itemId, lostBytes ? 'needs_reselect' : 'failed', { error: message }, now);
    });
    this.pump();
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    const jobs = [...this.live.values()];
    for (const active of jobs) if (active.timer) clearInterval(active.timer);
    await Promise.all(jobs.map((active) => active.job.cancel().catch(() => undefined)));
    this.live.clear();
  }
}

interface RawInput { name: string; size: number; title?: string; author?: string; sourceSha256?: string; sourceName?: string }

function normalizeInputs(raw: unknown): RawInput[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Select at least one file');
  // One request may carry a few more than a batch holds so the caller gets a real
  // overflow count instead of an all-or-nothing error. The batch itself is still
  // capped at BATCH_ITEM_LIMIT by addBatchItems().
  if (raw.length > BATCH_ITEM_LIMIT * 4) throw new Error('Too many files in one request');
  const out: RawInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid import file');
    const value = entry as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name : '';
    const size = value.size;
    if (!name || !Number.isSafeInteger(size) || (size as number) < 1) throw new Error('Invalid import file');
    if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200)) throw new Error('Invalid import title');
    if (value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 100)) throw new Error('Invalid import author');
    const digest = value.sourceSha256 === undefined ? undefined : digestOf(value.sourceSha256);
    if (value.sourceName !== undefined && (typeof value.sourceName !== 'string' || !value.sourceName)) throw new Error('Invalid import source name');
    out.push({ name, size: size as number,
      ...(value.title === undefined ? {} : { title: (value.title as string).trim() }),
      ...(value.author === undefined ? {} : { author: (value.author as string).trim() }),
      ...(digest === undefined ? {} : { sourceSha256: digest }),
      ...(value.sourceName === undefined ? {} : { sourceName: value.sourceName as string }) });
  }
  return out;
}
