import { describe, expect, it } from 'vitest';
import {
  addPlanItems, archiveItem, createSeries, dropUnusedSeries, emptyPlan, findItem, markStarted,
  migrateLegacyQueue, movePlanItem, movePlanSeries, orderSuggestion, reconcilePlan, setItemNotBefore,
  setItemSeries, setPlanEnabled, suggestSeries, validatePlan, volumeOf, PLAN_ITEM_LIMIT,
} from '../src/reading-plan.ts';

const NOW = Date.parse('2026-10-01T08:00:00Z');

function planWith(keys: string[]) {
  const plan = emptyPlan(NOW);
  addPlanItems(plan, keys.map((bookKey) => ({ bookKey, title: bookKey.toUpperCase(), source: 'user' as const })), NOW);
  return plan;
}

describe('reading plan core is pure and order-only', () => {
  it('appends in the requested order and keeps the first occurrence', () => {
    const plan = planWith(['a', 'b', 'c']);
    expect(plan.items.map((item) => item.bookKey)).toEqual(['a', 'b', 'c']);
    const again = addPlanItems(plan, [{ bookKey: 'b', title: 'B', source: 'user' }, { bookKey: 'd', title: 'D', source: 'persona' }], NOW + 1);
    expect(again.added.map((item) => item.bookKey)).toEqual(['d']);
    expect(again.duplicates).toEqual(['b']);
    expect(plan.items.map((item) => item.bookKey)).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.items[3].source).toBe('persona');
  });

  it('re-adds a book that was archived as skipped but never resurrects a completed one', () => {
    const plan = planWith(['a', 'b']);
    const skipped = plan.items[1];
    archiveItem(plan, skipped.id, 'skipped', NOW + 2, 'not_now');
    const afterSkip = addPlanItems(plan, [{ bookKey: 'b', title: 'B', source: 'user' }], NOW + 3);
    expect(afterSkip.added.map((item) => item.bookKey)).toEqual(['b']);
    expect(afterSkip.archived).toEqual([]);

    const readded = plan.items.find((item) => item.bookKey === 'b')!;
    archiveItem(plan, readded.id, 'completed', NOW + 4);
    const afterComplete = addPlanItems(plan, [{ bookKey: 'b', title: 'B', source: 'user' }], NOW + 5);
    expect(afterComplete.added).toEqual([]);
    expect(afterComplete.archived).toEqual(['b']);
  });

  it('removing never deletes the shelf copy, and the archive keeps the reason', () => {
    const plan = planWith(['a', 'b']);
    archiveItem(plan, plan.items[0].id, 'removed', NOW + 2, 'user_dropped_it');
    expect(plan.items.map((item) => item.bookKey)).toEqual(['b']);
    expect(plan.archive[0]).toMatchObject({ bookKey: 'a', status: 'removed', reason: 'user_dropped_it' });
    // Skipped is explicitly not completion.
    archiveItem(plan, plan.items[0].id, 'skipped', NOW + 3);
    expect(plan.archive.filter((entry) => entry.status === 'completed')).toHaveLength(0);
  });

  it('moves one entry and a whole series without reordering anything else', () => {
    const plan = planWith(['a', 'b', 'c', 'd']);
    const series = createSeries(plan, '三部曲', 'manual', true, NOW + 2);
    setItemSeries(plan, plan.items[1].id, series.id, NOW + 3);
    setItemSeries(plan, plan.items[3].id, series.id, NOW + 4);
    expect(movePlanItem(plan, plan.items[3].id, 0, NOW + 5)).toBe(true);
    expect(plan.items.map((item) => item.bookKey)).toEqual(['d', 'a', 'b', 'c']);
    // The series members move as one contiguous block, keeping their order.
    expect(movePlanSeries(plan, series.id, 0, NOW + 6)).toBe(true);
    expect(plan.items.map((item) => item.bookKey)).toEqual(['d', 'b', 'a', 'c']);
    expect(plan.revision).toBeGreaterThan(0);
    dropUnusedSeries(plan);
    expect(plan.series).toHaveLength(1);
  });

  it('rejects a tampered plan instead of silently repairing it', () => {
    const plan = planWith(['a', 'b']);
    expect(() => validatePlan({ ...plan, items: [plan.items[0], { ...plan.items[0], id: plan.items[0].id }] }, NOW)).toThrow();
    expect(() => validatePlan({ ...plan, items: [{ ...plan.items[0], seriesId: 'missing' }] }, NOW)).toThrow();
    expect(() => validatePlan({ ...plan, schema: 99 }, NOW)).toThrow();
    expect(validatePlan(undefined, NOW).items).toEqual([]);
    expect(PLAN_ITEM_LIMIT).toBeGreaterThan(50);
  });

  it('limits the plan and reports overflow instead of dropping silently', () => {
    const plan = emptyPlan(NOW);
    const inputs = Array.from({ length: PLAN_ITEM_LIMIT + 3 }, (_, index) => ({ bookKey: 'k' + index, title: 'T' + index, source: 'user' as const }));
    const result = addPlanItems(plan, inputs, NOW);
    expect(plan.items).toHaveLength(PLAN_ITEM_LIMIT);
    expect(result.overflow).toBe(3);
  });

  it('moves shelf-missing entries to the archive instead of blocking the plan', () => {
    const plan = planWith(['a', 'b', 'c']);
    expect(reconcilePlan(plan, new Set(['a', 'c']), NOW + 10)).toBe(true);
    expect(plan.items.map((item) => item.bookKey)).toEqual(['a', 'c']);
    expect(plan.archive.find((entry) => entry.bookKey === 'b')?.status).toBe('removed');
    expect(reconcilePlan(plan, new Set(['a', 'c']), NOW + 11)).toBe(false);
  });

  it('marks a start and honours a deferral without touching order', () => {
    const plan = planWith(['a', 'b']);
    markStarted(plan, 'b', NOW + 1);
    expect(plan.items[1].startedAt).toBe(NOW + 1);
    expect(plan.items[0].startedAt).toBeUndefined();
    setItemNotBefore(plan, findItem(plan, 'b')!.id, NOW + 86_400_000, NOW + 2);
    expect(plan.items[1].notBefore).toBe(NOW + 86_400_000);
    expect(setPlanEnabled(plan, false, NOW + 3)).toBe(true);
    expect(plan.enabled).toBe(false);
    expect(setPlanEnabled(plan, false, NOW + 4)).toBe(false);
  });
});

describe('legacy queue migration keeps the old cross-book order', () => {
  const books = new Map([['a', { title: 'A' }], ['b', { title: 'B' }], ['c', { title: 'C' }]]);
  const row = (bookKey: string, status: string, addedAt: number, source: 'pet' | 'user' = 'user') => ({
    id: `row-${bookKey}-${status}`, intentId: `intent-${bookKey}`, bookKey, title: bookKey.toUpperCase(),
    source, status, addedAt, updatedAt: addedAt + 1,
  });

  it('maps queued rows to items and terminal rows to the archive', () => {
    const report = migrateLegacyQueue([
      row('b', 'queued', NOW + 20, 'pet'),
      row('a', 'active', NOW + 10),
      row('c', 'done', NOW + 5),
    ], books, NOW + 30);
    expect(report.migrated).toBe(3);
    expect(report.plan.items.map((item) => item.bookKey)).toEqual(['a', 'b']);
    expect(report.plan.items[1].source).toBe('persona');
    expect(report.plan.archive.map((entry) => [entry.bookKey, entry.status])).toEqual([['c', 'completed']]);
  });

  it('drops rows whose revision is gone and counts them', () => {
    const report = migrateLegacyQueue([row('gone', 'queued', NOW)], books, NOW + 1);
    expect(report.migrated).toBe(0);
    expect(report.dropped).toBe(1);
    expect(report.plan.items).toEqual([]);
  });

  it('keeps a cancelled row as removed, never as completed', () => {
    const report = migrateLegacyQueue([row('a', 'cancelled', NOW)], books, NOW + 1);
    expect(report.plan.items).toEqual([]);
    expect(report.plan.archive[0]).toMatchObject({ bookKey: 'a', status: 'removed', reason: 'legacy_cancelled' });
  });
});

describe('grouping proposals never merge a split novel behind the user back', () => {
  it('reads a declared volume number out of a title', () => {
    expect(volumeOf('斗罗大陆 第二部')).toMatchObject({ volume: 2 });
    expect(volumeOf('三体（上）')).toMatchObject({ volume: 1 });
    expect(volumeOf('三体（下）')).toMatchObject({ volume: 3 });
    expect(volumeOf('某某 卷三')).toMatchObject({ volume: 3 });
    expect(volumeOf('平凡的世界')).toBeNull();
  });

  it('proposes a folder group and orders it by volume', () => {
    const rows = [
      { bookKey: 'k2', title: '斗罗大陆 第二部', relativePath: '斗罗/2.txt' },
      { bookKey: 'k1', title: '斗罗大陆 第一部', relativePath: '斗罗/1.txt' },
    ];
    const [group] = suggestSeries(rows);
    expect(group.evidence).toBe('folder');
    expect(group.name).toBe('斗罗');
    expect(group.bookKeys).toHaveLength(2);
    expect(orderSuggestion([{ bookKey: 'k2', title: '斗罗大陆 第二部' }, { bookKey: 'k1', title: '斗罗大陆 第一部' }])).toEqual(['k1', 'k2']);
  });

  it('flags a title-split that could be one novel as ambiguous', () => {
    const rows = [
      { bookKey: 's1', title: '凡人修仙传（一）', relativePath: 'x/1.txt' },
      { bookKey: 's2', title: '凡人修仙传（二）', relativePath: 'x/2.txt' },
    ];
    expect(suggestSeries(rows).every((group) => group.ambiguous === false)).toBe(true);
    const split = [
      { bookKey: 'p1', title: '外传', relativePath: 'y/1.txt' },
      { bookKey: 'p2', title: '外传 番外', relativePath: 'y/2.txt' },
    ];
    expect(suggestSeries(split).some((group) => group.ambiguous)).toBe(true);
  });

  it('ignores a generic folder name', () => {
    const rows = [{ bookKey: 'a', title: 'A', relativePath: 'txt/a.txt' }, { bookKey: 'b', title: 'B', relativePath: 'txt/b.txt' }];
    expect(suggestSeries(rows)).toEqual([]);
  });
});
