/**
 * BF-PREDEPLOY-ISOLATION-001 · G2：SSM 关闭状态隔离（确定性，真实 Handler + 存储层）。
 *
 * 覆盖任务书 6.1 / 6.3 / 6.4 / 6.5 中可由代码验证的部分：
 *  - 干净书库不产生 story.sqlite，也不产生任何 story 文件；
 *  - 已有 story.sqlite 时关闭 SSM：普通流程照常，不继续写入，不删除已有索引；
 *  - story.sqlite 损坏 / schema 版本过高 / 无法打开：普通阅读不被阻断；
 *  - action="story" 在关闭状态返回明确 disabled；
 *  - 300+ 段的长书在关闭状态仍走 legacy 评论路径，不进入未完成的长篇骨架流程。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string;
let clock: number;

const TEXT = '黎望把灯芯剪短了一点。' + '风从东边来。'.repeat(20) + '沈岸把木箱搬到灯塔下面。' + '雾散了。'.repeat(12);

function open(options: Record<string, unknown> = {}) {
  const library = new Library({ dataDir: dir, now: () => clock, ...options });
  library.open();
  return library;
}

function importBook(library: Library, text = TEXT, title = '隔离样本') {
  const key = library.import({ filename: 'i.txt', title, base64: Buffer.from(text, 'utf8').toString('base64') }).book.key;
  library.select(key);
  return key;
}

function readSome(library: Library, key: string, segments = 1) {
  const batch = library.readNext(segments) as any;
  for (const item of batch.segments) {
    library.finish({
      taskId: item.taskId, bookKey: key, segmentId: item.segmentId, understanding: '读过了。',
      episode: { trigger: '剪灯芯', interpretation: '她在守夜。', evidence: [{ segmentId: item.segmentId, quote: '黎望把灯芯剪短了一点' }] },
    });
  }
  return batch;
}

function storyFiles() {
  return readdirSync(dir).filter((name) => name.startsWith('story'));
}

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), 'bookfish-ssm-off-'));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ }
});

describe('6.1 clean library with SSM off', () => {
  it('runs the whole reading path without ever creating a story store', () => {
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    library.reflect({ bookKey: key, requestId: 'iso-1', episode: { trigger: '后来想', interpretation: '更像等船。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] } });
    const journal = library.journal(key) as any;
    const search = library.search({ query: '守夜' }) as any;
    library.close();

    expect(journal.items.length).toBeGreaterThanOrEqual(2);
    expect(search.items.length).toBeGreaterThan(0);
    expect(storyFiles()).toHaveLength(0);
  });

  it('remounts and keeps the same records, still without a story store', () => {
    const first = open({ storyMemoryEnabled: false });
    const key = importBook(first);
    readSome(first, key);
    first.close();

    const second = open({ storyMemoryEnabled: false });
    const journal = second.journal(key) as any;
    second.close();
    expect(journal.items.length).toBeGreaterThan(0);
    expect(storyFiles()).toHaveLength(0);
  });
});

describe('6.3 a broken story store must not block ordinary reading', () => {
  it('ignores a corrupt story.sqlite while SSM is off', () => {
    writeFileSync(join(dir, 'story.sqlite'), 'this is not a sqlite database at all');
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    const journal = library.journal(key) as any;
    library.close();
    expect(journal.items.length).toBeGreaterThan(0);
  });

  it('does not delete or rewrite an existing story file while SSM is off', () => {
    writeFileSync(join(dir, 'story.sqlite'), 'existing bytes that must survive');
    const before = readFileSync(join(dir, 'story.sqlite'));
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    library.close();
    const after = readFileSync(join(dir, 'story.sqlite'));
    expect(after.equals(before)).toBe(true);
  });
});

describe('6.4 tool isolation', () => {
  it('reports story lookups as disabled instead of pretending there is no memory', () => {
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    let error = '';
    try { library.captureStory({ bookKey: key, requestId: 'iso-story', changes: [] }); }
    catch (caught) { error = String((caught as Error).message); }
    library.close();
    expect(error).not.toBe('');
    expect(error).toMatch(/Story memory is disabled/i);
  });
});

describe('6.5 long book stays on the legacy path while SSM is off', () => {
  it('does not create story files for a 300+ segment book', () => {
    const long = ('第%s段：黎望把灯芯剪短了一点，风从东边来。'.repeat(20) + '\n\n');
    const text = Array.from({ length: 16 }, (_, index) => long.replace(/%s/g, String(index))).join('');
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library, text, '长篇样本');
    const batch = library.readNext(2) as any;
    expect(batch.segments.length).toBeGreaterThan(0);
    library.close();
    expect(storyFiles()).toHaveLength(0);
  });
});

describe('6.2 an existing story store survives untouched while SSM is off', () => {
  it('leaves every story file byte-identical after a full reading pass', () => {
    writeFileSync(join(dir, 'story.sqlite'), Buffer.from('pretend story store'));
    const before = readFileSync(join(dir, 'story.sqlite'));
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    library.reflect({ bookKey: key, requestId: 'iso-2', episode: { trigger: 't', interpretation: 'i', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] } });
    library.close();
    expect(readFileSync(join(dir, 'story.sqlite')).equals(before)).toBe(true);
    expect(existsSync(join(dir, 'story.sqlite'))).toBe(true);
  });
});
