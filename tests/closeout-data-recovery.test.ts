/**
 * BF-R2-CLOSEOUT-001 · 工作流 C：格式恢复、9 点故障注入、quick_check、恢复中断。
 * 全部使用临时隔离目录；使用公开 API writeArchive / restoreArchive。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let root: string;
let clock = 1_000_000;

const TEXT = '第一章 雾港。\n\n' + '风从东边来。'.repeat(20) + '\n\n黎望把灯芯剪短了一点。\n\n' + '沈岸把木箱搬到灯塔下面。'.repeat(12);

function openAt(dir: string, options: Record<string, unknown> = {}) {
  const library = new Library({ dataDir: dir, now: () => clock, ...options });
  library.open();
  return library;
}

/** 建一本书；read=true 时确认一段并写一条手账。 */
function seed(dir: string, options: Record<string, unknown>, withHistory: boolean) {
  const library = openAt(dir, options);
  const book = library.import({ filename: 'c.txt', title: '收尾样本', base64: Buffer.from(TEXT, 'utf8').toString('base64') }).book;
  library.select(book.key);
  if (withHistory) {
    const batch = library.readNext(1) as any;
    const item = batch.segments[0];
    library.finish({ taskId: item.taskId, bookKey: book.key, segmentId: item.segmentId, understanding: '读过了。',
      episode: { trigger: '剪灯芯', interpretation: '她在守夜。', evidence: [{ segmentId: item.segmentId, quote: '黎望把灯芯剪短了一点' }] } });
  }
  library.close();
  return book.key;
}

function survey(dir: string, options: Record<string, unknown> = {}) {
  const library = openAt(dir, options);
  const list = library.list() as any[];
  const key = list[0]?.key ?? null;
  const status = key ? (library.status() as any) : null;
  const journal = key ? (library.journal(key) as any).items.length : 0;
  library.close();
  return { books: list.length, frontier: status?.current?.frontier ?? null, journal };
}

beforeEach(() => { clock += 1000; root = mkdtempSync(join(tmpdir(), 'bookfish-closeout-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 }); } catch { /* 句柄 */ } });

describe('C1/C2 真实导出器产生的 BOOKFISH2/3/5 归档', () => {
  it('BOOKFISH2 (books only) restores the book but carries no history', () => {
    const source = join(root, 'src2'); mkdirSync(source, { recursive: true });
    seed(source, { storyMemoryEnabled: false }, false);
    const library = openAt(source, { storyMemoryEnabled: false });
    const file = join(root, 'b2.bfbak');
    (library as any).bookStorage.writeArchive(file, (library as any).state);
    library.close();
    expect(readFileSync(file, 'utf8').startsWith('BOOKFISH2\n')).toBe(true);

    const target = join(root, 'dst2'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target, { storyMemoryEnabled: false });
    fresh.restoreArchive(file);
    fresh.close();
    const after = survey(target);
    expect(after.books).toBe(1);
    expect(after.journal).toBe(0);
  });

  it('BOOKFISH3 (books + history) restores journal records', () => {
    const source = join(root, 'src3'); mkdirSync(source, { recursive: true });
    seed(source, { storyMemoryEnabled: false }, true);
    const library = openAt(source, { storyMemoryEnabled: false });
    const file = join(root, 'b3.bfbak');
    library.writeArchive(file);
    library.close();
    expect(readFileSync(file, 'utf8').startsWith('BOOKFISH3\n')).toBe(true);

    const target = join(root, 'dst3'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target, { storyMemoryEnabled: false });
    fresh.restoreArchive(file);
    fresh.close();
    const after = survey(target);
    expect(after.books).toBe(1);
    expect(after.journal).toBeGreaterThanOrEqual(1);
  });

  it('BOOKFISH5 (books + history + story) restores with story memory enabled', () => {
    const source = join(root, 'src5'); mkdirSync(source, { recursive: true });
    seed(source, { storyMemoryEnabled: true }, true);
    const library = openAt(source, { storyMemoryEnabled: true });
    const file = join(root, 'b5.bfbak');
    library.writeArchive(file);
    library.close();
    expect(readFileSync(file, 'utf8').startsWith('BOOKFISH5\n')).toBe(true);

    const target = join(root, 'dst5'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target, { storyMemoryEnabled: true });
    fresh.restoreArchive(file);
    fresh.close();
    expect(survey(target, { storyMemoryEnabled: true }).journal).toBeGreaterThanOrEqual(1);
  });

  it('refuses a BOOKFISH5 archive when story memory is off, instead of dropping the story section', () => {
    const source = join(root, 'srcr'); mkdirSync(source, { recursive: true });
    seed(source, { storyMemoryEnabled: true }, true);
    const library = openAt(source, { storyMemoryEnabled: true });
    const file = join(root, 'b5r.bfbak');
    library.writeArchive(file);
    library.close();

    const target = join(root, 'dstr'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target, { storyMemoryEnabled: false });
    expect(() => fresh.restoreArchive(file)).toThrow(/故事记忆|story memory/i);
    fresh.close();
    expect(survey(target).books).toBe(0);
  });
});

describe('C3 九个恢复故障注入点', () => {
  for (const stage of ['preflight', 'before-books', 'after-books', 'before-history', 'after-history', 'before-story', 'after-story', 'before-commit', 'after-commit'] as const) {
    it(`injects at ${stage} and keeps the target library consistent`, () => {
      const source = join(root, `s-${stage}`); mkdirSync(source, { recursive: true });
      seed(source, { storyMemoryEnabled: false }, true);
      const library = openAt(source, { storyMemoryEnabled: false });
      const file = join(root, `p-${stage}.bfbak`);
      library.writeArchive(file);
      library.close();
      const backup = readFileSync(file);

      const target = join(root, `d-${stage}`); mkdirSync(target, { recursive: true });
      const fresh = openAt(target, { storyMemoryEnabled: false });
      let threw = false;
      try { fresh.restoreArchive(file, { onStage: (seen) => { if (seen === stage) throw new Error(`injected ${stage}`); } }); }
      catch { threw = true; }
      fresh.close();

      if (stage === 'after-commit') expect(threw).toBe(false);
      else expect(threw).toBe(true);

      const after = survey(target);
      if (stage === 'after-commit') expect(after.books).toBe(1);
      else expect(after.books).toBe(0);
      expect(readFileSync(file).equals(backup)).toBe(true);
    });
  }
});

describe('C4 SQLite quick_check 与损坏处理', () => {
  it('a corrupted history database is reported, not silently emptied', () => {
    const dir = join(root, 'qc'); mkdirSync(dir, { recursive: true });
    seed(dir, { storyMemoryEnabled: false }, true);
    const historyFile = join(dir, 'bookfish', 'history.sqlite');
    expect(existsSync(historyFile)).toBe(true);
    const bytes = readFileSync(historyFile);
    bytes.write('NOT-A-SQLITE-DB', 0, 'utf8');
    writeFileSync(historyFile, bytes);

    let failed = false;
    try {
      const library = openAt(dir, { storyMemoryEnabled: false });
      const key = (library.list() as any[])[0]?.key;
      library.journal(key);
      library.close();
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(readFileSync(historyFile).length).toBe(bytes.length);
  });
});

describe('C5 恢复中断与重试', () => {
  it('a pre-commit failure keeps the old library readable and the restore retryable', () => {
    const dir = join(root, 'interrupt'); mkdirSync(dir, { recursive: true });
    seed(dir, { storyMemoryEnabled: false }, true);
    const before = survey(dir);
    const library = openAt(dir, { storyMemoryEnabled: false });
    const file = join(root, 'i.bfbak');
    library.writeArchive(file);
    library.close();

    const target = join(root, 'interrupt-target'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target, { storyMemoryEnabled: false });
    expect(() => fresh.restoreArchive(file, { onStage: (seen) => { if (seen === 'before-commit') throw new Error('interrupted'); } })).toThrow(/interrupted/);
    fresh.close();

    // 源书库不受影响，目标目录没有半恢复书架
    expect(survey(dir)).toEqual(before);
    expect(survey(target).books).toBe(0);

    // 同一目标可安全重试
    const retry = openAt(target, { storyMemoryEnabled: false });
    retry.restoreArchive(file);
    retry.close();
    expect(survey(target).books).toBe(before.books);
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });

  it('leaves no restore temp files behind after a failed restore', () => {
    const dir = join(root, 'temps'); mkdirSync(dir, { recursive: true });
    seed(dir, { storyMemoryEnabled: false }, true);
    const library = openAt(dir, { storyMemoryEnabled: false });
    const file = join(root, 't.bfbak');
    library.writeArchive(file);
    library.close();
    const fresh = openAt(dir, { storyMemoryEnabled: false });
    try { fresh.restoreArchive(file, { onStage: (seen) => { if (seen === 'before-books') throw new Error('stop'); } }); } catch { /* 预期 */ }
    fresh.close();
    const leftovers = readdirSync(join(dir, 'bookfish')).filter((name) => name.endsWith('.tmp') || name.includes('restore'));
    expect(leftovers).toHaveLength(0);
  });
});
