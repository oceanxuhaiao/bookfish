import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOKFISH_DEFAULTS, type BookfishConfigSection } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { TxtAcquisition, type PageLoader } from '../src/txt-acquisition/acquisition.ts';
import type { HostResolver } from '../src/txt-acquisition/url-policy.ts';

const PAGE = 'https://files.example.com/book/123';
const TXT_LINK = 'https://files.example.com/dl/hai.txt';
const MD_LINK = 'https://files.example.com/dl/hai-full.md';

const BODY = '她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。';
function chapter(number: number, body = BODY): string {
  return `第${number}章 海风\n\n　　${body.repeat(14)}\n`;
}
function novel(chapters = 5, skip?: number): string {
  return Array.from({ length: chapters }, (_, index) => index + 1)
    .filter((number) => number !== skip)
    .map((number) => chapter(number))
    .join('\n');
}

let dir: string;
let library: Library;
let cfg: BookfishConfigSection;
let imported: Array<{ taskId: string; bookKey?: string; identity: string }>;

/** Everything resolves to a public address; nothing here touches the network. */
const resolve: HostResolver = async () => ['93.184.216.34'];

const pageLoader: PageLoader = async () => ({
  html: `<html><body>
    <a href="/dl/hai.txt">《海风》 作者：小鱼</a>
    <a href="${MD_LINK}">海风 全本</a>
    <a href="/about.html">关于</a>
  </body></html>`,
  close: async () => undefined,
});

function textResponse(text: string, type = 'text/plain'): typeof fetch {
  return (async () => new Response(new Uint8Array(Buffer.from(text, 'utf8')), { status: 200, headers: { 'content-type': type } })) as typeof fetch;
}

function make(fetchImpl: typeof fetch = textResponse(novel())): TxtAcquisition {
  return new TxtAcquisition({
    dataDir: dir,
    library,
    cfg: () => cfg,
    resolve,
    pageLoader,
    fetchImpl,
    onImported: (task, identity) => { imported.push({ taskId: task.id, ...(task.bookKey ? { bookKey: task.bookKey } : {}), identity }); },
  });
}

function rawFiles(): string[] {
  const raw = join(dir, 'bookfish', 'txt-acquisition', 'raw');
  return existsSync(raw) ? readdirSync(raw) : [];
}

function textOf(key: string): string {
  const chunks: string[] = [];
  let segment: number | null = 0;
  while (segment !== null && chunks.length < 4000) {
    const page = library.reader({ bookKey: key, segment }) as { segments: Array<{ text: string }>; next: number | null };
    chunks.push(...page.segments.map((entry) => entry.text));
    segment = page.next;
  }
  return chunks.join('');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-acquisition-'));
  library = new Library({ dataDir: dir });
  library.open();
  cfg = { ...BOOKFISH_DEFAULTS, txtAcquisitionEnabled: true, browserDebugPort: 9333 };
  imported = [];
});
afterEach(() => {
  library.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('browser-assisted acquisition flow', () => {
  it('discovers TXT and Markdown candidates and keeps only digests on disk', async () => {
    const acquisition = make();
    await acquisition.init();
    const task = await acquisition.discover({ pageUrl: PAGE, title: '海风', author: '小鱼' });
    expect(task.status).toBe('candidate_ready');
    expect((task.candidates ?? []).map((candidate) => candidate.filename)).toEqual(['hai.txt', 'hai-full.md']);
    expect((task.candidates ?? []).every((candidate) => candidate.available)).toBe(true);
    const stored = readFileSync(join(dir, 'bookfish', 'txt-acquisition', 'tasks.json'), 'utf8');
    expect(stored).not.toContain('/dl/hai.txt');
    expect(stored).not.toContain('/dl/hai-full.md');
    expect(stored).toContain(PAGE);
  });

  it('downloads a candidate, imports it and drops the clean original', async () => {
    const acquisition = make();
    await acquisition.init();
    const found = await acquisition.discover({ pageUrl: PAGE, title: '海风', author: '小鱼' });
    const candidateId = (found.candidates ?? [])[0]!.candidateId;
    const done = await acquisition.importFile({ taskId: found.taskId, candidateId });
    expect(done.status).toBe('completed');
    expect(done.quality?.quality).toBe('clean');
    expect(done.bookKey).toBeTruthy();
    expect(textOf(done.bookKey!)).toContain('她把信折好');
    expect(rawFiles()).toEqual([]);
    expect(imported.map((entry) => entry.identity)).toEqual(['exact']);
  });

  it('keeps the original bytes when the copy has warnings, and still lets it be read', async () => {
    const acquisition = make(textResponse(novel(6, 3)));
    await acquisition.init();
    const done = await acquisition.importFile({ url: TXT_LINK, title: '海风', author: '小鱼' });
    expect(done.status).toBe('completed_with_warning');
    expect(done.quality?.warnings.map((warning) => warning.code)).toContain('chapters_missing');
    expect(done.file?.retained).toBe(true);
    expect(rawFiles()).toHaveLength(1);
    expect(textOf(done.bookKey!)).toContain('第5章');
    expect(await acquisition.prune()).toEqual([]);
    expect(rawFiles()).toHaveLength(1);
  });

  it('retries a recoverable download failure without duplicating the task', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(new Uint8Array(Buffer.from(novel(), 'utf8')), { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const acquisition = make(flaky);
    await acquisition.init();
    const found = await acquisition.discover({ pageUrl: PAGE, title: '海风', author: '小鱼' });
    const failed = await acquisition.importFile({ taskId: found.taskId, candidateId: (found.candidates ?? [])[0]!.candidateId });
    expect(failed.status).toBe('failed_recoverable');
    expect(failed.failure?.recoverable).toBe(true);
    expect(failed.file).toBeUndefined();

    const task = await acquisition.retry(found.taskId);
    expect(task.taskId).toBe(found.taskId);
    expect(task.status).toBe('completed');
    expect(acquisition.records.get(found.taskId)!.attempts.downloads).toBe(2);
    expect(acquisition.list()).toHaveLength(1);
  });

  it('marks interrupted work recoverable after a restart and keeps the page for rediscovery', async () => {
    const acquisition = make();
    await acquisition.init();
    const found = await acquisition.discover({ pageUrl: PAGE, title: '海风' });
    expect(found.status).toBe('candidate_ready');

    const restarted = make();
    await restarted.init();
    const task = restarted.status(found.taskId) as { status: string; failure?: { code: string }; pageUrl?: string };
    expect(task.status).toBe('failed_recoverable');
    expect(task.failure?.code).toBe('restart_interrupted');
    expect(task.pageUrl).toBe(PAGE);
    const again = await restarted.retry(found.taskId);
    expect(again.status).toBe('candidate_ready');
  });

  it('cancels a pending task, keeps it recoverable and leaves no partial file', async () => {
    const acquisition = make();
    await acquisition.init();
    const found = await acquisition.discover({ pageUrl: PAGE, title: '海风' });
    const cancelled = acquisition.cancel(found.taskId);
    expect(cancelled.status).toBe('failed_recoverable');
    expect(cancelled.failure?.code).toBe('cancelled');
    expect(cancelled.nextActions).toContain('discover again');
    const work = join(dir, 'bookfish', 'txt-acquisition', 'work');
    expect(existsSync(work) ? readdirSync(work).filter((name) => name.endsWith('.part')) : []).toEqual([]);
    const again = await acquisition.retry(found.taskId);
    expect(again.taskId).toBe(found.taskId);
    expect(again.status).toBe('candidate_ready');
  });

  it('repairs a damaged file into a new revision without touching the first one', async () => {
    const mixed = Buffer.concat([Buffer.from(novel(3), 'utf8'), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(chapter(4), 'utf8')]);
    const acquisition = make((async () => new Response(new Uint8Array(mixed), { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch);
    await acquisition.init();
    const first = await acquisition.importFile({ url: TXT_LINK, title: '海风', author: '小鱼' });
    expect(['completed', 'completed_with_warning']).toContain(first.status);
    const before = library.list().length;
    const repaired = await acquisition.repair(first.taskId, 'utf-8');
    expect(repaired.status).toMatch(/^completed/);
    expect(repaired.bookKey).toBeTruthy();
    if (repaired.bookKey !== first.bookKey) {
      expect(library.list()).toHaveLength(before + 1);
      const old = library.list().find((entry) => entry.key === first.bookKey)!;
      expect(old.confirmedChars ?? 0).toBe(0);
    }
    expect(rawFiles().length).toBeLessThanOrEqual(1);
  });

  it('does not import the same file twice as two books', async () => {
    const acquisition = make();
    await acquisition.init();
    const first = await acquisition.importFile({ url: TXT_LINK, title: '海风', author: '小鱼' });
    const second = await acquisition.importFile({ url: TXT_LINK, title: '海风', author: '小鱼' });
    expect(second.bookKey).toBe(first.bookKey);
    expect(second.duplicate).toBe(true);
    expect(library.list()).toHaveLength(1);
    expect(acquisition.list()).toHaveLength(2);
  });

  it('refuses to touch the network when the world has network access disabled', async () => {
    cfg = { ...cfg, allowNetwork: false };
    const acquisition = make();
    await acquisition.init();
    await expect(acquisition.discover({ pageUrl: PAGE, title: '海风' })).rejects.toThrow(/network access is disabled/iu);
    expect(acquisition.list()).toEqual([]);
  });

  it('requires an explicit browser debug port instead of probing for one', async () => {
    cfg = { ...cfg, browserDebugPort: 0 };
    const acquisition = make();
    await acquisition.init();
    const task = await acquisition.discover({ pageUrl: PAGE, title: '海风' });
    expect(task.status).toBe('failed_terminal');
    expect(task.failure?.code).toBe('browser_unavailable');
    expect(task.failure?.recoverable).toBe(false);
  });

  it('keeps the original bytes when the file is not a book, so it can be retried later', async () => {
    const login = '请先登录后再下载，输入验证码继续。\n'.repeat(40);
    const acquisition = make(textResponse(login));
    await acquisition.init();
    const failed = await acquisition.importFile({ url: TXT_LINK, title: '海风', author: '小鱼' });
    expect(failed.status).toMatch(/^failed_/u);
    expect(failed.rejection?.code).toBe('not_a_book');
    expect(failed.file?.retained).toBe(true);
    expect(rawFiles()).toHaveLength(1);
    expect(library.list()).toHaveLength(0);

    const again = await acquisition.retry(failed.taskId);
    expect(again.taskId).toBe(failed.taskId);
    expect(again.status).toMatch(/^failed_/u);
    expect(rawFiles()).toHaveLength(1);
    expect(acquisition.list()).toHaveLength(1);
  });
});




