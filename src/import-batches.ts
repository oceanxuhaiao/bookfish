/**
 * Runtime for batch import: staging, bounded concurrency, per-item retry and
 * restart recovery.
 *
 * Parsing is still the single-file `ImportJob` worker and the commit is still
 * `Library.adoptValidatedImport`, so body normalization, encoding repair, paged
 * storage and duplicate identity stay byte-identical to a one-file import.
 * Nothing here advances reading progress.
 */
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImportJob, cleanImportDirectory } from './import-job.ts';
import { detectImportMetadata } from './import-metadata.ts';
import { MAX_BOOK_BYTES } from './books.ts';
import { extractRuntimeZip } from './novel-runtime/archive.ts';
import {
  BATCH_ITEM_LIMIT, BATCH_STAGING_BYTES, BATCH_STAGING_EXT, MAX_BATCH_FILE_BYTES, batchDeclaredBytes,
  batchStagingName, batchSummary, beginBatch, cancelBatch,
  cancelItem, completedBookKeys, dispatchable, findBatchItem, markInBatchDuplicates, newBatch,
  previewBatch, reconcileBatch, retryItem, runningCount, setItemStatus, ZIP_MAX_BYTES,
  type BatchItem, type BatchSource, type ImportBatch,
} from './import-batch.ts';
import type { Library } from './library.ts';

/** Same chunk size the single-file transfer already uses. */
export const BATCH_CHUNK = 256 * 1024;
export { BATCH_STAGING_BYTES, MAX_BATCH_FILE_BYTES, ZIP_MAX_BYTES } from './import-batch.ts';
const TICK_MS = 250;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMPORT_DIR = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.import$/;

interface Active { batchId: string; job: ImportJob; timer?: ReturnType<typeof setInterval>; reported: boolean }

/**
 * Disk ceilings. Defaults are the shipping values; tests may inject smaller
 * numbers so boundary behaviour can be proven without staging a gigabyte.
 */
export interface BatchBudget { batchBytes: number; fileBytes: number; zipBytes: number }
export const DEFAULT_BATCH_BUDGET: BatchBudget = {
  batchBytes: BATCH_STAGING_BYTES, fileBytes: MAX_BATCH_FILE_BYTES, zipBytes: ZIP_MAX_BYTES,
};

export interface ImportBatchesOptions { now?: () => number; budget?: Partial<BatchBudget> }

export interface BatchItemView { id: string; name: string; title: string; author: string; size: number;
  status: string; attempts: number; bookKey?: string; error?: string; duplicate?: string }

export class ImportBatches {
  private readonly dir: string;
  private readonly live = new Map<string, Active>();
  private disposed = false;
  private readonly now: () => number;
  private readonly budget: BatchBudget;

  constructor(private readonly library: Library, root: string, options: ImportBatchesOptions = {}) {
    this.dir = join(root, 'batches');
    this.now = options.now ?? Date.now;
    this.budget = { ...DEFAULT_BATCH_BUDGET, ...(options.budget ?? {}) };
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
        // An upload cannot survive the process; the archive is always re-picked.
        else if (file === 'source.zip') rmSync(join(dir, file), { force: true });
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

  status(batchId: string): ReturnType<typeof batchSummary> & ReturnType<typeof previewBatch> {
    const batch = this.require(batchId);
    const preview = previewBatch(batch, this.library.list());
    return { ...batchSummary(batch), ...preview };
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
    })));
    if (tooLarge.length) result.tooLarge = [...tooLarge, ...(result.tooLarge ?? [])];
    if (overBudget.length) result.overBudget = [...overBudget, ...(result.overBudget ?? [])];
    this.library.updateImportBatch(batchId, (draft) => { markInBatchDuplicates(draft); });
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
      const existing = readFileSync(file).subarray(offset as number, (offset as number) + bytes.length);
      if (!existing.equals(bytes)) throw new Error('Import chunk replay does not match the staged data');
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
    // Importing may only start once the last byte is on disk. This is also what
    // lets a restored entry rejoin a batch that is already running.
    if ((offset as number) + bytes.length === item.size) this.pump();
    return { offset: (offset as number) + bytes.length, complete: (offset as number) + bytes.length === item.size };
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
    const size = (input as { size?: unknown }).size;
    if (!Number.isSafeInteger(size) || (size as number) < 1) throw new Error('Invalid reselect size');
    // The replacement must be the same book, so its length must match what the
    // batch recorded; anything else would silently import a different file.
    if ((size as number) !== item.size) throw new Error(`This entry expects a ${item.size} byte file; the picked file is ${size} bytes`);
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
   * A ZIP is extracted by the existing hardened worker: no traversal, absolute
   * paths, symlinks, device names, case collisions, oversized entries or bombs.
   */
  async importZip(batchId: string, zipPath: string, signal?: AbortSignal) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip') throw new Error('This import batch does not accept a ZIP');
    const target = join(this.batchDir(batchId), randomUUID() + '.extract');
    mkdirSync(this.batchDir(batchId), { recursive: true });
    try {
      // The worker enforces the same ceilings as a manual batch, so an archive
      // cannot expand past the disk budget before being refused.
      const outcome = await extractRuntimeZip(zipPath, target, signal, undefined, {
        maxEntries: BATCH_ITEM_LIMIT * 4, maxTotalBytes: this.budget.batchBytes, maxEntryBytes: this.budget.fileBytes });
      if (outcome.bytes > this.budget.batchBytes) throw new Error('Archive expands beyond the 1 GiB batch budget');
      // Hidden entries are tooling noise (__MACOSX, .DS_Store), never novels.
      const entries = outcome.files.filter((entry) => !entry.path.split('/').some((part) => part.startsWith('.')));
      const tooLarge = entries.filter((entry) => entry.size > this.budget.fileBytes);
      if (tooLarge.length) throw new Error(`${tooLarge.length} archive entries exceed the 100 MiB per-book limit`);
      const result = this.addItems(batchId, entries.map((entry) => ({ name: entry.path, size: entry.size,
        title: detectImportMetadata(basename(entry.path)).title })));
      const added = new Set(result.added.map((item) => item.name));
      for (const item of this.require(batchId).items) {
        if (item.staged || !added.has(item.name)) continue;
        const from = join(target, ...item.name.split('/'));
        if (!existsSync(from) || !lstatSync(from).isFile() || statSync(from).size !== item.size) continue;
        copyFileSync(from, this.stagedPath(batchId, item));
        this.library.updateImportBatch(batchId, (draft) => { findBatchItem(draft, item.id).staged = batchStagingName(item.id); });
      }
      return result;
    } finally { rmSync(target, { recursive: true, force: true }); }
  }

  // ------------------------------------------------------------- zip upload

  private zipPath(batchId: string): string { return join(this.batchDir(batchId), 'source.zip'); }

  /** The archive itself is transferred contiguously, then extracted once. */
  zipBegin(batchId: string, input: unknown) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip') throw new Error('This import batch does not accept a ZIP');
    if (batch.status !== 'preview') throw new Error('Import batch already started');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid ZIP upload');
    const value = input as { name?: unknown; size?: unknown };
    if (typeof value.name !== 'string' || !/\.zip$/iu.test(value.name)) throw new Error('Only .zip archives are accepted');
    const size = value.size;
    if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > this.budget.zipBytes) throw new Error('ZIP must be 1 byte - 512 MiB');
    mkdirSync(this.batchDir(batchId), { recursive: true });
    const file = this.zipPath(batchId);
    closeSync(openSync(file, 'w'));
    return { offset: 0, chunkBytes: BATCH_CHUNK, size };
  }

  zipChunk(batchId: string, offset: unknown, base64: unknown) {
    const batch = this.require(batchId);
    if (batch.source !== 'zip' || batch.status !== 'preview') throw new Error('Import batch is not accepting a ZIP');
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid ZIP chunk offset');
    if (typeof base64 !== 'string' || base64.length > Math.ceil(BATCH_CHUNK / 3) * 4) throw new Error('Invalid ZIP chunk');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > BATCH_CHUNK || bytes.toString('base64') !== base64) throw new Error('Invalid ZIP chunk');
    const file = this.zipPath(batchId);
    if (!existsSync(file)) throw new Error('ZIP upload was not started');
    if ((offset as number) + bytes.length > this.budget.zipBytes) throw new Error('ZIP exceeds the 512 MiB limit');
    // Same integrity rule as a novel: append-only, an identical replay is a
    // no-op, and anything else is a lie about what has already been uploaded.
    const written = statSync(file).size;
    if ((offset as number) > written) throw new Error('ZIP upload skipped bytes; upload the missing part first');
    if ((offset as number) < written) {
      if ((offset as number) + bytes.length > written) throw new Error('ZIP upload overlaps the staged data inconsistently');
      const existing = readFileSync(file).subarray(offset as number, (offset as number) + bytes.length);
      if (!existing.equals(bytes)) throw new Error('ZIP upload replay does not match the staged data');
      return { offset: (offset as number) + bytes.length, replayed: true };
    }
    let fd: number;
    try { fd = openSync(file, 'r+'); } catch { throw new Error('Cannot open the ZIP staging file'); }
    try { let at = 0; while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, (offset as number) + at); }
    finally { closeSync(fd); }
    return { offset: (offset as number) + bytes.length };
  }

  async zipFinish(batchId: string, signal?: AbortSignal) {
    const file = this.zipPath(batchId);
    if (!existsSync(file)) throw new Error('ZIP upload was not started');
    try { return await this.importZip(batchId, file, signal); }
    finally { rmSync(file, { force: true }); }
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
  resume(): { resumed: number; reselect: number } {
    this.disposed = false;
    let resumed = 0;
    let reselect = 0;
    for (const batch of this.library.importBatches()) {
      if (batch.status !== 'running') continue;
      const report = this.library.updateImportBatch(batch.id, (draft) => reconcileBatch(draft,
        (item) => { try { return statSync(this.stagedPath(batch.id, item)).size; } catch { return null; } }, this.now()));
      resumed += report.resumed.length;
      reselect += report.reselect.length;
    }
    this.pump();
    return { resumed, reselect };
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

interface RawInput { name: string; size: number; title?: string; author?: string }

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
    out.push({ name, size: size as number,
      ...(value.title === undefined ? {} : { title: (value.title as string).trim() }),
      ...(value.author === undefined ? {} : { author: (value.author as string).trim() }) });
  }
  return out;
}
