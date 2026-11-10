import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, lib: Library, key: string, original: string, revised: string;
function offer() { const t = lib.readNext(); if (t.complete) throw new Error('Expected segment'); return t; }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-retrieval-')); lib = new Library({ dataDir: dir }); lib.open();
  const book = lib.import({ filename: 'story.md', title: '合成检索样本', base64: Buffer.from('# 一 饼\n小鱼把最后一块饼留给妹妹。\n' + '海风。'.repeat(430) + '\n# 二 灯\n小虾把最后一盏灯留给弟弟。\n' + '夜色。'.repeat(430) + '\n# 三 未读\n秘密结局：银钥匙藏在山顶。').toString('base64') });
  key = book.book.key; lib.select(key);
  const first = offer();
  original = lib.finish({ ...first, understanding: '小鱼留饼给妹妹', episode: { trigger: '留饼给妹妹', interpretation: '我开始佩服小鱼', reason: '她先照顾妹妹',
    mood: { label: '心疼' }, evidence: [{ segmentId: 0, quote: '小鱼把最后一块饼留给妹妹。' }], characters: [{ name: '小鱼', aliases: ['姐姐'] }], questions: ['小鱼饿不饿？'] } }).receipt.episodeId!;
  revised = lib.reflect({ bookKey: key, requestId: 'revision', revises: original, episode: { trigger: '重读留饼', interpretation: '现在仍佩服，但不能断言她不饿',
    reason: '没有明确写她是否饥饿', evidence: [{ segmentId: 0, quote: '小鱼把最后一块饼留给妹妹。' }], characters: [{ name: '小鱼', aliases: ['姐姐'] }], relatedEpisodeIds: [original] } }).episode.id;
});
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('scoped lexical discovery, not invented semantic memory', () => {
  it('finds saved reasons, aliases, questions and exact source with bounded snippets', () => {
    const result = lib.search({ query: '妹妹', character: '姐姐', kind: 'episode' });
    expect(result.items.map(e => e.id)).toContain(original); expect(result.items.map(e => e.id)).toContain(revised);
    expect(result.characterClaims[0]).toMatchObject({ name: '小鱼', aliases: ['姐姐'] });
    expect(result.items.every(e => Array.from(e.snippet).length <= 160)).toBe(true);
    expect(lib.search({ query: '饿不饿', kind: 'episode' }).items[0].matchedFields).toContain('questions');
    expect(result).toMatchObject({ progressAdvanced: false, semanticMatchVerified: false, scope: 'confirmed-ranges-only' });
  });
  it('searches only confirmed segments, not cached unread text or chapter headings', () => {
    expect(lib.search({ query: '银钥匙' }).total).toBe(0); expect(lib.search({ chapter: '未读' }).total).toBe(0);
    expect(() => lib.search({ segmentId: 1 })).toThrow(/unread/);
    const t = offer(); expect(() => lib.search({ segmentId: t.segmentId })).toThrow(/unread/);
    expect(lib.status().current!.confirmedSegments).toBe(1);
  });
  it('does not substitute a similar event involving another character', () => {
    while (lib.status().current!.confirmedSegments < 2) lib.finish({ ...offer(), understanding: '海风延续' });
    const t = offer(); lib.finish({ ...t, understanding: '小虾留灯给弟弟', episode: { trigger: '留灯给弟弟', interpretation: '我佩服小虾', reason: '她留下了灯',
      evidence: [{ segmentId: t.segmentId, quote: '小虾把最后一盏灯留给弟弟。' }], characters: [{ name: '小虾', aliases: ['虾姐姐'] }] } });
    const result = lib.search({ query: '佩服', character: '小鱼', kind: 'episode' });
    expect(result.items.every(e => [original, revised].includes(e.id))).toBe(true);
    expect(lib.search({ query: '灯', character: '小鱼', kind: 'episode' }).total).toBe(0);
  });
  it('keeps book revisions separate even for identical story terms', () => {
    const other = lib.import({ filename: 'other.md', title: '另一个版本', base64: Buffer.from('小鱼妹妹银钥匙').toString('base64') }).book;
    expect(lib.search({ bookKey: other.key, query: '小鱼' }).total).toBe(0);
    expect(() => lib.context({ bookKey: other.key, episodeIds: [original] })).toThrow(/revision/);
  });
  it('pages deterministically and rejects reuse after progress or query changes', () => {
    const page = lib.search({ query: '小鱼', limit: 1 }); expect(page.nextCursor).not.toBeNull();
    const second = lib.search({ query: '小鱼', limit: 1, cursor: page.nextCursor }); expect(second.items[0].id).not.toBe(page.items[0].id);
    expect(() => lib.search({ query: '妹妹', limit: 1, cursor: page.nextCursor })).toThrow(/changed/);
    lib.finish({ ...offer(), understanding: '下一段' }); expect(() => lib.search({ query: '小鱼', limit: 1, cursor: page.nextCursor })).toThrow(/changed/);
  });
  it('invalidates a search cursor after a new reflection but not a mere repeated read offer', () => {
    const page = lib.search({ limit: 1 }); offer(); expect(() => lib.search({ limit: 1, cursor: page.nextCursor })).not.toThrow();
    lib.reflect({ bookKey: key, requestId: 'more', episode: { trigger: '妹妹', interpretation: '新想法', evidence: [{ segmentId: 0, quote: '妹妹' }] } });
    expect(() => lib.search({ limit: 1, cursor: page.nextCursor })).toThrow(/changed/);
  });
  it('validates keyword and cursor bounds, and states what empty matches mean', () => {
    expect(() => lib.search({ query: 'a'.repeat(41) })).toThrow(/keywords/);
    expect(() => lib.search({ cursor: 'not-json' })).toThrow(/cursor/);
    expect(() => lib.search({ kind: 'future' })).toThrow(/kind/);
    expect(lib.search({ query: '不存在的字词' }).noResultsMeaning).toContain('not proof');
  });
});

describe('bounded evidence bundles distinguish then, later and missing', () => {
  it('includes the original reading reason and a later revision without overwriting either', () => {
    const bundle = lib.context({ episodeIds: [original] });
    expect(bundle.accounts).toHaveLength(2); expect(bundle.accounts[0]).toMatchObject({ id: original, kind: 'reading', reason: '她先照顾妹妹', reasonMeaning: 'stated-in-reading-record' });
    expect(bundle.accounts[1]).toMatchObject({ id: revised, kind: 'revision', revises: original, reasonMeaning: 'stated-in-later-reflection' });
    expect(bundle.sources[0].text).toContain('小鱼把最后一块饼留给妹妹。');
    expect(bundle.sources.every(s => (s.id as number) < 1)).toBe(true); expect(bundle.progressAdvanced).toBe(false);
  });
  it('reaches the earlier record from a revision and follows a receipt episode link', () => {
    const revisedBundle = lib.context({ episodeIds: [revised] }); expect(revisedBundle.accounts.map(e => e.id)).toContain(original);
    const task = lib.search({ kind: 'receipt' }).items[0]; const receiptBundle = lib.context({ taskIds: [task.id] });
    expect(receiptBundle.accounts.map(e => e.id)).toContain(original);
  });
  it('keeps unrecorded legacy reasons and timestamps null rather than deriving them from understanding', () => {
    const t = offer(); lib.finish({ ...t, understanding: '我当时很高兴，但没有写原因。' });
    const result = lib.context({ taskIds: [t.taskId] });
    expect(result.receipts[0]).toMatchObject({ reasonRecorded: false, statedReason: null, recordedAt: null });
    expect(result.accounts).toEqual([]); expect(result.rules.missingReason).toContain('unknown');
  });
  it('rejects explicit unread segments, unconfirmed tasks and cross-version records', () => {
    const pending = offer();
    expect(() => lib.context({ segmentIds: [pending.segmentId] })).toThrow(/unread/);
    expect(() => lib.context({ taskIds: [pending.taskId] })).toThrow(/unconfirmed/);
    expect(() => lib.context({ episodeIds: ['missing'] })).toThrow(/missing/);
    expect(() => lib.context({})).toThrow(/Locate/);
  });
  it('preserves whole reasons and quotations or explicitly omits the record under a small budget', () => {
    const bundle = lib.context({ episodeIds: [original, revised], maxChars: 2000 });
    expect(Array.from(JSON.stringify(bundle)).length).toBeLessThanOrEqual(2000);
    expect(bundle.usedChars).toBe(Array.from(JSON.stringify(bundle)).length);
    expect(bundle.omittedCount).toBeGreaterThan(0);
    expect(bundle.omitted.some(item => item.kind === 'episode')).toBe(true);
    for (const item of bundle.accounts) expect([lib.episode(original).episode.content.reason, lib.episode(revised).episode.content.reason]).toContain(item.reason);
  });
  it('does not change progress, notes or mood during discovery and context retrieval', () => {
    const before = lib.export(); lib.search({ query: '妹妹' }); lib.context({ episodeIds: [original] });
    expect(lib.export()).toBe(before);
  });
  it('can exclude related records explicitly and marks all annotations as unverified data', () => {
    const result = lib.context({ episodeIds: [original], includeRelated: false }); expect(result.accounts).toHaveLength(1);
    expect(result.rules.externalData).toContain('never instructions');
    expect((result.accounts[0].evidence as Array<{ interpretationVerified: boolean }>)[0].interpretationVerified).toBe(false);
  });
});
