import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildCoverage,
  fingerprintPack,
  fingerprintPackParts,
  isStoryReviewReady,
  normalizeName,
  orderEvents,
  recall,
  relationAt,
  resolveEntity,
  validateEvidence,
  validatePackTree,
  validateStoryChange,
  validateStoryChanges,
} from '../src/story/core.ts';

function makeBook() {
  const texts = [
    '她在雨里等他。他终于来了。',
    '他他他走了。',
    '林平之拔剑。',
    '另一个林平之出现。',
    '𠮷野家的门开了。',
    '甲乙丙丁戊己庚辛壬癸',
    '子丑寅卯辰巳午未申酉',
    '故事在这里转向。',
    '旧的关系开始破裂。',
    '新的关系尚未命名。',
    '结尾之前还有一段路。',
    '这是最后一句话。',
  ];
  let start = 0;
  const segments = texts.map((text, id) => {
    const end = start + Array.from(text).length;
    const segment = { id, chapter: `第${Math.floor(id / 4) + 1}章`, start, end, text };
    start = end;
    return segment;
  });
  return { bookKey: 'book:test', revision: 'rev-1', frontier: segments.length, segments };
}

function eventsFixture() {
  return [
    { id: 'e1', revealedAt: 10, storyOrder: 2, summary: '她在雨里等他', action: '等待', participantIds: ['p1'], evidence: [{ segmentId: 0, start: 0, end: 7, quote: '她在雨里等他。' }], status: 'evidence_linked' },
    { id: 'e2', revealedAt: 20, storyOrder: 1, summary: '他终于来了', action: '出现', participantIds: ['p1', 'p2'], evidence: [{ segmentId: 0, start: 7, end: 13, quote: '他终于来了。' }], status: 'evidence_linked' },
    { id: 'e3', revealedAt: 30, storyOrder: 3, summary: '雨停了', action: '离开', participantIds: ['p1'], evidence: [{ segmentId: 7, start: 0, end: 9, quote: '故事在这里转向。' }], status: 'evidence_linked' },
    { id: 'e4', revealedAt: 40, storyOrder: null, summary: '后来才揭晓的旧事', action: '揭露', participantIds: ['p2'], evidence: [], status: 'candidate' },
  ];
}

test('normalizeName folds width/case/space but keeps Han characters distinct', () => {
  assert.equal(normalizeName('  Ａ  B '), 'a b');
  assert.notEqual(normalizeName('林'), normalizeName('琳'));
});

test('validateEvidence accepts one exact unique quote and computes codepoint offsets', () => {
  const book = makeBook();
  const [ref] = validateEvidence(book, [{ segmentId: 0, quote: '他终于来了。' }]);
  assert.equal(ref.segmentId, 0);
  assert.equal(ref.start, 7);
  assert.equal(ref.end, 13);
  assert.equal(ref.quote, '他终于来了。');
});

test('validateEvidence handles a supplementary-plane character by codepoint', () => {
  const book = makeBook();
  const [ref] = validateEvidence(book, [{ segmentId: 4, quote: '𠮷野家' }]);
  assert.equal(ref.start, book.segments[4].start);
  assert.equal(ref.end, book.segments[4].start + 3);
});

test('validateEvidence rejects unread, missing, ambiguous and offset-mismatched refs', () => {
  const book = makeBook();
  assert.throws(() => validateEvidence(book, [{ segmentId: 0, quote: '他终于来了。' }], { frontier: 0 }), /confirmed range/);
  assert.throws(() => validateEvidence(book, [{ segmentId: 99, quote: 'x' }]), /confirmed range|missing/);
  assert.throws(() => validateEvidence(book, [{ segmentId: 1, quote: '他' }]), /ambiguous/);
  assert.throws(() => validateEvidence(book, [{ segmentId: 0, quote: '他终于来了。', start: 0 }]), /do not match/);
  assert.throws(() => validateEvidence(book, []), /1–5/);
});

test('orderEvents separates reading order from story order and marks unknowns', () => {
  const events = eventsFixture();
  const read = orderEvents(events, 'read');
  assert.deepEqual(read.events.map(event => event.id), ['e1', 'e2', 'e3', 'e4']);
  const story = orderEvents(events, 'story');
  assert.deepEqual(story.events.map(event => event.id), ['e2', 'e1', 'e3', 'e4']);
  assert.deepEqual(story.unknownOrderIds, ['e4']);
});

test('relationAt keeps friend, enemy and reconciliation stages separate', () => {
  const events = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id, index) => ({
    id, revealedAt: 10 * (index + 1), storyOrder: index + 1, summary: id,
  }));
  const relations = [
    { id: 'r1', fromEntityId: 'a', toEntityId: 'b', relation: '朋友', validFromEventId: 'e1', validToEventId: 'e3', revealedAt: 10 },
    { id: 'r2', fromEntityId: 'a', toEntityId: 'b', relation: '敌对', validFromEventId: 'e3', validToEventId: 'e5', revealedAt: 30 },
    { id: 'r3', fromEntityId: 'a', toEntityId: 'b', relation: '和解', validFromEventId: 'e5', revealedAt: 50 },
  ];
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e2', events).map(r => r.relation), ['朋友']);
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e3', events).map(r => r.relation), ['敌对']);
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e4', events).map(r => r.relation), ['敌对']);
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e6', events).map(r => r.relation), ['和解']);
});

test('relationAt does not use a relation before it was revealed', () => {
  const events = [
    { id: 'e1', revealedAt: 10, storyOrder: 1 },
    { id: 'e2', revealedAt: 20, storyOrder: 2 },
  ];
  const relations = [
    { id: 'r1', fromEntityId: 'a', toEntityId: 'b', relation: '秘密', validFromEventId: 'e1', revealedAt: 50 },
  ];
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e2', events), []);
});

test('resolveEntity never merges two same-name entities', () => {
  const entities = [
    { id: 'p1', canonicalName: '林平之', aliases: [{ value: '小林子', scope: '第1章' }] },
    { id: 'p2', canonicalName: '林平之', aliases: [{ value: '小林子', scope: '第2章' }] },
  ];
  const result = resolveEntity('林平之', entities);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.equal(resolveEntity('小林子', entities, { scope: '第1章' }).status, 'resolved');
  assert.equal(resolveEntity('小林子', entities, { scope: '第1章' }).entity.id, 'p1');
  assert.equal(resolveEntity('小林子', entities).status, 'ambiguous');
  assert.equal(resolveEntity('不存在', entities).status, 'none');
});

test('buildCoverage reports gaps and is stable under pack reordering', () => {
  const packs = [
    { id: 'arc1', level: 'arc', coveredRanges: [{ from: 0, to: 10 }] },
    { id: 'arc2', level: 'arc', coveredRanges: [{ from: 20, to: 30 }] },
  ];
  const events = [
    { id: 'e1', revealedAt: 5, status: 'evidence_linked', evidence: [{ segmentId: 0, quote: 'x' }] },
    { id: 'e2', revealedAt: 25, status: 'candidate', evidence: [] },
  ];
  const first = buildCoverage({ packs, events, frontier: 30 });
  const second = buildCoverage({ packs: [...packs].reverse(), events: [...events].reverse(), frontier: 30 });
  assert.deepEqual(first.coveredRanges, [{ from: 0, to: 10 }, { from: 20, to: 30 }]);
  assert.deepEqual(first.uncoveredRanges, [{ from: 10, to: 20 }]);
  assert.equal(first.coveredSegments, 20);
  assert.equal(first.evidenceLinkedCount, 1);
  assert.equal(first.missingEvidence, 1);
  assert.equal(first.coverageDigest, second.coverageDigest);
  assert.ok(first.gaps.includes('uncovered:10-20'));
  assert.ok(first.gaps.includes('events-without-evidence:1'));
});

test('buildCoverage rejects ranges beyond the frontier', () => {
  assert.throws(() => buildCoverage({ packs: [{ id: 'x', coveredRanges: [{ from: 0, to: 31 }] }], frontier: 30 }), /outside/);
});

test('validatePackTree accepts a book/arc/scene tree and rejects invalid links', () => {
  const packs = [
    { id: 'book', level: 'book', childIds: ['arc'], coveredRanges: [{ from: 0, to: 30 }] },
    { id: 'arc', level: 'arc', parentId: 'book', childIds: ['scene'], coveredRanges: [{ from: 0, to: 10 }] },
    { id: 'scene', level: 'scene', parentId: 'arc', childIds: [], coveredRanges: [{ from: 0, to: 5 }] },
  ];
  assert.deepEqual(validatePackTree(packs, { frontier: 30 }), { ok: true, errors: [] });

  const broken = [
    { id: 'book', level: 'book', childIds: ['arc'], coveredRanges: [{ from: 0, to: 10 }] },
    { id: 'arc', level: 'arc', parentId: 'book', childIds: [], coveredRanges: [{ from: 20, to: 30 }] },
  ];
  const result = validatePackTree(broken, { frontier: 30 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('outside parent')));
});

test('validatePackTree rejects cycles and multiple roots', () => {
  const packs = [
    { id: 'a', level: 'book', childIds: ['b'], coveredRanges: [{ from: 0, to: 10 }] },
    { id: 'b', level: 'arc', parentId: 'a', childIds: ['a'], coveredRanges: [{ from: 0, to: 5 }] },
    { id: 'c', level: 'book', childIds: [], coveredRanges: [{ from: 0, to: 5 }] },
  ];
  const result = validatePackTree(packs, { frontier: 10 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.startsWith('cycle:')));
  assert.ok(result.errors.includes('multiple story roots'));
});

test('fingerprintPack is stable under event reordering and changes with summary', () => {
  const events = eventsFixture();
  const pack = { level: 'arc', summary: '雨夜', eventIds: ['e2', 'e1'], relationIds: ['r1'], coveredRanges: [{ from: 0, to: 5 }] };
  const first = fingerprintPack(pack, events);
  const second = fingerprintPack({ ...pack, eventIds: ['e1', 'e2'] }, [...events].reverse());
  assert.equal(first, second);
  assert.notEqual(first, fingerprintPack({ ...pack, summary: '雨夜之后' }, events));
});

test('recall never returns unread events and respects the character budget', () => {
  const events = eventsFixture();
  const unread = { id: 'e9', revealedAt: 100, storyOrder: 9, summary: '雨里未来的结局', action: '未来' };
  const result = recall({ query: '雨', events: [...events, unread], atFrontier: 50, budgetChars: 800, maxItems: 8 });
  assert.equal(result.items.some(item => item.id === 'e9'), false);
  assert.ok(result.items.some(item => item.id === 'e1'));
  assert.equal((result as any).scope, 'confirmed-frontier-only');
  assert.equal((result as any).semanticMatchVerified, false);
});

test('recall reports omission instead of silently truncating', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `e${index}`, revealedAt: index + 1, storyOrder: index + 1, summary: '同一段记忆的重复描述', action: '行动',
  }));
  const result = recall({ query: '记忆', events, atFrontier: 30, budgetChars: 250, maxItems: 20 });
  assert.ok(result.items.length < 20);
  assert.equal(result.budgetExhausted, true);
  assert.ok(result.omittedCount > 0);
  assert.equal(result.nextCursor, null);
  assert.equal(result.budgetBlocked, true);
});

test('recall empty query returns visible events in the requested chronology', () => {
  const events = eventsFixture();
  const read = recall({ query: '', events, atFrontier: 50, chronology: 'read', budgetChars: 5000 });
  assert.deepEqual(read.items.map(item => item.id), ['e1', 'e2', 'e3', 'e4']);
  const story = recall({ query: '', events, atFrontier: 50, chronology: 'story', budgetChars: 5000 });
  assert.deepEqual(story.items.map(item => item.id), ['e2', 'e1', 'e3', 'e4']);
});

test('validateStoryChange forces model_interpretation when there is no quote', () => {
  const book = makeBook();
  const result = validateStoryChange({
    kind: 'event', summary: '他来了', evidenceSegmentIds: [0], sourceKind: 'original_explicit',
  }, book, { frontier: 12 });
  assert.equal(result.sourceKind, 'model_interpretation');
  assert.equal(result.status, 'candidate');
  assert.equal(result.progressAdvanced, false);
  assert.equal(result.evidence[0].segmentId, 0);
  assert.equal((result.evidence[0] as any).quote, undefined);
});

test('validateStoryChange accepts one exact quote and rejects unread/ambiguous/oversized input', () => {
  const book = makeBook();
  const accepted = validateStoryChange({
    kind: 'event', summary: '他终于来了', evidenceSegmentIds: [0], quote: '他终于来了。',
  }, book, { frontier: 12 });
  assert.equal(accepted.evidence[0].start, 7);
  assert.equal(accepted.evidence[0].end, 13);
  assert.equal(accepted.sourceKind, 'model_interpretation');

  assert.throws(() => validateStoryChange({ kind: 'event', summary: 'x', evidenceSegmentIds: [99] }, book, { frontier: 12 }), /unread|missing/);
  assert.throws(() => validateStoryChange({ kind: 'event', summary: 'x', evidenceSegmentIds: [1], quote: '他' }, book, { frontier: 12 }), /exactly one|ambiguous/);
  assert.throws(() => validateStoryChange({ kind: 'event', summary: 'x'.repeat(241), evidenceSegmentIds: [0] }, book, { frontier: 12 }), /240/);
  assert.throws(() => validateStoryChanges([1, 2, 3, 4, 5].map(() => ({ kind: 'event', summary: 'x', evidenceSegmentIds: [0] })), book, { frontier: 12 }), /at most 4/);
});

test('validateEvidence rejects a quote that appears in two cited segments when used by story change', () => {
  const book = makeBook();
  assert.throws(() => validateStoryChange({
    kind: 'event', summary: '重复', evidenceSegmentIds: [0, 1], quote: '他',
  }, book, { frontier: 12 }), /exactly one|ambiguous/);
});

test('buildCoverage without packs marks the whole frontier as an explicit gap', () => {
  const result = buildCoverage({ packs: [], events: [], frontier: 12 });
  assert.deepEqual(result.uncoveredRanges, [{ from: 0, to: 12 }]);
  assert.equal(result.coverageRatio, 0);
  assert.ok(result.gaps.includes('no-story-pack'));
  assert.ok(result.gaps.includes('uncovered:0-12'));
});

test('recall no-match is explicit and does not invent a plot event', () => {
  const result = recall({ query: '完全不存在的词', events: eventsFixture(), atFrontier: 50 });
  assert.deepEqual(result.items, []);
  assert.equal(result.budgetExhausted, false);
  assert.match((result as any).noResultsMeaning, /not proof/);
});

test('validateStoryChange rejects duplicate evidence ids, unknown kind and revision mismatch', () => {
  const book = makeBook();
  assert.throws(() => validateStoryChange({ kind: 'event', summary: 'x', evidenceSegmentIds: [0, 0] }, book, { frontier: 12 }), /duplicate/);
  assert.throws(() => validateStoryChange({ kind: 'unknown', summary: 'x', evidenceSegmentIds: [0] }, book, { frontier: 12 }), /kind/);
  assert.throws(() => validateStoryChange({ kind: 'event', summary: 'x', revision: 'other', evidenceSegmentIds: [0] }, book, { frontier: 12 }), /revision/);
});

test('orderEvents rejects a malformed event before sorting', () => {
  assert.throws(() => orderEvents([{ id: 'e1' }], 'read'), /revealedAt/);
  assert.throws(() => orderEvents([{ id: 'e1', revealedAt: 1 }], 'unknown'), /read or story/);
});

test('a 360-segment synthetic book supports coverage, recall bounds and exact evidence', () => {
  let start = 0;
  const segments = Array.from({ length: 360 }, (_, id) => {
    const text = `第${id}段：这是用于长书覆盖测试的合成文本。`;
    const end = start + Array.from(text).length;
    const segment = { id, chapter: `第${Math.floor(id / 20) + 1}章`, start, end, text };
    start = end;
    return segment;
  });
  const book = { bookKey: 'book:long', revision: 'rev-long', frontier: 360, segments };
  const events = Array.from({ length: 36 }, (_, index) => ({
    id: `e${index}`,
    revealedAt: (index + 1) * 10,
    storyOrder: index + 1,
    summary: `事件${index}：林在长书里行动`,
    action: '行动',
    participantIds: ['lin'],
    status: index % 5 === 0 ? 'candidate' : 'evidence_linked',
    evidence: index % 5 === 0 ? [] : [{ segmentId: Math.min((index + 1) * 10 - 1, 359), start: 0, end: 1, quote: '第' }],
  }));
  const packs = [
    { id: 'arc-a', level: 'arc', coveredRanges: [{ from: 0, to: 180 }] },
    { id: 'arc-b', level: 'arc', coveredRanges: [{ from: 200, to: 360 }] },
  ];
  const coverage = buildCoverage({ packs, events, frontier: 360 });
  assert.equal(coverage.uncoveredRanges[0].from, 180);
  assert.equal(coverage.uncoveredRanges[0].to, 200);
  assert.equal(coverage.eventCount, 36);
  assert.equal(coverage.missingEvidence, 8);

  const recalled = recall({ query: '林', events, atFrontier: 180, budgetChars: 1500, maxItems: 8 });
  assert.ok(recalled.items.length > 0);
  assert.equal(recalled.items.every(item => item.revealedAt <= 180), true);
  assert.equal(recalled.omittedCount > 0, true);

  const [ref] = validateEvidence(book, [{ segmentId: 359, quote: '第359段' }], { frontier: 360 });
  assert.equal(ref.start, segments[359].start);
  assert.equal(ref.end, segments[359].start + 5);
});

// N01/N02: every upstream semantic/status/relation change must invalidate.
test('N01 fingerprint input changes with event meaning, status and source kind', () => {
  const events = eventsFixture();
  const pack = { level: 'arc', summary: '雨夜', eventIds: ['e1', 'e2'], coveredRanges: [{ from: 0, to: 5 }] };
  const base = fingerprintPackParts(pack, events).inputFingerprint;
  for (const patch of [
    { summary: '完全相反的事件' },
    { action: '相反的 action' },
    { outcome: '相反的 outcome' },
    { status: 'disputed' },
    { sourceKind: 'original_explicit' },
  ]) {
    const changed = events.map(event => event.id === 'e1' ? { ...event, ...patch } : event);
    assert.notEqual(fingerprintPackParts(pack, changed).inputFingerprint, base);
    assert.notEqual(fingerprintPack(pack, changed), fingerprintPack(pack, events));
  }
});

test('N02 fingerprint input changes with relation content, evidence and version', () => {
  const events = eventsFixture();
  const pack = { level: 'arc', summary: '雨夜', eventIds: ['e1'], relationIds: ['r1'], coveredRanges: [{ from: 0, to: 5 }] };
  const baseRelation = {
    id: 'r1', fromEntityId: 'a', toEntityId: 'b', relation: '朋友',
    validFromEventId: 'e1', revealedAt: 10, status: 'evidence_linked', sourceKind: 'model_interpretation',
    evidence: [{ segmentId: 0, start: 0, end: 2, quote: '她在' }],
  };
  const base = fingerprintPackParts(pack, events, [baseRelation]).inputFingerprint;
  for (const patch of [
    { relation: '敌人' },
    { status: 'disputed' },
    { sourceKind: 'original_explicit' },
    { evidence: [{ segmentId: 0, start: 0, end: 2, quote: '他在' }] },
    { version: 2 },
  ]) {
    assert.notEqual(fingerprintPackParts(pack, events, [{ ...baseRelation, ...patch }]).inputFingerprint, base);
  }
  assert.notEqual(fingerprintPackParts({ ...pack, summary: '新标题' }, events, [baseRelation]).outputFingerprint,
    fingerprintPackParts(pack, events, [baseRelation]).outputFingerprint);
});

// N03: budget covers the complete model-visible JSON and cursor really pages.
test('N03 complete recall payload stays under budget with long relations and omissions', () => {
  const events = Array.from({ length: 8 }, (_, index) => ({
    id: `e${index}`, revealedAt: index + 1, storyOrder: index + 1,
    summary: '短事件', action: '行动', participantIds: ['p'],
  }));
  const relations = Array.from({ length: 8 }, (_, index) => ({
    id: `r${index}`, fromEntityId: 'p', toEntityId: 'q', relation: '很长的关系描述'.repeat(80),
    revealedAt: index + 1, validFromEventId: 'e0', evidence: [],
  }));
  for (const budgetChars of [200, 250, 400, 800, 2000, 6000]) {
    const result = recall({ query: '', events, relations, atFrontier: 20, budgetChars, maxItems: 8 });
    assert.ok(JSON.stringify(result).length <= budgetChars, `budget ${budgetChars} exceeded`);
  }
  const result = recall({ query: '', events, relations, atFrontier: 20, budgetChars: 200, maxItems: 8 });
  assert.equal(result.budgetBlocked, true);
  assert.equal(result.items.length, 0);
});

test('N03 cursor pages deterministically without duplicates or omissions', () => {
  const events = Array.from({ length: 7 }, (_, index) => ({
    id: `e${index}`, revealedAt: index + 1, storyOrder: index + 1, summary: `事件${index}`, action: '行动',
  }));
  const first = recall({ query: '', events, atFrontier: 20, budgetChars: 10000, maxItems: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(typeof first.nextCursor, 'string');
  const second = recall({ query: '', events, atFrontier: 20, budgetChars: 10000, maxItems: 2, cursor: first.nextCursor });
  const ids = [...first.items, ...second.items].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['e0', 'e1', 'e2', 'e3']);
});

test('N03 cursor is bound to its snapshot and rejects changed data', () => {
  const events = Array.from({ length: 4 }, (_, index) => ({
    id: `e${index}`, revealedAt: index + 1, storyOrder: index + 1, summary: `事件${index}`, action: '行动',
  }));
  const first = recall({ query: '', events, atFrontier: 20, budgetChars: 5000, maxItems: 1 });
  assert.throws(() => recall({
    query: '', events: [...events, { id: 'e9', revealedAt: 9, storyOrder: 9, summary: '新增', action: '行动' }],
    atFrontier: 20, budgetChars: 5000, maxItems: 1, cursor: first.nextCursor,
  }), /cursor/);
});

test('N03 cursor invalidates when summary, evidence or relation content changes', () => {
  const events = [
    { id: 'e0', revealedAt: 1, storyOrder: 1, summary: '人物A背叛了伙伴', action: '背叛', evidence: [{ segmentId: 0, start: 0, end: 2, quote: '背叛' }] },
    { id: 'e1', revealedAt: 2, storyOrder: 2, summary: '后续', action: '继续' },
  ];
  const relations = [{ id: 'r0', fromEntityId: 'a', toEntityId: 'b', relation: '朋友', revealedAt: 1, version: 1 }];
  const first = recall({ query: '', events, relations, atFrontier: 20, budgetChars: 5000, maxItems: 1 });
  assert.equal(typeof first.nextCursor, 'string');

  const summaryChanged = events.map(event => event.id === 'e0' ? { ...event, summary: '人物A从未背叛伙伴' } : event);
  assert.throws(() => recall({ query: '', events: summaryChanged, relations, atFrontier: 20, budgetChars: 5000, maxItems: 1, cursor: first.nextCursor }), /cursor/);

  const evidenceChanged = events.map(event => event.id === 'e0' ? { ...event, evidence: [{ segmentId: 0, start: 0, end: 2, quote: '救助' }] } : event);
  assert.throws(() => recall({ query: '', events: evidenceChanged, relations, atFrontier: 20, budgetChars: 5000, maxItems: 1, cursor: first.nextCursor }), /cursor/);

  const relationChanged = [{ ...relations[0], relation: '敌人' }];
  assert.throws(() => recall({ query: '', events, relations: relationChanged, atFrontier: 20, budgetChars: 5000, maxItems: 1, cursor: first.nextCursor }), /cursor/);
});

test('N03 recall relations obey frontier and relevance filters', () => {
  const events = [{ id: 'e1', revealedAt: 10, storyOrder: 1, summary: '雨', action: '等待', participantIds: ['p'] }];
  const relations = [
    { id: 'r1', fromEntityId: 'p', toEntityId: 'q', relation: '雨中的约定', revealedAt: 10 },
    { id: 'r2', fromEntityId: 'x', toEntityId: 'y', relation: '无关关系', revealedAt: 10 },
    { id: 'r3', fromEntityId: 'p', toEntityId: 'q', relation: '未来关系', revealedAt: 99 },
  ];
  const result = recall({ query: '雨', events, relations, atFrontier: 20, budgetChars: 5000, maxItems: 8 });
  assert.deepEqual(result.relations.map(relation => relation.id), ['r1']);
});

// N04/N05: story position and reader knowledge are separate.
test('N04 knownAtFrontier replays an earlier event with later knowledge', () => {
  const events = [
    { id: 'e1', revealedAt: 10, storyOrder: 1 },
    { id: 'e2', revealedAt: 20, storyOrder: 2 },
  ];
  const relations = [{
    id: 'r1', fromEntityId: 'a', toEntityId: 'b', relation: '秘密', validFromEventId: 'e1', revealedAt: 50,
  }];
  assert.deepEqual(relationAt(relations, 'a', 'b', 'e2', events, { knownAtFrontier: 20 }), []);
  assert.equal(relationAt(relations, 'a', 'b', 'e2', events, { knownAtFrontier: 100 }).length, 1);
});

test('N05 rejects reversed relation intervals and unknown story order', () => {
  const events = [
    { id: 'e1', revealedAt: 10, storyOrder: 1 },
    { id: 'e2', revealedAt: 20, storyOrder: 2 },
  ];
  const reversed = [{
    id: 'r1', fromEntityId: 'a', toEntityId: 'b', relation: '错', validFromEventId: 'e2', validToEventId: 'e1', revealedAt: 10,
  }];
  assert.throws(() => relationAt(reversed, 'a', 'b', 'e2', events), /validTo/);
  assert.throws(() => relationAt([], 'a', 'b', 'e2', [{ id: 'e1', revealedAt: 10 }]), /unknown/);
});

// N06: every persisted field is schema-checked.
test('N06 rejects free-form relation/outcome/storyTime fields and unknown keys', () => {
  const book = makeBook();
  const base = { kind: 'event', summary: '合法', evidenceSegmentIds: [0] };
  for (const patch of [
    { fromName: { nested: true } },
    { toName: 'x'.repeat(20000) },
    { relation: 'x'.repeat(4000) },
    { storyTime: { year: 1 } },
    { names: 'not-an-array' },
    { unknownField: 1 },
  ]) {
    assert.throws(() => validateStoryChange({ ...base, ...patch }, book, { frontier: 12 }));
  }
  const namesOnly = validateStoryChange({
    kind: 'relation', summary: '关系候选', evidenceSegmentIds: [0],
    fromName: '林', toName: '林', relation: '朋友',
  }, book, { frontier: 12 });
  assert.equal(namesOnly.entityBinding, 'names-only-unresolved');
  assert.ok(namesOnly.qualityFlags.includes('relation-names-unresolved'));
  const withIds = validateStoryChange({
    kind: 'relation', summary: '关系候选', evidenceSegmentIds: [0],
    fromEntityId: 'p1', toEntityId: 'p2', relation: '朋友',
  }, book, { frontier: 12 });
  assert.equal(withIds.entityBinding, 'ids');
});

test('N06 relation changes require both sides and a relation label', () => {
  const book = makeBook();
  assert.throws(() => validateStoryChange({ kind: 'relation', summary: 'x', evidenceSegmentIds: [0] }, book, { frontier: 12 }), /relation/);
  assert.throws(() => validateStoryChange({ kind: 'relation', summary: 'x', evidenceSegmentIds: [0], fromName: '林', relation: '朋友' }, book, { frontier: 12 }), /both sides/);
});

// N07: the book view itself must be a complete contiguous 0..n-1 partition.
test('N07 rejects duplicate ids, wrong order, gaps, overlaps and partial views', () => {
  const book = makeBook();
  const duplicate = { ...book, segments: book.segments.map((segment, index) => index === 1 ? { ...segment, id: 0 } : segment) };
  assert.throws(() => validateEvidence(duplicate, [{ segmentId: 0, quote: 'x' }]), /expected index/);
  const gap = book.segments.map((segment, index) => index === 1 ? { ...segment, start: segment.start + 1, end: segment.end + 1 } : segment);
  assert.throws(() => validateEvidence({ ...book, segments: gap }, [{ segmentId: 0, quote: 'x' }]), /gap|overlap|invalid/);
  const overlap = book.segments.map((segment, index) => index === 1 ? { ...segment, start: segment.start - 1 } : segment);
  assert.throws(() => validateEvidence({ ...book, segments: overlap }, [{ segmentId: 0, quote: 'x' }]), /gap|overlap|invalid/);
  assert.throws(() => validateEvidence({ ...book, segments: book.segments.slice(0, 5), totalSegments: 12 }, [{ segmentId: 0, quote: 'x' }]), /partial/);
});

// N08: structural validity is not review readiness.
test('N08 empty packs/frontier and invalid events cannot become review-ready', () => {
  assert.deepEqual(validatePackTree([], { frontier: 10 }), { ok: false, errors: ['no-story-pack'] });
  const empty = buildCoverage({ packs: [], events: [], frontier: 0 });
  assert.equal(empty.coverageRatio, 0);
  assert.equal((empty as any).isReviewReady, false);
  assert.ok((empty as any).reviewReadyReasons.includes('frontier-empty'));
  assert.throws(() => buildCoverage({ packs: [], events: [{ id: 'bad' }], frontier: 10 }), /invalid story event/);

  const packs = [
    { id: 'book', level: 'book', childIds: ['arc'], coveredRanges: [{ from: 0, to: 2 }] },
    { id: 'arc', level: 'arc', parentId: 'book', childIds: [], coveredRanges: [{ from: 0, to: 2 }] },
  ];
  const events = [
    { id: 'e1', revealedAt: 1, status: 'evidence_linked', evidence: [{ segmentId: 0, start: 0, end: 1, quote: '在' }] },
  ];
  const readyCoverage = buildCoverage({ packs, events, frontier: 2 });
  assert.equal((readyCoverage as any).isReviewReady, true);
  assert.deepEqual(isStoryReviewReady({ packs, coverage: readyCoverage }), { ready: true, reasons: [] });
});

// N09: a matching quote does not turn a model summary into a proven fact.
test('N09 exact quote keeps a fabricated summary as unverified candidate', () => {
  const book = makeBook();
  const change = validateStoryChange({
    kind: 'event', summary: '她其实一直在策划谋杀他', evidenceSegmentIds: [0], quote: '她在雨里等他。',
  }, book, { frontier: 12 });
  assert.equal(change.status, 'candidate');
  assert.equal(change.sourceKind, 'model_interpretation');
  assert.equal((change.evidence[0] as any).quote, '她在雨里等他。');
  assert.notEqual(change.status, 'evidence_linked');
});



