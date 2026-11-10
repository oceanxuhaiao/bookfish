import { describe, expect, it } from 'vitest';
import { SourcePageProbe, type ProbeHttp } from '../src/novel-probe.ts';
import { SourceError } from '../src/source-types.ts';
import type { NovelSourceSpec } from '../src/novel-sources.ts';

const LONG = '海风吹过码头，小鱼从邮筒里取出一封信。信封上的字迹很熟悉，她坐在石阶上读完了第一行。'.repeat(12);
const SECOND = '天色渐暗，邻居端着热汤推开门。两个人谈起明天的集市，决定把修好的木船重新放回水里。'.repeat(12);

const source: NovelSourceSpec = {
  id: 8, name: '笔趣阁365', host: 'www.biquge365.net', bookPath: /^\/book\/\d+\/$/u,
  probe: { content: '#txt', nextText: /^(下一页|下一頁|下页|下頁)$/iu },
};

function page(body: string, next?: string): string {
  return `<html><body><div id="neirong"><h1>第一章</h1></div><div id="txt">${body}</div>${next ? `<a href="${next}">下一页</a>` : ''}</body></html>`;
}

function fake(map: Record<string, string | Error>): ProbeHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      const value = map[url];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new SourceError('missing', 'not found');
      return { url, html: value };
    },
  };
}

const catalog = [{ order: 1, title: '第一章 海边来信', url: 'https://www.biquge365.net/chapter/1/1.html' }];
function file(text: string) {
  return [{ order: 1, title: '第一章 海边来信', text: `第一章 海边来信\n\n　　${text}\n` }];
}

describe('per-source page probe', () => {
  it('accepts a paginated chapter only when every source page is present', async () => {
    const http = fake({
      'https://www.biquge365.net/chapter/1/1.html': page(LONG, '1_2.html'),
      'https://www.biquge365.net/chapter/1/1_2.html': page(SECOND),
    });
    const probe = new SourcePageProbe(() => http);
    expect(await probe.probe(source, catalog, file(LONG + SECOND))).toEqual([]);
    expect(http.calls).toHaveLength(2);
  });

  it('detects a missing second page even when the first page looks complete', async () => {
    const http = fake({
      'https://www.biquge365.net/chapter/1/1.html': page(LONG, '1_2.html'),
      'https://www.biquge365.net/chapter/1/1_2.html': page(SECOND),
    });
    const issues = await new SourcePageProbe(() => http).probe(source, catalog, file(LONG));
    expect(issues.map((issue) => issue.code)).toContain('page_probe_missing_page');
  });

  it('detects a body materially shorter than a single source page', async () => {
    const http = fake({ 'https://www.biquge365.net/chapter/1/1.html': page(LONG + SECOND) });
    const full = LONG + SECOND;
    const issues = await new SourcePageProbe(() => http).probe(source, catalog, file(full.slice(0, Math.floor(full.length * 0.8))));
    expect(issues.map((issue) => issue.code)).toContain('page_probe_short');
  });

  it('fails closed when the source page cannot be read', async () => {
    const http = fake({ 'https://www.biquge365.net/chapter/1/1.html': new SourceError('temporary', 'network down') });
    const issues = await new SourcePageProbe(() => http).probe(source, catalog, file(LONG));
    expect(issues.map((issue) => issue.code)).toContain('page_probe_unavailable');
  });

  it('follows a page-2 link even when the site labels it 下一章', async () => {
    const http = fake({
      'https://www.biquge365.net/chapter/1/1.html': `<html><body><div id="txt">${LONG}<br>第(1/2)页</div><a href="1_2.html">下一章</a></body></html>`,
      'https://www.biquge365.net/chapter/1/1_2.html': `<html><body><div id="txt">${SECOND}<br>第(2/2)页</div></body></html>`,
    });
    const issues = await new SourcePageProbe(() => http).probe(source, catalog, file(LONG));
    expect(issues.map((issue) => issue.code)).toContain('page_probe_missing_page');
    expect(http.calls).toHaveLength(2);
  });

  it('does not silently accept a next page whose fetch fails', async () => {
    const http = fake({
      'https://www.biquge365.net/chapter/1/1.html': page(LONG, '1_2.html'),
      'https://www.biquge365.net/chapter/1/1_2.html': new SourceError('temporary', 'next page failed'),
    });
    const issues = await new SourcePageProbe(() => http).probe(source, catalog, file(LONG + SECOND));
    expect(issues.map((issue) => issue.code)).toContain('page_probe_unavailable');
  });

  it('skips sources marked without a page probe instead of guessing', async () => {
    const noProbe = { ...source, probe: null };
    const probe = new SourcePageProbe(() => fake({}));
    expect(await probe.probe(noProbe, catalog, file(LONG))).toEqual([]);
  });
});
