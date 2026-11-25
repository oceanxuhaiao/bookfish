import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
const now = () => time;
const file = () => lib.file;
const sha = () => createHash('sha256').update(readFileSync(file())).digest('hex');
const snapshot = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
const historyFile = () => join(lib.dir, 'history.sqlite');

/** Real writer (layout 8). `failCommit` breaks the commit boundary on purpose. */
function open(options: { failCommit?: boolean } = {}) {
  lib = new Library({ dataDir: dir, now,
    ...(options.failCommit ? { beforeMetadataCommit: () => { throw new Error('disk full during upgrade'); } } : {}) });
  lib.open();
}

/**
 * The exact gate a v0.66.7 binary applies to a snapshot.
 *
 * v0.66.7 `src/library.ts`:
 *   if ((schema !== 1 && schema !== 2 && schema !== 3) || ...) throw new Error('Unsupported or invalid library state');
 * v0.66.7 `src/book-storage.ts` hydrate():
 *   schema: [4,5,6,7].includes(raw.schema) ? 3 : raw.schema
 *
 * A layout-8 snapshot therefore reaches that gate as 8 and is refused, instead
 * of being opened and then rewritten without `plan`. This mirrors those two
 * lines rather than running the old binary, which is why the audit package marks
 * the downgrade test as simulated.
 */
function legacyAccepts(fileSchema: number): boolean {
  const stateSchema = [4, 5, 6, 7].includes(fileSchema) ? 3 : fileSchema;
  return stateSchema === 1 || stateSchema === 2 || stateSchema === 3;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-schema-'));
  time = Date.parse('2026-10-07T02:00:00Z');
  open();
});
afterEach(() => { try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const seed = (titles: string[]) => titles.map((title) => lib.import({ filename: `${title}.txt`, title,
  base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(400)).toString('base64') }).book);

/** Rewrite the snapshot the way 0.66.7 wrote it: layout 6, no new fields. */
function downgradeSnapshotToLegacy(): void {
  const old = snapshot();
  old.schema = 6;
  delete old.plan;
  delete old.importBatches;
  writeFileSync(file(), JSON.stringify(old));
}

describe('layout 8 is refused by a build that cannot preserve it', () => {
  it('writes layout 8 and carries the new fields', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const raw = snapshot();
    expect(raw.schema).toBe(8);
    expect((raw.plan as { items: { bookKey: string }[] }).items.map((item) => item.bookKey)).toEqual([a.key, b.key]);
    expect(Array.isArray(raw.importBatches)).toBe(true);
  });

  it('is refused by the v0.66.7 gate instead of being silently rewritten', () => {
    // Every layout a v0.66.7 build understands still opens; the new one does not.
    for (const legacy of [5, 6, 7]) expect(legacyAccepts(legacy)).toBe(true);
    expect(legacyAccepts(8)).toBe(false);
  });

  it('still opens a v0.66.7 snapshot and upgrades it on the next write', () => {
    const [a] = seed(['甲']);
    lib.select(a.key);
    const read = lib.readNext(1);
    if (read.complete) throw new Error('expected text');
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
    const confirmed = lib.status().current!.confirmedChars;
    lib.close();

    downgradeSnapshotToLegacy();
    expect(legacyAccepts(6)).toBe(true);

    open();
    expect(lib.list()).toHaveLength(1);
    expect(lib.status().current!.confirmedChars).toBe(confirmed);
    expect(lib.planView().items).toEqual([]);
    expect(lib.importBatches()).toEqual([]);
    expect(snapshot().schema).toBe(8);
    expect((snapshot().plan as { items: unknown[] }).items).toEqual([]);
    // Planning after the upgrade is persisted in the new layout.
    lib.addToPlan([a.key], { source: 'user' });
    expect((snapshot().plan as { items: unknown[] }).items).toHaveLength(1);
  });

  it('keeps the plan and its order when the new build reads its own snapshot again', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[2].id, place: 'next' });
    const before = lib.planView();
    lib.close();
    open();
    const after = lib.planView();
    expect(after.items.map((item) => item.bookKey)).toEqual(before.items.map((item) => item.bookKey));
    expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    expect(after.revision).toBe(before.revision);
  });
});

describe('backup and restore keep the plan and the batches', () => {
  it('round-trips a JSON export', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[2].id, place: 'next' });
    const order = lib.planView().items.map((item) => item.bookKey);
    const exportText = lib.export();
    lib.close();
    rmSync(file(), { force: true });
    rmSync(historyFile(), { force: true });
    open();
    expect(lib.list()).toEqual([]);
    lib.restore(exportText);
    expect(lib.planView().items.map((item) => item.bookKey)).toEqual(order);
    expect(lib.list().map((book) => book.key).sort()).toEqual([a.key, b.key, c.key].sort());
  });

  it('round-trips an archive file', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const order = lib.planView().items.map((item) => item.bookKey);
    const archive = join(dir, 'backup.bfbak');
    const { size } = lib.writeArchive(archive);
    expect(size).toBeGreaterThan(0);
    lib.close();
    rmSync(file(), { force: true });
    rmSync(historyFile(), { force: true });
    open();
    lib.restoreArchive(archive);
    expect(lib.planView().items.map((item) => item.bookKey)).toEqual(order);
  });
});

describe('a failed migration never damages the original snapshot', () => {
  it('leaves the bytes untouched when the upgrade commit fails', () => {
    const [a] = seed(['甲']);
    lib.close();
    downgradeSnapshotToLegacy();
    const before = sha();

    expect(() => open({ failCommit: true })).toThrow('disk full during upgrade');
    expect(sha()).toBe(before);

    // With the write working again the very same file upgrades cleanly.
    open();
    expect(snapshot().schema).toBe(8);
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0].key).toBe(a.key);
  });
});
