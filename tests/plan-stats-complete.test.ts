import { describe, expect, it } from 'vitest';
import { PLAN_ARCHIVE_LIMIT, addPlanItems, archiveItem, emptyPlan, migrateLegacyQueue, validatePlan } from '../src/reading-plan.ts';

const NOW = Date.parse('2026-10-15T08:00:00Z');

function planWith(keys: string[]) {
  const plan = emptyPlan(NOW);
  addPlanItems(plan, keys.map((bookKey) => ({ bookKey, title: bookKey.toUpperCase(), source: 'user' as const })), NOW);
  return plan;
}

describe('history completeness is explicit, never implied', () => {
  it('a plan created by this version counts a complete history', () => {
    const plan = planWith(['a', 'b']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    expect(plan.statsComplete).toBe(true);
    const round = validatePlan(plan, NOW + 2);
    expect(round.statsComplete).toBe(true);
  });

  it('a legacy plan without counters is marked incomplete, not silently complete', () => {
    const plan = planWith(['a', 'b']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    // A pre-v1.2 snapshot: counters did not exist yet.
    const legacy = { ...plan, stats: undefined, statsComplete: undefined } as unknown;
    const restored = validatePlan(legacy, NOW);
    expect(restored.stats.completed).toBe(1);
    // Backfilled from the surviving archive window: a LOWER BOUND.
    expect(restored.statsComplete).toBe(false);
  });

  it('a v1.2 plan (counters, no marker) is complete: it was counted from birth', () => {
    const plan = planWith(['a']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    // Strip only the marker, keep the counters: exactly what v1.2 wrote.
    const v12 = { ...plan, statsComplete: undefined } as unknown;
    const restored = validatePlan(v12, NOW);
    expect(restored.stats.completed).toBe(1);
    expect(restored.statsComplete).toBe(true);
  });

  it('an explicit false marker survives the round trip', () => {
    const plan = planWith(['a']);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    plan.statsComplete = false;
    const restored = validatePlan(plan, NOW);
    expect(restored.statsComplete).toBe(false);
  });

  it('a migrated legacy queue is never presented as complete history', () => {
    const books = new Map([['a', { title: 'A' }]]);
    const row = (bookKey: string, status: string, addedAt: number) => ({
      id: `row-${bookKey}`, intentId: `intent-${bookKey}`, bookKey, title: bookKey.toUpperCase(),
      source: 'user' as const, status, addedAt, updatedAt: addedAt + 1,
    });
    const empty = migrateLegacyQueue([], books, NOW);
    expect(empty.plan.statsComplete).toBe(false);
    const report = migrateLegacyQueue([row('a', 'done', NOW)], books, NOW + 1);
    expect(report.plan.stats.completed).toBe(1);
    expect(report.plan.statsComplete).toBe(false);
  });

  it('truncation in a complete plan still shows the audit trail, not a new marker', () => {
    const plan = emptyPlan(NOW);
    const total = PLAN_ARCHIVE_LIMIT + 10;
    for (let index = 0; index < total; index += 1) {
      addPlanItems(plan, [{ bookKey: `k${index}`, title: `T${index}`, source: 'user' }], NOW + index);
      archiveItem(plan, plan.items[plan.items.length - 1].id, 'completed', NOW + index);
    }
    // Trimming the window is honest bookkeeping, not lost history: counters stay
    // complete even though rows are gone.
    expect(plan.stats.truncated).toBe(10);
    expect(plan.statsComplete).toBe(true);
    const restored = validatePlan(plan, NOW + total);
    expect(restored.statsComplete).toBe(true);
    expect(restored.stats.completed).toBe(total);
    expect(restored.stats.truncated).toBe(10);
  });
});
