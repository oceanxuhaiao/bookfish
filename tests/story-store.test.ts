import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { StoryStore, type StoryChange } from '../src/story/store.ts';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const dirs: string[] = [];
function tempStore(name = 'story.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-story-'));
  dirs.push(dir);
  return { dir, path: join(dir, name), store: new StoryStore(join(dir, name)) };
}
function change(summary = '人物A背叛了伙伴', segmentId = 0, extra: Partial<StoryChange> = {}): StoryChange {
  return { kind: 'event', summary, evidence: [{ segmentId, quote: '背叛' }], sourceKind: 'model_interpretation', ...extra };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('StoryStore persistence and capture', () => {
  it('creates schema, captures a batch and is idempotent', () => {
    const { store } = tempStore();
    store.open();
    expect(store.status()).toMatchObject({ schemaVersion: 1, records: 0, batches: 0 });
    const first = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('事件一', 0), change('事件二', 1)] });
    expect(first.duplicate).toBe(false);
    expect(first.records).toHaveLength(2);
    expect(store.list('book:1')).toHaveLength(2);
    const replay = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('事件一', 0), change('事件二', 1)] });
    expect(replay.duplicate).toBe(true);
    expect(replay.records.map(record => record.id)).toEqual(first.records.map(record => record.id));
    expect(store.status().records).toBe(2);
    store.close();
  });

  it('rejects a conflicting requestId without adding partial rows', () => {
    const { store } = tempStore();
    store.open();
    store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('原文', 0)] });
    expect(() => store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('改写', 0)] })).toThrow(/different content/);
    expect(store.list('book:1')).toHaveLength(1);
    store.close();
  });

  it('rejects unread evidence, too many changes and empty summaries before writing', () => {
    const { store } = tempStore();
    store.open();
    expect(() => store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 2, requestId: 'req-1', changes: [change('x', 2)] })).toThrow(/unread/);
    expect(() => store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 2, requestId: 'req-2', changes: Array.from({ length: 5 }, (_, index) => change(`x${index}`, 0)) })).toThrow(/at most 4/);
    expect(() => store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 2, requestId: 'req-3', changes: [change('', 0)] })).toThrow(/summary/);
    expect(store.status().records).toBe(0);
    store.close();
  });

  it('isolates serial contentVersion and requestId namespaces', () => {
    const { store } = tempStore();
    store.open();
    const v1 = store.capture({ bookKey: 'serial:1', bookRevision: 'edition-hash', contentVersion: 1, frontier: 5, requestId: 'same', changes: [change('v1', 0)] });
    const v2 = store.capture({ bookKey: 'serial:1', bookRevision: 'edition-hash', contentVersion: 2, frontier: 8, requestId: 'same', changes: [change('v2', 5)] });
    expect(v1.records[0].contentVersion).toBe(1);
    expect(v2.records[0].contentVersion).toBe(2);
    expect(store.list('serial:1', 1)).toHaveLength(1);
    expect(store.list('serial:1', 2)).toHaveLength(1);
    expect(store.list('serial:1')).toHaveLength(2);
    store.close();
  });

  it('persists records across close/open and supports deleteBook', () => {
    const { store, path } = tempStore();
    store.open();
    store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('事件', 0)] });
    store.close();
    const reopened = new StoryStore(path);
    reopened.open();
    expect(reopened.list('book:1')).toHaveLength(1);
    expect(reopened.deleteBook('book:1')).toEqual({ records: 1, batches: 1 });
    expect(reopened.list('book:1')).toHaveLength(0);
    reopened.close();
  });

  it('creates a read-only snapshot and restores it into another store', () => {
    const { store, dir } = tempStore();
    store.open();
    store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('快照', 0)] });
    const snapshot = join(dir, 'story-snapshot.sqlite');
    expect(store.snapshot(snapshot).size).toBeGreaterThan(0);
    const readonly = new StoryStore(snapshot, { readOnly: true });
    readonly.open();
    expect(readonly.list('book:1')).toHaveLength(1);
    expect(() => readonly.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'x', changes: [change('x', 0)] })).toThrow(/read-only/);
    readonly.close();

    const target = new StoryStore(join(dir, 'restored.sqlite'));
    target.open();
    target.restoreFrom(snapshot);
    expect(target.list('book:1')).toHaveLength(1);
    target.close();
    store.close();
  });

  it('detects a tampered row instead of returning it as trusted', () => {
    const { store, path } = tempStore();
    store.open();
    const result = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('原始', 0)] });
    const id = result.records[0].id;
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE story_record SET payload=? WHERE id=?").run(JSON.stringify(change('篡改', 0)), id);
    raw.close();
    const reopened = new StoryStore(path);
    reopened.open();
    expect(() => reopened.get(id)).toThrow(/checksum/);
    reopened.close();
  });

  it('does not create a snapshot target with invalid path', () => {
    const { store, dir } = tempStore();
    store.open();
    expect(existsSync(join(dir, 'missing', 'x.sqlite'))).toBe(false);
    expect(() => store.snapshot(join(dir, 'missing', 'x.sqlite'))).toThrow();
    store.close();
  });

  it('persists pending cleanup and retries it explicitly', () => {
    const { store } = tempStore();
    store.open();
    store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-1', changes: [change('待清理', 0)] });
    const pending = store.recordCleanup('book:1', 'injected cleanup failure');
    expect(pending.bookKey).toBe('book:1');
    expect(pending.attempts).toBe(1);
    expect(store.status().pendingCleanups).toBe(1);
    const retried = store.retryCleanups();
    expect(retried).toMatchObject({ cleaned: 1, failed: 0, pending: [] });
    expect(store.list('book:1')).toHaveLength(0);
    expect(store.status().pendingCleanups).toBe(0);
    store.close();
  });

  it('creates, versions and invalidates L2 story packs by input/output fingerprint', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'req-pack', changes: [change('事件一', 0), change('事件二', 1)] });
    const eventIds = captured.records.map(record => record.id);
    const base = { id: 'arc-1', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book' as const,
      summary: '第一版弧', eventIds, relationIds: [], coveredRanges: [{ from: 0, to: 2 }] };
    const first = store.putPack(base);
    store.publishPack('arc-1');
    expect(first.duplicate).toBe(false);
    expect(first.pack.generation).toBe(1);
    expect(first.pack.status).toBe('draft');
    expect(store.listPacks('book:1')).toHaveLength(1);
    const duplicate = store.putPack(base);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.pack.generation).toBe(1);
    const second = store.putPack({ ...base, summary: '第二版弧' });
    store.publishPack('arc-1');
    expect(second.duplicate).toBe(false);
    expect(second.pack.generation).toBe(2);
    expect(store.listPacks('book:1')).toHaveLength(1);
    expect(store.getPack('arc-1').summary).toBe('第二版弧');
    expect(store.invalidatePacks('book:1').invalidated).toBe(1);
    expect(store.listPacks('book:1')).toHaveLength(0);
    store.close();
  });

  it('isolates story packs by contentVersion', () => {
    const { store } = tempStore();
    store.open();
    const v1 = store.capture({ bookKey: 'serial:1', bookRevision: 'rev', contentVersion: 1, frontier: 5, requestId: 'p1', changes: [change('v1', 0)] });
    const v2 = store.capture({ bookKey: 'serial:1', bookRevision: 'rev', contentVersion: 2, frontier: 8, requestId: 'p2', changes: [change('v2', 0)] });
    store.putPack({ id: 'same', bookKey: 'serial:1', bookRevision: 'rev', contentVersion: 1, frontier: 5, level: 'book', summary: 'v1 pack', eventIds: [v1.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    store.putPack({ id: 'same', bookKey: 'serial:1', bookRevision: 'rev', contentVersion: 2, frontier: 8, level: 'book', summary: 'v2 pack', eventIds: [v2.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    store.publishPack('same', 1);
    store.publishPack('same', 2);
    expect(store.listPacks('serial:1', 1).map(pack => pack.summary)).toEqual(['v1 pack']);
    expect(store.listPacks('serial:1', 2).map(pack => pack.summary)).toEqual(['v2 pack']);
    store.close();
  });

  it('propagates invalidation from a changed parent to dependent packs', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'deps', changes: [change('事件', 0)] });
    const eventIds = [captured.records[0].id];
    store.putPack({ id: 'root', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '根', eventIds, childIds: ['arc'], coveredRanges: [{ from: 0, to: 1 }] });
    store.putPack({ id: 'arc', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'arc', parentId: 'root', summary: '弧', eventIds, childIds: ['scene'], coveredRanges: [{ from: 0, to: 1 }] });
    store.putPack({ id: 'scene', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'scene', parentId: 'arc', summary: '场景', eventIds, coveredRanges: [{ from: 0, to: 1 }] });
    store.publishPack('root');
    expect(store.listPacks('book:1').map(pack => pack.id).sort()).toEqual(['arc', 'root', 'scene']);
    expect(store.invalidatePacks('book:1').invalidated).toBe(3);
    expect(store.listPacks('book:1')).toHaveLength(0);
    expect(() => store.getPack('arc')).toThrow(/missing/);
    store.close();
  });

  it('migrates legacy active packs to legacy-unverified and republishes only after validation', () => {
    const { store, path } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'legacy', changes: [change('事件', 0)] });
    store.putPack({ id: 'legacy-root', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '旧根', eventIds: [captured.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    store.publishPack('legacy-root');
    store.close();

    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM story_meta WHERE key='packPublishPolicy'");
    raw.close();

    const reopened = new StoryStore(path);
    reopened.open();
    expect(reopened.listPacks('book:1')).toHaveLength(0);
    expect(reopened.publishPack('legacy-root').status).toBe('active');
    expect(reopened.listPacks('book:1')).toHaveLength(1);
    reopened.close();
  });

  it('rejects direct active pack writes', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'active-reject', changes: [change('事件', 0)] });
    expect(() => store.putPack({ id: 'direct', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '直写', eventIds: [captured.records[0].id], coveredRanges: [{ from: 0, to: 1 }], status: 'active' as any })).toThrow(/publishPack/);
    store.close();
  });

  it('binds stable entity ids and refuses unresolved or cross-version relations', () => {
    const { store } = tempStore();
    store.open();
    const first = store.createEntity({ bookKey: 'book:1', canonicalName: '林', aliases: ['小林'], firstRevealedAt: 1 });
    const second = store.createEntity({ bookKey: 'book:1', canonicalName: '林', aliases: ['林医生'], firstRevealedAt: 2 });
    const later = store.createEntity({ bookKey: 'book:1', canonicalName: '阿七', aliases: ['小七'], firstRevealedAt: 5 });
    const delayed = store.createEntity({ bookKey: 'book:1', canonicalName: '顾迟', firstRevealedAt: 20, aliases: ['迟', '救人者'], aliasReveals: { '迟': 20, '救人者': 380 } });
    expect(store.resolveEntity('book:1', '救人者', 300).status).toBe('none');
    const earlyGu = store.resolveEntity('book:1', '顾迟', 20).candidates[0];
    expect(earlyGu.aliases).not.toContain('救人者');
    expect(store.resolveEntity('book:1', '救人者', 380).candidates[0].entityId).toBe(delayed.entityId);
    expect(store.resolveEntity('book:1', '小七', 4).status).toBe('none');
    expect(store.resolveEntity('book:1', '小七', 5).candidates[0].entityId).toBe(later.entityId);
    expect(store.resolveEntity('book:1', '林', 2).status).toBe('ambiguous');
    expect(store.resolveEntity('book:1', '小林', 1).candidates[0].entityId).toBe(first.entityId);
    const before = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 3, requestId: 'entity-event', changes: [change('事件', 0)] });
    expect(() => store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 3, requestId: 'bad-relation', changes: [{ kind: 'relation', summary: '关系', relation: '朋友', fromEntityId: 'missing', toEntityId: second.entityId, evidence: [{ segmentId: 0 }] } as any] })).toThrow(/not bound/);
    const relation = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 3, requestId: 'good-relation', changes: [{ kind: 'relation', summary: '关系', relation: '朋友', fromEntityId: first.entityId, toEntityId: second.entityId, evidence: [{ segmentId: 0 }] } as any] });
    expect(relation.records[0].kind).toBe('relation');
    expect(before.records).toHaveLength(1);
    store.close();
  });

  it('keeps drafts out of active recall and publishes a complete validated tree', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'draft', changes: [change('事件', 0)] });
    const eventIds = [captured.records[0].id];
    store.putPack({ id: 'draft-root', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '草稿根', eventIds, childIds: ['draft-arc'], coveredRanges: [{ from: 0, to: 1 }], status: 'draft' });
    store.putPack({ id: 'draft-arc', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'arc', parentId: 'draft-root', summary: '草稿弧', eventIds, coveredRanges: [{ from: 0, to: 1 }], status: 'draft' });
    expect(store.listPacks('book:1')).toHaveLength(0);
    const published = store.publishPack('draft-root');
    expect(published.status).toBe('active');
    expect(store.listPacks('book:1').map(pack => pack.id).sort()).toEqual(['draft-arc', 'draft-root']);
    store.close();
  });

  it('rejects publication when the pack depends on a fact after its frontier and keeps old active', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 8, requestId: 'future', changes: [change('未来事件', 7)] });
    const eventIds = [captured.records[0].id];
    store.putPack({ id: 'future', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 2, level: 'book', summary: '越界', eventIds, coveredRanges: [{ from: 0, to: 2 }], status: 'draft' });
    expect(() => store.publishPack('future')).toThrow(/revealed|frontier/);
    expect(store.listPacks('book:1')).toHaveLength(0);
    store.close();
  });

  it('keeps the old active pack when a new draft fails publication', () => {
    const { store } = tempStore();
    store.open();
    const captured = store.capture({ bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, requestId: 'old-active', changes: [change('事件', 0)] });
    const eventIds = [captured.records[0].id];
    store.putPack({ id: 'root', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '旧根', eventIds, coveredRanges: [{ from: 0, to: 1 }] });
    store.publishPack('root');
    expect(store.listPacks('book:1')[0].summary).toBe('旧根');
    store.putPack({ id: 'root', bookKey: 'book:1', bookRevision: 'rev-1', contentVersion: null, frontier: 5, level: 'book', summary: '坏草稿', eventIds, childIds: ['missing'], coveredRanges: [{ from: 0, to: 1 }], status: 'draft' });
    expect(() => store.publishPack('root')).toThrow(/tree|missing/i);
    expect(store.listPacks('book:1').map(pack => pack.summary)).toEqual(['旧根']);
    store.close();
  });
});
