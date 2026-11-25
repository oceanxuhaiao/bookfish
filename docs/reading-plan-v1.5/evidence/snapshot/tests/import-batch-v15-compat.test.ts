import { describe, expect, it } from 'vitest';
import { BATCH_ITEM_LIMIT, BATCH_SCHEMA, batchReport, validateBatches, type ImportBatch } from '../src/import-batch.ts';
import { emptyPlan, validatePlan, addPlanItems, archiveItem } from '../src/reading-plan.ts';

/**
 * v1.5 adds fields; it must not reinterpret what earlier versions wrote.
 *
 * Every snapshot below is exactly what an earlier release could have persisted:
 * v1.3 batches (no `rejected`, no `failure`), v1.4 batches (rejected, failure),
 * and v1.1/v1.2 reading plans. Loading them may add defaults, never remove or
 * rescale what is already true.
 */
const NOW = Date.parse('2026-11-25T10:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

function base(): ImportBatch {
  return {
    schema: BATCH_SCHEMA, id: ID, createdAt: NOW, updatedAt: NOW,
    source: 'zip', status: 'preview', toPlan: false,
    items: [{ id: ITEM, name: '甲.txt', size: 100, status: 'pending', title: '甲', attempts: 0, supported: true }],
    zip: { name: 'books.zip', size: 2048, state: 'ready', sha256: 'a'.repeat(64) },
  };
}

describe('a v1.3 batch (before rejections and failure kinds) still loads', () => {
  it('adds no fabricated rejection counts', () => {
    const raw = base();
    // v1.3 knew neither field.
    delete (raw as { rejected?: unknown }).rejected;
    if (raw.zip) { delete (raw.zip as { failure?: unknown }).failure; delete (raw.zip as { rejection?: unknown }).rejection; }
    const loaded = validateBatches([JSON.parse(JSON.stringify(raw))], NOW);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].rejected).toBeUndefined();
    expect(loaded[0].zip?.failure).toBeUndefined();
    expect(loaded[0].zip?.rejection).toBeUndefined();
    const report = batchReport(loaded[0]);
    expect(report.accepted).toBe(1);
    expect(report.archiveRejected).toBeNull();
    expect(report.incomplete).toBe(false);
    // The digest it already had is untouched.
    expect(loaded[0].zip?.sha256).toBe('a'.repeat(64));
  });
});

describe('a v1.4 batch (rejections, no structured refusal) keeps its numbers', () => {
  it('still reports the same refusals', () => {
    const raw = base();
    raw.rejected = {
      unsupported: { count: 2, names: ['封面.jpg', '说明.png'] },
      tooLarge: { count: 0, names: [] },
      overBudget: { count: 0, names: [] },
      duplicate: { count: 1, names: ['甲.txt'] },
      overflow: { count: 3, names: ['书101.txt', '书102.txt', '书103.txt'] },
    };
    raw.zip!.failure = 'over_limit';
    raw.zip!.error = '超出单批 100 本';
    const loaded = validateBatches([JSON.parse(JSON.stringify(raw))], NOW);
    const report = batchReport(loaded[0]);
    expect(report.unsupported).toBe(2);
    expect(report.duplicate).toBe(1);
    expect(report.overflow).toBe(3);
    expect(report.rejectedNames.overflow).toHaveLength(3);
    // No structured refusal existed then, so none is invented now.
    expect(report.archiveRejected).toBeNull();
    expect(report.incomplete).toBe(true);
    // The v1.4 failure kind is preserved verbatim: `ready` is still retryable.
    expect(loaded[0].zip?.failure).toBe('over_limit');
    expect(loaded[0].zip?.state).toBe('ready');
  });
});

describe('a v1.1/v1.2 reading plan is untouched by the batch work', () => {
  it('keeps a legacy queue migrating exactly as before', () => {
    // A v1.1 plan: no stats at all, items only.
    const legacy = emptyPlan(NOW);
    addPlanItems(legacy, [{ bookKey: 'a', title: 'A', source: 'user' }], NOW);
    const snapshot = { ...legacy, stats: undefined, statsComplete: undefined } as unknown;
    const restored = validatePlan(snapshot, NOW + 1);
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0].bookKey).toBe('a');
    // v1.1 had no counters: the honest answer is a lower bound.
    expect(restored.statsComplete).toBe(false);
    expect(restored.stats.completed).toBe(0);
  });

  it('counts a v1.5 plan as complete because the marker is explicit', () => {
    const plan = emptyPlan(NOW);
    addPlanItems(plan, [{ bookKey: 'a', title: 'A', source: 'user' }], NOW);
    archiveItem(plan, plan.items[0].id, 'completed', NOW + 1);
    const restored = validatePlan(plan, NOW + 2);
    expect(restored.statsComplete).toBe(true);
    expect(restored.stats.completed).toBe(1);
  });
});

describe('a rejection count never exceeds what the archive could hold', () => {
  it('keeps the persisted overflow count exact past the name window', () => {
    const raw = base();
    raw.rejected = {
      unsupported: { count: 0, names: [] }, tooLarge: { count: 0, names: [] },
      overBudget: { count: 0, names: [] }, duplicate: { count: 0, names: [] },
      // 250 refused books, 100 names kept: the count is the truth.
      overflow: { count: 250, names: Array.from({ length: 100 }, (_, index) => `书${index}.txt`) },
    };
    const loaded = validateBatches([JSON.parse(JSON.stringify(raw))], NOW);
    const report = batchReport(loaded[0]);
    expect(report.overflow).toBe(250);
    expect(report.rejectedNames.overflow).toHaveLength(100);
    expect(report.overflow).toBeGreaterThan(BATCH_ITEM_LIMIT);
    expect(report.incomplete).toBe(true);
  });
});