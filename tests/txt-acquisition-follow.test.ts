import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { TxtAcquisition } from '../src/txt-acquisition/acquisition.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { pickDownloadPages, rawFileUrl, registrableHost } from '../src/txt-acquisition/follow.ts';

const RESULT = 'https://novel.example.com/result';
const DOWNLOAD = 'https://novel.example.com/download/123';
const FILE = 'https://novel.example.com/files/凡人修仙传.txt';

const resultHtml = `<html><body>
  <a href="/login">登录后下载</a>
  <a href="/download/123">点击下载 TXT 全本</a>
  <a href="/other">相关推荐</a>
</body></html>`;
const downloadHtml = `<html><body><a href="/files/%E5%87%A1%E4%BA%BA%E4%BF%AE%E4%BB%99%E4%BC%A0.txt">凡人修仙传.txt</a></body></html>`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

async function fixture(options: { html?: Record<string, string>; follow?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-follow-'));
  const library = new Library({ dataDir: dir }); library.open();
  const cfg = { ...BOOKFISH_DEFAULTS, txtAcquisitionEnabled: true, allowNetwork: true, browserBridgeEnabled: false, browserDebugPort: 9333, browserFollowDownloadPage: options.follow !== false };
  const pages = options.html ?? { [RESULT]: resultHtml, [DOWNLOAD]: downloadHtml };
  const acq = new TxtAcquisition({
    dataDir: dir, library, cfg: () => cfg, resolve: async () => ['93.184.216.34'],
    pageLoader: async (url: string) => ({ html: pages[url] ?? '<html></html>', close: async () => undefined }),
  } as never);
  await acq.init();
  cleanup.push(async () => { await acq.stop(); library.close(); rmSync(dir, { recursive: true, force: true }); });
  return { acq };
}

describe('one-step download-page follow', () => {
  it('opens the download link and finds the file there', async () => {
    const { acq } = await fixture();
    const task = await acq.discover({ pageUrl: RESULT, title: '凡人修仙传' });
    expect(task.status).toBe('candidate_ready');
    expect(task.candidates).toHaveLength(1);
    expect(task.candidates?.[0]?.filename).toBe('凡人修仙传.txt');
    expect(task.candidates?.[0]?.host).toBe('novel.example.com');
  });

  it('reports no candidates when the follow step is turned off', async () => {
    const { acq } = await fixture({ follow: false });
    const task = await acq.discover({ pageUrl: RESULT, title: '凡人修仙传' });
    expect(task.status).toBe('failed_recoverable');
    expect(task.failure?.code).toBe('no_candidates');
  });

  it('prefers same-site download links and skips login or direct-file links', () => {
    const html = `<html><body>
      <a href="/login">请先登录下载</a>
      <a href="https://cdn.other.example/book.txt">book.txt</a>
      <a href="https://mirror.example.net/download">下载全本 TXT</a>
      <a href="/download/1">下载 TXT 全本</a>
      <a href="/download/2">下载 EPUB</a>
    </body></html>`;
    const picked = pickDownloadPages(html, 'https://novel.example.com/a/b');
    expect(picked.map((item) => item.url)).toEqual([
      'https://novel.example.com/download/1',
      'https://novel.example.com/download/2',
      'https://mirror.example.net/download',
    ]);
    expect(picked.filter((item) => item.sameSite).map((item) => item.url)).toContain('https://novel.example.com/download/1');
  });

  it('treats a GitHub blob page as the raw file and stops at three pages', () => {
    expect(rawFileUrl('https://github.com/o/r/blob/main/books/凡人修仙传.txt')).toBe('https://raw.githubusercontent.com/o/r/main/books/%E5%87%A1%E4%BA%BA%E4%BF%AE%E4%BB%99%E4%BC%A0.txt');
    expect(rawFileUrl('https://github.com/o/r/tree/main/books')).toBeUndefined();
    expect(registrableHost('zhidao.baidu.com')).toBe('baidu.com');
    expect(registrableHost('books.example.com.cn')).toBe('example.com.cn');
    const many = Array.from({ length: 6 }, (_v, index) => `<a href="/download/${index}">下载 TXT</a>`).join('');
    expect(pickDownloadPages(`<html><body>${many}</body></html>`, RESULT)).toHaveLength(3);
  });
});
