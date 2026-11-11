import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovelFetches, downloadTimeoutMsFor, type NovelEngineLike, type NovelImporter } from '../src/novel-fetch.ts';
import { assessNovelDownload, type CatalogChapter, type DownloadChapterFile } from '../src/novel-integrity.ts';
import type { NovelSearchCandidate } from '../src/novel-match.ts';
import type { NovelDownloadResult, NovelEngineAvailability } from '../src/novel-engine.ts';
import type { NovelPageProbe } from '../src/novel-probe.ts';

const dirs: string[] = [];
function workDir() { const dir = mkdtempSync(join(tmpdir(), 'bookfish-novel-')); dirs.push(dir); return dir; }
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const candidate: NovelSearchCandidate = {
  title: '海边的信', author: '小鱼', url: 'https://www.biquge365.net/book/1/',
  source: { id: 8, name: '笔趣阁365' }, revision: 'abcdef1234567890', latestChapter: '第3章', lastUpdateTime: '11-09',
};

function catalog(count = 3): CatalogChapter[] {
  return Array.from({ length: count }, (_, index) => ({ order: index + 1, title: `第${index + 1}章 海边来信`, url: `https://www.biquge365.net/chapter/1/${index + 1}.html` }));
}
function files(count = 3): DownloadChapterFile[] {
  return catalog(count).map((chapter) => ({ order: chapter.order, title: chapter.title, text: `${chapter.title}\n\n　　${'海风吹过码头，小鱼取出一封信。'.repeat(8)}\n` }));
}
function result(list = files()): NovelDownloadResult {
  return { taskDir: workDir(), downloadDir: join(tmpdir(), 'unused'), files: list, exitCode: 0, stderrTail: '' };
}

class FakeEngine implements NovelEngineLike {
  calls: string[] = [];
  catalogAfter: CatalogChapter[] | undefined;
  downloadFiles = files();
  downloadBlock?: Promise<void>;
  downloadDir = mkdtempSync(join(tmpdir(), 'bookfish-download-'));
  resumeWith?: string;
  onToc?: (call: number) => CatalogChapter[];
  availability(): NovelEngineAvailability { return { available: true, engineDir: '/engine', version: '1.12.0', bridge: 'package' }; }
  async search(_query: string, _options?: { onProgress?: (done: number, total: number, sourceId: number) => void }) { return [candidate]; }
  async toc(): Promise<CatalogChapter[]> {
    this.calls.push('toc');
    const count = this.calls.filter((call) => call === 'toc').length;
    return this.onToc ? this.onToc(count) : catalog();
  }
  async download(_candidate: NovelSearchCandidate, options?: { onDownloadDir?: (downloadDir: string) => void }): Promise<NovelDownloadResult> {
    this.calls.push('download');
    if (this.downloadBlock) await this.downloadBlock;
    options?.onDownloadDir?.(this.downloadDir);
    for (const file of this.downloadFiles) writeFileSync(join(this.downloadDir, `${file.order}_${file.title}.txt`), file.text, 'utf8');
    return { ...result(this.downloadFiles), downloadDir: this.downloadDir };
  }
  async resume(_candidate: NovelSearchCandidate, options: { downloadDir: string }): Promise<NovelDownloadResult> {
    this.calls.push('resume');
    this.resumeWith = options.downloadDir;
    for (const file of this.downloadFiles) writeFileSync(join(options.downloadDir, `${file.order}_${file.title}.txt`), file.text, 'utf8');
    return { ...result(this.downloadFiles), downloadDir: options.downloadDir };
  }
  preflight(identity: { title: string; author: string; sourceId: number; sourceName: string; bookUrl: string }, list: CatalogChapter[]) {
    return assessNovelDownload({ book: identity, catalog: list, files: [], catalogOnly: true });
  }
}

function setup(engine = new FakeEngine(), probe: NovelPageProbe | null = null) {
  const imported: string[] = [];
  const importer: NovelImporter = (_file, metadata) => {
    imported.push(metadata.filename);
    return { duplicate: false, book: { key: 'book-key', title: metadata.title, author: metadata.author, totalChars: 1000, identifiedChapters: 3 } };
  };
  const manager = new NovelFetches(engine, importer, { workDir: workDir(), pageProbe: probe });
  return { manager, engine, imported };
}

async function waitFor(manager: NovelFetches, id: string, states: string[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = manager.get(id);
    if (states.includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${states.join('/')}: ${manager.get(id).state}`);
}

describe('novel fetch task manager', () => {
  it('imports exactly once after every check passes', async () => {
    const { manager, imported } = setup();
    const start = manager.start(candidate);
    const done = await waitFor(manager, start.id, ['complete', 'failed']);
    expect(done.state).toBe('complete');
    expect(done.bookKey).toBe('book-key');
    expect(done.percent).toBe(100);
    expect(imported).toHaveLength(1);
  });

  it('does not import a download with a missing chapter', async () => {
    const engine = new FakeEngine(); engine.downloadFiles = files(2);
    const { manager, imported } = setup(engine);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('failed');
    expect(done.issues.map((issue) => issue.code)).toContain('missing_chapter');
    expect(imported).toHaveLength(0);
  });

  it('rejects a mixed catalog before downloading', async () => {
    const mixed = [...catalog(3), { order: 4, title: '第一章 另一个版本', url: 'https://www.biquge365.net/chapter/1/x.html' }];
    const engine = new FakeEngine(); engine.onToc = () => mixed;
    const { manager, imported } = setup(engine);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('failed');
    expect(done.issues.map((issue) => issue.code)).toContain('catalog_duplicate_number');
    expect(engine.calls).not.toContain('download');
    expect(imported).toHaveLength(0);
  });

  it('rejects a catalog that changes after download', async () => {
    const engine = new FakeEngine();
    engine.onToc = (call) => call === 1 ? catalog() : [...catalog(2), { order: 3, title: '第3章 新版本', url: 'https://www.biquge365.net/chapter/1/new.html' }];
    const { manager, imported } = setup(engine);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('failed');
    expect(done.issues.map((issue) => issue.code)).toContain('catalog_changed');
    expect(imported).toHaveLength(0);
  });

  it('scales the CLI download timeout with catalog length', () => {
    expect(downloadTimeoutMsFor(9)).toBe(30 * 60_000);
    expect(downloadTimeoutMsFor(3406)).toBeGreaterThan(50 * 60_000);
    expect(downloadTimeoutMsFor(3406)).toBeLessThan(60 * 60_000);
    expect(downloadTimeoutMsFor(100_000)).toBe(2 * 60 * 60_000);
  });

  it('treats an unavailable page probe as a warning, not a rejection', async () => {
    const probe: NovelPageProbe = { name: 'unavailable', probe: async () => [{ code: 'page_probe_unavailable', message: 'source timed out' }] };
    const { manager, imported } = setup(new FakeEngine(), probe);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('complete');
    expect(done.issueCount).toBe(0);
    expect(done.warningCount).toBeGreaterThan(0);
    expect(imported).toHaveLength(1);
  });

  it('does not import when the page probe finds a missing page', async () => {
    const probe: NovelPageProbe = { name: 'fake', probe: async () => [{ code: 'page_probe_missing_page', message: 'missing', chapter: 2 }] };
    const { manager, imported } = setup(new FakeEngine(), probe);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('failed');
    expect(done.issues.map((issue) => issue.code)).toContain('page_probe_missing_page');
    expect(imported).toHaveLength(0);
  });

  it('cancels a queued task without importing it', async () => {
    const engine = new FakeEngine(); let release!: () => void; engine.downloadBlock = new Promise<void>((resolve) => { release = resolve; });
    const { manager, imported } = setup(engine);
    const first = manager.start(candidate);
    const second = manager.start({ ...candidate, url: 'https://www.biquge365.net/book/2/', revision: 'fedcba0987654321' });
    expect(second.state).toBe('queued');
    const cancelled = manager.cancel(second.id);
    expect(cancelled.state).toBe('cancelled');
    release();
    const done = await waitFor(manager, first.id, ['complete', 'failed']);
    expect(done.state).toBe('complete');
    expect(manager.get(second.id).state).toBe('cancelled');
    expect(imported).toHaveLength(1);
  });

  it('accepts a long catalog with a few numbering typos and records warnings', async () => {
    const longCatalog: CatalogChapter[] = Array.from({ length: 100 }, (_, index) => {
      const order = index + 1;
      return { order, title: order === 50 ? '第49章 别名甲' : `第${order}章 测试章节${order}`, url: `https://www.biquge365.net/chapter/1/${order}.html` };
    });
    const longFiles: DownloadChapterFile[] = longCatalog.map((chapter) => ({ order: chapter.order, title: chapter.title, text: `${chapter.title}\n\n　　${'海风吹过码头，小鱼取出一封信。'.repeat(8)}\n` }));
    const engine = new FakeEngine(); engine.onToc = () => longCatalog; engine.downloadFiles = longFiles;
    const { manager, imported } = setup(engine);
    const done = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(done.state).toBe('complete');
    expect(done.warningCount).toBeGreaterThan(0);
    expect(done.issues).toEqual([]);
    expect(imported).toHaveLength(1);
  });

  it('resumes a partial download instead of starting over', async () => {
    const engine = new FakeEngine(); engine.downloadFiles = files(2);
    const { manager, imported } = setup(engine);
    const first = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(first.state).toBe('failed');
    const firstDir = engine.downloadDir;
    engine.downloadFiles = files(3);
    const second = manager.start(candidate);
    const done = await waitFor(manager, second.id, ['complete', 'failed']);
    expect(done.state).toBe('complete');
    expect(engine.calls).toContain('resume');
    expect(engine.resumeWith).toBe(firstDir);
    expect(imported).toHaveLength(1);
  });

  it('resumes from the persisted index after a manager restart', async () => {
    const work = workDir();
    const importer: NovelImporter = () => ({ duplicate: false, book: { key: 'book-key', title: '海边的信', author: '小鱼', totalChars: 1000, identifiedChapters: 3 } });
    const firstEngine = new FakeEngine(); firstEngine.downloadFiles = files(2);
    const first = new NovelFetches(firstEngine, importer, { workDir: work, pageProbe: null });
    expect((await waitFor(first, first.start(candidate).id, ['failed'])).state).toBe('failed');
    expect(first.status().resumable[0]?.title).toBe('海边的信');
    const secondEngine = new FakeEngine(); secondEngine.downloadFiles = files(3);
    const second = new NovelFetches(secondEngine, importer, { workDir: work, pageProbe: null });
    expect(second.status().resumable).toHaveLength(1);
    expect((await waitFor(second, second.start(candidate).id, ['complete'])).state).toBe('complete');
    expect(secondEngine.calls).toContain('resume');
    expect(secondEngine.resumeWith).toBe(firstEngine.downloadDir);
    expect(second.status().resumable).toHaveLength(0);
  });

  it('hides earlier failed attempts for the same title when another source is tried', async () => {
    const engine = new FakeEngine();
    engine.downloadFiles = files(2);
    const { manager } = setup(engine);
    const first = await waitFor(manager, manager.start(candidate).id, ['complete', 'failed']);
    expect(first.state).toBe('failed');
    engine.downloadFiles = files(3);
    const second = manager.start({ ...candidate, source: { id: 9, name: '第八中文网' }, url: 'https://www.d8zw.com/0/109/', revision: '1111111111111111' });
    const visible = manager.status().tasks.map((task) => task.id);
    expect(visible).toContain(second.id);
    expect(visible).not.toContain(first.id);
  });

  it('reports real per-source search progress and returns candidates', async () => {
    const engine = new FakeEngine();
    engine.search = async (_query: string, options?: { onProgress?: (done: number, total: number, sourceId: number) => void }) => {
      options?.onProgress?.(1, 2, 8);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return [candidate];
    };
    const { manager } = setup(engine);
    const started = manager.startSearch('海边的信', '小鱼');
    expect(started.state).toBe('searching');
    const midway = manager.searchStatus(started.id);
    expect(midway.completed).toBe(1);
    expect(midway.total).toBe(2);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = manager.searchStatus(started.id);
      if (status.state !== 'searching') {
        expect(status.state).toBe('complete');
        expect(status.completed).toBe(status.total);
        expect(status.candidates?.[0]?.title).toBe('海边的信');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('search job did not finish');
  });

  it('refuses unsupported sources and non-book URLs from the UI', () => {
    const { manager } = setup();
    expect(() => manager.start({ ...candidate, source: { id: 99, name: 'other' }, url: 'https://unknown.example/book/1/' })).toThrow(/not a supported book page/u);
    expect(() => manager.start({ ...candidate, url: 'https://www.biquge365.net/chapter/1/1.html' })).toThrow(/not a supported book page/u);
    expect(() => manager.start({ ...candidate, url: 'https://evil.example/book/1/' })).toThrow(/not a supported book page/u);
  });
});
