import { describe, expect, it } from 'vitest';
import {
  PLAN_ARCHIVE_LIMIT, addPlanItems, archiveItem, createSeries, dropUnusedSeries, emptyPlan,
  migrateLegacyQueue, setItemSeries, validatePlan,
} from '../src/reading-plan.ts';

const NOW = Date.parse('2026-10-15T08:00:00Z');

function planWith(keys: string[]) {
  const plan = emptyPlan(NOW);
  addPlanItems(plan, keys.map((bookKey) => ({ bookKey, title: bookKey.toUpperCase(), source: 'user' as const })), NOW);
  return plan;
}

describe('lifetime counters survive the bounded archive', () => {
  it('counts every archived book even when the window is full', () => {
    const plan = emptyPlan(NOW);
    const total = PLAN_ARCHIVE_LIMIT + 50;
    for (let index = 0; index < total; index++) {
      addPlanItems(plan, [{ bookKey: `k${index}`, title: `T${index}`, source: 'user' }], NOW + index);
      const item = plan.items[plan.items.length - 1];
      archiveItem(plan, item.id, 'completed', NOW + index);
    }
    expect(plan.archive).toHaveLength(PLAN_ARCHIVE_LIMIT);
    expect(plan.stats.completed).toBe(total);
    expect(plan.stats.truncated).toBe(total - PLAN_ARCHIVE_LIMIT);
    expect(plan.stats.lastArchivedAt).toBe(NOW + total - 1);
    // The audit trail is explicit: the window dropped exactly this many rows.
    expect(plan.stats.completed - plan.archive.length).toBe(plan.stats.truncated);
  });

  it('keeps skipped and removed apart from finished', () => {
    const plan = planWith(['a', 'b', 'c']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    archiveItem(plan, plan.items[0].id, 'skipped', NOW + 2);
    archiveItem(plan, plan.items[0].id, 'removed', NOW + 3);
    expect(plan.stats).toMatchObject({ completed: 1, skipped: 1, removed: 1, truncated: 0 });
    expect(plan.archive.map((entry) => entry.status)).toEqual(['completed', 'skipped', 'removed']);
  });

  it('rejects counters that are smaller than the archive they claim to describe', () => {
    const plan = planWith(['a']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    expect(() => validatePlan({ ...plan, stats: { completed: 0, skipped: 0, removed: 0, truncated: 0 } }, NOW))
      .toThrow('stats are smaller than its own archive');
    expect(() => validatePlan({ ...plan, stats: { completed: -1, skipped: 0, removed: 0, truncated: 0 } }, NOW))
      .toThrow('Invalid reading plan stats');
  });

  it('backfills counters for a plan written before they existed', () => {
    const plan = planWith(['a', 'b']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    archiveItem(plan, plan.items[0].id, 'skipped', NOW + 2);
    const legacy = { ...plan, stats: undefined } as unknown;
    const restored = validatePlan(legacy, NOW);
    expect(restored.stats).toMatchObject({ completed: 1, skipped: 1, removed: 0, truncated: 0 });
  });

  it('counts migrated legacy rows instead of dropping them from the totals', () => {
    const books = new Map([['a', { title: 'A' }], ['b', { title: 'B' }], ['c', { title: 'C' }]]);
    const row = (bookKey: string, status: string, addedAt: number) => ({
      id: `row-${bookKey}`, intentId: `intent-${bookKey}`, bookKey, title: bookKey.toUpperCase(),
      source: 'user' as const, status, addedAt, updatedAt: addedAt + 1,
    });
    const report = migrateLegacyQueue([row('a', 'done', NOW), row('b', 'cancelled', NOW + 1), row('c', 'queued', NOW + 2)], books, NOW + 3);
    expect(report.plan.stats).toMatchObject({ completed: 1, removed: 1, skipped: 0 });
    expect(report.plan.items.map((item) => item.bookKey)).toEqual(['c']);
  });
});

describe('history never points at a series that no longer exists', () => {
  it('keeps the series name and clears the dangling id when the group is dropped', () => {
    const plan = planWith(['a', 'b']);
    const series = createSeries(plan, '三部曲', 'manual', true, NOW + 1);
    setItemSeries(plan, plan.items[0].id, series.id, NOW + 2);
    setItemSeries(plan, plan.items[1].id, series.id, NOW + 3);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 4);
    expect(plan.archive[0]).toMatchObject({ seriesId: series.id, seriesName: '三部曲' });
    // The last member leaves the plan, so the group has no waiting entries left.
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 5);
    expect(plan.series).toEqual([]);
    expect(plan.archive.every((entry) => entry.seriesId === null)).toBe(true);
    expect(plan.archive.map((entry) => entry.seriesName)).toEqual(['三部曲', '三部曲']);
  });

  it('keeps a group that still has a waiting member', () => {
    const plan = planWith(['a', 'b', 'c']);
    const series = createSeries(plan, '三部曲', 'manual', true, NOW + 1);
    setItemSeries(plan, plan.items[0].id, series.id, NOW + 2);
    setItemSeries(plan, plan.items[1].id, series.id, NOW + 3);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 4);
    dropUnusedSeries(plan);
    expect(plan.series.map((group) => group.name)).toEqual(['三部曲']);
    expect(plan.archive[0].seriesId).toBe(series.id);
  });
});
