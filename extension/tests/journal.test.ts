import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library, validateState, type LibraryOptions } from '../src/library.ts';
import { digest } from '../src/books.ts';

let dir: string, now: number, stores: Library[];
function open(options: Partial<LibraryOptions> = {}) {
  const lib = new Library({ dataDir: dir, now: () => now, ...options }); stores.push(lib); lib.open(); return lib;
}
function prepare(lib: Library, text = '🐟小鱼把最后一块饼留给妹妹。她说自己不饿。\n' + '海风轻轻吹过岸边。'.repeat(300), title = '合成短篇') {
  const book = lib.import({ filename: 'sample.txt', title, base64: Buffer.from(text).toString('base64') }).book;
  lib.select(book.key); return book;
}
function task(lib: Library) { const t = lib.readNext(); if (t.complete) throw new Error('Expected segment'); return t; }
function episode(segmentId = 0, quote = '小鱼把最后一块饼留给妹妹。') {
  return { trigger: '小鱼把饼留给妹妹', interpretation: '我开始佩服她。', priorJudgment: '之前还拿不准她是否只顾自己。',
    reason: '她先照顾妹妹，让我改变判断。', mood: { label: '有点心疼', intensity: 3 },
    evidence: [{ segmentId, quote }], characters: [{ name: '小鱼', aliases: ['姐姐'] }], questions: ['她真的不饿吗？'] };
}
function finish(lib: Library, content: unknown = episode(), t = task(lib)) {
  return lib.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '小鱼把饼留给妹妹。', ...(content === undefined ? {} : { episode: content }) });
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-journal-')); now = Date.parse('2026-11-07T12:00:00Z'); stores = []; });
afterEach(() => { for (const lib of stores) lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('exact reading evidence, atomic progress and authored reports', () => {
  it('saves a reading episode atomically and computes Unicode-codepoint anchors', () => {
    const lib = open(); const b = prepare(lib); const result = finish(lib);
    const saved = lib.episode(result.receipt.episodeId!);
    expect(saved.evidence[0]).toMatchObject({ segmentId: 0, start: 1, end: 14, exactTextMatched: true, interpretationVerified: false });
    expect(saved.episode.recordedAt).toBe(new Date(now).toISOString()); expect(saved.episode.kind).toBe('reading');
    expect(lib.journal(b.key)).toMatchObject({ confirmedRanges: 1, rangesWithoutReadingEpisode: 0, total: 1, mood: { label: '有点心疼', isCurrentMentalState: false } });
    expect(saved.episode.content.questions).toEqual(['她真的不饿吗？']);
  });
  it('rejects invented text, wrong offsets and unread references without confirming the task', () => {
    const lib = open(); prepare(lib); const t = task(lib);
    for (const evidence of [[{ segmentId: 0, quote: '她把所有食物都吃掉了' }], [{ segmentId: 0, quote: '小鱼把最后一块饼留给妹妹。', start: 0 }], [{ segmentId: 1, quote: '海风' }]]) {
      expect(() => finish(lib, { ...episode(), evidence }, t)).toThrow();
      expect(lib.status().current!.confirmedSegments).toBe(0); expect(lib.journal().total).toBe(0);
    }
  });
  it('requires an unambiguous quotation or explicit matching offset', () => {
    const lib = open(); prepare(lib, '🐟海风。海风。'); const t = task(lib);
    expect(() => finish(lib, { ...episode(), evidence: [{ segmentId: 0, quote: '海风。' }] }, t)).toThrow(/ambiguous/);
    const result = finish(lib, { ...episode(), evidence: [{ segmentId: 0, quote: '海风。', start: 4 }] }, t);
    expect(lib.episode(result.receipt.episodeId!).evidence[0]).toMatchObject({ start: 4, end: 7 });
  });
  it('deduplicates exact confirmations but never changes an existing episode on retry', () => {
    const lib = open(); prepare(lib); const t = task(lib); const result = finish(lib, episode(), t);
    expect(finish(lib, episode(), t)).toEqual({ duplicate: true, receipt: result.receipt });
    expect(() => finish(lib, { ...episode(), reason: '另一种理由' }, t)).toThrow(/retry/);
    expect(() => lib.finish({ ...result.receipt })).toThrow(/episode/);
    expect(lib.journal().total).toBe(1);
  });
  it('does not turn a missing report into mood or invent notes from legacy confirmations', () => {
    const lib = open(); prepare(lib); const t = task(lib);
    lib.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '当时只记录了短理解。' });
    expect(lib.journal()).toMatchObject({ total: 0, confirmedRanges: 1, rangesWithoutReadingEpisode: 1, mood: null });
  });
  it('keeps the last explicitly reported mood and timestamp when a newer record omits mood/reason', () => {
    const lib = open(); const b = prepare(lib); const first = finish(lib); const time = new Date(now).toISOString(); now += 3600000;
    lib.reflect({ bookKey: b.key, requestId: 'without-mood', episode: { ...episode(), mood: null, reason: null, priorJudgment: null } });
    expect(lib.journal().mood).toMatchObject({ recordedAt: time, episodeId: first.receipt.episodeId });
    const newest = lib.episode(lib.journal().items[0].id); expect(newest.episode.content.reason).toBeNull();
    expect(newest.episode.content.mood).toBeNull();
  });
  it('rolls back both journal and progress on disk failure', () => {
    let fail = false;
    const lib = open({ write: (file, state) => { if (fail) throw new Error('disk full'); writeFileSync(file, JSON.stringify(state)); } });
    prepare(lib); const t = task(lib); fail = true;
    expect(() => finish(lib, episode(), t)).toThrow('disk full');
    expect(lib.journal().total).toBe(0); expect(lib.status().current!.confirmedSegments).toBe(0);
    fail = false; finish(lib, episode(), t); expect(lib.journal().total).toBe(1);
  });
  it('rejects a reading episode citing only an old segment', () => {
    const lib = open(); prepare(lib); finish(lib);
    const t = task(lib); expect(() => finish(lib, episode(), t)).toThrow(/current task/); expect(lib.status().current!.confirmedSegments).toBe(1);
  });
});

describe('append-only reflections, revisions and stable indexes', () => {
  it('preserves the original and timestamps later revisions as new reflections', () => {
    const lib = open(); const b = prepare(lib); const initial = finish(lib); const original = lib.episode(initial.receipt.episodeId!).episode;
    now += 3600000;
    const revision = lib.reflect({ bookKey: b.key, requestId: 'revision-1', revises: original.id,
      episode: { ...episode(), interpretation: '现在重读，更在意她没有说出饥饿。', relatedEpisodeIds: [original.id] } });
    expect(revision.episode).toMatchObject({ kind: 'revision', revises: original.id, recordedAt: new Date(now).toISOString() });
    expect(lib.episode(original.id).episode).toEqual(original); expect(lib.episode(original.id).revisions[0].id).toBe(revision.episode.id);
    expect(lib.status().current!.confirmedSegments).toBe(1);
    expect(lib.journal().characters).toMatchObject([{ name: '小鱼', aliases: ['姐姐'], episodeIds: [original.id, revision.episode.id] }]);
  });
  it('deduplicates reflection requests and rejects conflicting retries', () => {
    const lib = open(); const b = prepare(lib); finish(lib);
    const args = { bookKey: b.key, requestId: 'reflect-1', episode: episode() };
    const result = lib.reflect(args); expect(lib.reflect(args)).toEqual({ duplicate: true, episode: result.episode });
    expect(() => lib.reflect({ ...args, episode: { ...episode(), interpretation: 'changed' } })).toThrow(/retry/);
  });
  it('rejects references and revisions to future, missing or other-version records', () => {
    const lib = open(); const a = prepare(lib); const first = finish(lib);
    const b = prepare(lib, '另一个版本的海边故事', '另一本'); const t = task(lib); lib.finish({ ...t, understanding: '另一本' });
    for (const bookKey of [a.key, b.key]) {
      expect(() => lib.reflect({ bookKey, requestId: 'bad', revises: 'future', episode: episode() })).toThrow();
    }
    expect(() => lib.reflect({ bookKey: b.key, requestId: 'cross', revises: first.receipt.episodeId,
      episode: { ...episode(), evidence: [{ segmentId: 0, quote: '海边' }] } })).toThrow(/same|exact/);
    expect(() => lib.reflect({ bookKey: a.key, requestId: 'future-link', episode: { ...episode(), relatedEpisodeIds: ['missing'] } })).toThrow(/earlier/);
  });
  it('pages by stable sequence while new entries are appended', () => {
    const lib = open(); const b = prepare(lib); finish(lib);
    for (let i = 0; i < 7; i++) lib.reflect({ bookKey: b.key, requestId: `r${i}`, episode: episode() });
    const first = lib.journal(b.key, undefined, 3); lib.reflect({ bookKey: b.key, requestId: 'new', episode: episode() });
    const second = lib.journal(b.key, first.nextBefore, 3);
    expect(first.items.map(e => e.sequence)).toEqual([8, 7, 6]); expect(second.items.map(e => e.sequence)).toEqual([5, 4, 3]);
    expect(() => lib.journal(b.key, undefined, 21)).toThrow(/page/);
  });
});

describe('journal state migration, restoration and tamper checks', () => {
  it('migrates schema1 without making up episodes, reasons, moods or timestamps', () => {
    const lib = open(); prepare(lib); const t = task(lib); lib.finish({ ...t, understanding: 'old note' }); const logical=JSON.parse(lib.export()).payload;lib.close();
    const legacy = JSON.parse(logical); legacy.schema = 1; delete legacy.episodes; delete legacy.nextEpisodeSequence; delete legacy.reviews; delete legacy.reviewJobs;
    writeFileSync(lib.file, JSON.stringify(legacy)); lib.open();
    expect(lib.journal()).toMatchObject({ total: 0, confirmedRanges: 1, mood: null });
    expect(JSON.parse(readFileSync(lib.file, 'utf8')).schema).toBe(6);
  });
  it('preserves episodes, relationships and exact evidence across restart and backup restoration', () => {
    const lib = open(); const b = prepare(lib); const first = finish(lib);
    lib.reflect({ bookKey: b.key, requestId: 'later', revises: first.receipt.episodeId, episode: episode() });
    const expected = lib.journal(); const backup = lib.export(); lib.close(); lib.open(); expect(lib.journal()).toEqual(expected);
    const restored = open({ dataDir: join(dir, 'restored') }); restored.restore(backup);
    expect(restored.journal()).toEqual(expected); expect(restored.episode(first.receipt.episodeId!).evidence).toEqual(lib.episode(first.receipt.episodeId!).evidence);
  });
  it('rejects altered quotations, missing task backing, time, revision cycles and sequence corruption', () => {
    const lib = open(); const b = prepare(lib); const first = finish(lib);
    lib.reflect({ bookKey: b.key, requestId: 'r', revises: first.receipt.episodeId, episode: episode() });
    const state = JSON.parse(JSON.parse(lib.export()).payload);
    const mutations = [
      (v: typeof state) => { v.episodes[0].content.evidence[0].quote = '伪造'; },
      (v: typeof state) => { delete v.tasks[0].receipt.episodeId; },
      (v: typeof state) => { v.episodes[0].recordedAt = 'unknown'; },
      (v: typeof state) => { v.episodes[1].revises = v.episodes[1].id; },
      (v: typeof state) => { v.nextEpisodeSequence = 1; },
      (v: typeof state) => { v.episodes[1].sequence = v.episodes[0].sequence; },
    ];
    for (const mutate of mutations) { const altered = structuredClone(state); mutate(altered); expect(() => validateState(altered)).toThrow(); }
    const envelope = { format: 'bookfish-backup-v1', payload: JSON.stringify(state), checksum: digest(JSON.stringify(state)) };
    expect(envelope.format).toBe('bookfish-backup-v1');
  });
  it('removes the book journal on version deletion or clear, without carrying it to another book', () => {
    const lib = open(); const b = prepare(lib); const first = finish(lib); lib.remove(b.key);
    expect(() => lib.episode(first.receipt.episodeId!)).toThrow();
    prepare(lib); finish(lib); lib.clear(); expect(lib.list()).toEqual([]); expect(() => lib.journal()).toThrow();
  });
});
