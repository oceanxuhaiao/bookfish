/**
 * 阶段 4 / D8：行为正确性的**数据层**验收。
 *
 * 模型回答质量无法从已有日志恢复（未保存正文），但"数据本身是否足以区分
 * 当时/后来/修订/不存在"是可以在离线确定性验证的——这正是 C 方案的前提。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../../src/library.ts';

let dir: string;
let library: Library;
let bookKey: string;
let clock = 1_000_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-behavior-'));
  library = new Library({ dataDir: dir, now: () => clock });
  library.open();
  const text = '风从东边来。'.repeat(20) + '黎望把灯芯剪短了一点。' + '潮水退下去。'.repeat(20);
  const book = library.import({ filename: 'b.txt', title: '行为夹具', base64: Buffer.from(text, 'utf8').toString('base64') }).book;
  bookKey = book.key;
  library.select(bookKey);
});
afterEach(() => {
  library.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ }
});

function confirmOne(withEpisode?: { quote: string; trigger: string; interpretation: string }) {
  const batch = library.readNext(1);
  const item = batch.segments![0];
  const result: any = library.finish({
    taskId: item.taskId, bookKey, segmentId: item.segmentId, understanding: '黎望在雾里守着灯。',
    ...(withEpisode ? { episode: { ...withEpisode, evidence: [{ segmentId: item.segmentId, quote: withEpisode.quote }] } } : {}),
  } as any);
  return { item, result };
}

describe('retrieval data distinguishes record provenance', () => {
  it('case A: a reading-time record is labelled kind=reading with its own time', () => {
    confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她不是在等人，是在守夜。' });
    const search = library.search({ query: '守夜' }) as any;
    const hit = search.items.find((item: any) => item.kind === 'episode');
    expect(hit).toBeTruthy();
    expect(hit.episodeKind).toBe('reading');
    expect(typeof hit.recordedAt).toBe('string');
    expect(hit.revises).toBeNull();
    const context = library.context({ episodeIds: [hit.id] }) as any;
    const account = context.accounts[0];
    expect(account.kind).toBe('reading');
    expect(account.reasonMeaning).toBe('stated-in-reading-record');
    expect(account.evidence.length).toBeGreaterThan(0);
  });

  it('case B: a later reflection is kind=reflection, linked by revises, with its own time', () => {
    const { result } = confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她不是在等人，是在守夜。' });
    const readingEpisodeId = (library.journal(bookKey) as any).items[0].id;
    clock += 60_000;
    const reflected = library.reflect({
      bookKey, requestId: 'reflection-1',
      episode: { trigger: '隔了几天再想', interpretation: '守夜其实也是给自己留一个位置。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] },
    }) as any;
    const context = library.context({ episodeIds: [(reflected.episode ?? reflected).id] }) as any;
    const account = context.accounts.find((entry: any) => entry.id === (reflected.episode ?? reflected).id);
    expect(account.kind).toBe('reflection');
    expect(account.revises).toBeNull();
    expect(account.reasonMeaning).toBe('stated-in-later-reflection');
    // 被修订的那条仍然能被看到，并且不是它的替身。
    const original = library.context({ episodeIds: [readingEpisodeId] }) as any;
    expect(original.accounts[0].kind).toBe('reading');
    expect(original.accounts[0].revisions).not.toContain((reflected.episode ?? reflected).id);
  });

  it('case C: a revision is labelled kind=revision and still points at the old record', () => {
    const { result } = confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她在守夜。' });
    const base = (library.journal(bookKey) as any).items[0].id;
    clock += 60_000;
    const revised = library.reflect({
      bookKey, requestId: 'revision-1', revises: base,
      episode: { trigger: '回头改判', interpretation: '不是守夜，是在等一艘不会来的船。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] },
    }) as any;
    const context = library.context({ episodeIds: [(revised.episode ?? revised).id] }) as any;
    const account = context.accounts.find((entry: any) => entry.id === (revised.episode ?? revised).id);
    expect(account.kind).toBe('revision');
    expect(account.revises).toBe(base);
  });

  it('case D: no record exists — search returns zero and says it is not proof of absence', () => {
    confirmOne();
    const search = library.search({ query: '根本不存在的词' }) as any;
    expect(search.items).toHaveLength(0);
    expect(search.noResultsMeaning).toMatch(/not proof/i);
    expect(search.nextStep).toBeUndefined();
  });

  it('case E: old and new can be compared in one context call without losing either', () => {
    const { result } = confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她在守夜。' });
    const base = (library.journal(bookKey) as any).items[0].id;
    clock += 60_000;
    const later = library.reflect({
      bookKey, requestId: 'reflection-2',
      episode: { trigger: '再读一遍', interpretation: '守夜的人也需要有人记得她。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] },
    }) as any;
    const context = library.context({ episodeIds: [base, (later.episode ?? later).id] }) as any;
    const kinds = context.accounts.map((entry: any) => entry.kind).sort();
    expect(kinds).toEqual(['reading', 'reflection']);
    const times = context.accounts.map((entry: any) => entry.recordedAt);
    expect(new Set(times).size).toBe(2);
  });

  it('search tells the caller how to use the ids it just returned', () => {
    confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她在守夜。' });
    const search = library.search({ query: '守夜' }) as any;
    expect(search.nextStep).toMatch(/bookfish_lookup\(action="context"/);
    expect(search.nextStep).toMatch(/kind/);
    expect(search.nextStep).not.toMatch(/bookfish_help/);
  });
});

describe('retrieval errors are actionable without a protocol pointer', () => {
  it('context explains which ids it needs and where they come from', () => {
    let error = '';
    try { library.context({}); } catch (caught) { error = String((caught as Error).message); }
    expect(error).toMatch(/episodeIds/);
    expect(error).toMatch(/taskIds/);
    expect(error).toMatch(/segmentIds/);
    expect(error).toMatch(/search/);
    expect(error).toMatch(/Example:/);
    expect(error).not.toMatch(/bookfish_help/);
  });

  it('journal evidence errors give the required shape instead of a pointer', () => {
    const batch = library.readNext(1);
    const item = batch.segments![0];
    let error = '';
    try {
      library.finish({ taskId: item.taskId, bookKey, segmentId: item.segmentId, understanding: '', episode: {
        trigger: 't', interpretation: 'i', evidence: [{ segmentId: item.segmentId, quote: '' }],
      } } as any);
    } catch (caught) { error = String((caught as Error).message); }
    expect(error).toMatch(/Required shape/);
    expect(error).toMatch(/segmentId/);
    expect(error).not.toMatch(/bookfish_help/);
  });
});
describe('retrieval hints that do not cost anything on the normal path', () => {
  it('explains a zero result under a character filter instead of implying absence', () => {
    confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她在守夜。' });
    const filtered = library.search({ query: '守夜', character: '完全不存在的名字' }) as any;
    expect(filtered.total).toBe(0);
    expect(filtered.boundaryHint).toMatch(/did not match any saved record/);
    expect(filtered.boundaryHint).toMatch(/does not mean nothing was recorded/);
    expect(filtered.boundaryHint).not.toMatch(/journal|try another|Drop the character/i);
    const plainMiss = library.search({ query: '一点都不存在的词' }) as any;
    expect(plainMiss.total).toBe(0);
    expect(plainMiss.boundaryHint).toMatch(/does not mean nothing was recorded/);
    // 正常命中时不应出现这条提示（不增加常规成本）。
    const normal = library.search({ query: '守夜' }) as any;
    expect(normal.total).toBeGreaterThan(0);
    expect(normal.boundaryHint).toBeUndefined();
  });

  it('marks a record that was later revised and says what to tell the user', () => {
    const { result } = confirmOne({ quote: '黎望把灯芯剪短了一点', trigger: '她剪灯芯的动作', interpretation: '她在守夜。' });
    const base = (library.journal(bookKey) as any).items[0].id;
    clock += 60_000;
    const revised = library.reflect({
      bookKey, requestId: 'revision-mark', revises: base,
      episode: { trigger: '回头改判', interpretation: '不是守夜，是在等一艘不会来的船。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] },
    }) as any;
    const context = library.context({ episodeIds: [base] }) as any;
    const account = context.accounts.find((entry: any) => entry.id === base);
    expect(account.superseded).toBe(true);
    expect(account.supersededNote).toMatch(/later revised by/);
    expect(account.supersededNote).toMatch(/say that the view changed/);
    // 修订后的那条自己不该被标记为已被取代。
    const newer = library.context({ episodeIds: [(revised.episode ?? revised).id] }) as any;
    expect(newer.accounts[0].superseded).toBeUndefined();
    expect(result).toBeTruthy();
  });
});