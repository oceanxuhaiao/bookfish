import { describe, expect, it } from 'vitest';
import { checkUrl, hostOf, isBlockedAddress, isLoopbackWs, isPolicyError } from '../src/txt-acquisition/url-policy.ts';
import { discoverLinks, extractIdentity } from '../src/txt-acquisition/link-discovery.ts';

const publicDns = async (): Promise<string[]> => ['93.184.216.34'];
const privateDns = async (): Promise<string[]> => ['10.1.2.3'];

async function policyError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(isPolicyError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error('expected the URL policy to refuse this address');
}

describe('outbound URL policy', () => {
  it('accepts public http and https addresses and strips credentials', async () => {
    const url = await checkUrl('https://user:secret@example.com/books/a.txt?token=1#top', { allowNetwork: true, resolve: publicDns });
    expect(url.hostname).toBe('example.com');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.pathname).toBe('/books/a.txt');
    expect(hostOf(url.toString())).toBe('example.com');
    await expect(checkUrl('http://example.com/a.txt', { allowNetwork: true, resolve: publicDns })).resolves.toBeInstanceOf(URL);
  });

  it('refuses every non-HTTP protocol', async () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://example.com/a.txt', 'chrome://settings']) {
      const message = await policyError(checkUrl(raw, { allowNetwork: true, resolve: publicDns }));
      expect(message).toMatch(/Only http and https/);
    }
    await expect(policyError(checkUrl('not a url', { allowNetwork: true, resolve: publicDns }))).resolves.toMatch(/valid absolute/);
  });

  it('refuses loopback, private, link-local and metadata addresses given literally', async () => {
    for (const raw of ['http://127.0.0.1/a.txt', 'http://[::1]/a.txt', 'http://10.0.0.9/a.txt', 'http://192.168.1.4/a.txt',
      'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.200/a.txt', 'http://0.0.0.0/a.txt', 'http://224.0.0.1/a.txt']) {
      expect(await policyError(checkUrl(raw, { allowNetwork: true, resolve: publicDns }))).toMatch(/Refusing/);
    }
    for (const name of ['http://localhost:8080/a.txt', 'http://metadata.google.internal/a.txt', 'http://printer.lan/a.txt', 'http://intranet/a.txt']) {
      expect(await policyError(checkUrl(name, { allowNetwork: true, resolve: publicDns }))).toMatch(/Refusing/);
    }
  });

  it('refuses a public hostname when DNS answers with an internal address', async () => {
    expect(await policyError(checkUrl('https://looks-public.example/a.txt', { allowNetwork: true, resolve: privateDns })))
      .toMatch(/resolves to non-public/);
    // One bad answer among good ones is still a refusal.
    const mixed = async (): Promise<string[]> => ['93.184.216.34', '192.168.0.8'];
    expect(await policyError(checkUrl('https://mixed.example/a.txt', { allowNetwork: true, resolve: mixed }))).toMatch(/resolves to non-public/);
  });

  it('refuses to resolve anything when the world has no network permission', async () => {
    let called = false;
    const resolver = async (): Promise<string[]> => { called = true; return ['93.184.216.34']; };
    expect(await policyError(checkUrl('https://example.com/a.txt', { allowNetwork: false, resolve: resolver }))).toMatch(/Network access is disabled/);
    expect(called).toBe(false);
  });

  it('classifies address ranges with ipaddr.js', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::1')).toBe(true);
    expect(isBlockedAddress('198.18.0.1')).toBe(true);
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2400:3200::1')).toBe(false);
  });

  it('only accepts a CDP WebSocket on the configured loopback port', () => {
    expect(isLoopbackWs('ws://127.0.0.1:9333/devtools/browser/abc', 9333)).toBe(true);
    expect(isLoopbackWs('ws://[::1]:9333/devtools/browser/abc', 9333)).toBe(true);
    expect(isLoopbackWs('ws://localhost:9333/devtools/browser/abc', 9333)).toBe(true);
    expect(isLoopbackWs('ws://127.0.0.1:9222/devtools/browser/abc', 9333)).toBe(false);
    expect(isLoopbackWs('ws://10.0.0.5:9333/devtools/browser/abc', 9333)).toBe(false);
    expect(isLoopbackWs('wss://127.0.0.1:9333/devtools/browser/abc', 9333)).toBe(false);
    expect(isLoopbackWs('ws://user:pass@127.0.0.1:9333/devtools/browser/abc', 9333)).toBe(false);
    expect(isLoopbackWs('http://127.0.0.1:9333/json/version', 9333)).toBe(false);
  });
});

describe('TXT/Markdown link discovery', () => {
  it('keeps absolute download links and resolves relative ones', () => {
    const html = `<html><body>
      <a href="https://cdn.example.com/novel/海风.txt">海风.txt</a>
      <a href="/files/第二部.md">第二部.md</a>
      <a href="files/第三部.TXT?raw=1">第三部</a>
      <a href="/read/123.html">在线阅读</a>
    </body></html>`;
    const found = discoverLinks(html, 'https://www.example.com/book/1/', 40);
    expect(found.links.map((link) => link.url)).toEqual([
      'https://cdn.example.com/novel/%E6%B5%B7%E9%A3%8E.txt',
      'https://www.example.com/files/%E7%AC%AC%E4%BA%8C%E9%83%A8.md',
      'https://www.example.com/book/1/files/%E7%AC%AC%E4%B8%89%E9%83%A8.TXT?raw=1',
    ]);
    expect(found.links.map((link) => link.format)).toEqual(['txt', 'md', 'txt']);
    expect(found.truncated).toBe(false);
    expect(found.total).toBe(3);
  });

  it('deduplicates repeated links and ignores non-http targets', () => {
    const html = `<a href="/a.txt">a</a><a href="/a.txt#x">a again</a>
      <a href="mailto:me@example.com">mail</a><a href="javascript:void(0)">js</a>
      <a href="file:///C:/novel.txt">local</a><a href="/b.txt">b</a>`;
    const found = discoverLinks(html, 'https://example.com/list/', 40);
    expect(found.links.map((link) => link.url)).toEqual(['https://example.com/a.txt', 'https://example.com/b.txt']);
  });

  it('caps a long candidate list and reports the truncation', () => {
    const html = Array.from({ length: 60 }, (_, index) => `<a href="/book-${index}.txt">书${index}</a>`).join('');
    const found = discoverLinks(html, 'https://example.com/', 12);
    expect(found.links).toHaveLength(12);
    expect(found.total).toBe(60);
    expect(found.truncated).toBe(true);
  });

  it('reads book identity hints from a link label and file name', () => {
    expect(extractIdentity('《海风》作者：小鱼.txt')).toEqual({ title: '海风', author: '小鱼' });
    expect(extractIdentity('书名：刀锋 作者：毛姆 大小：1.2MB')).toMatchObject({ title: '刀锋', author: '毛姆', size: 1_258_291 });
    expect(extractIdentity('novel-123')).toEqual({});
    const found = discoverLinks('<a href="/x/刀锋.txt">《刀锋》作者：毛姆</a>', 'https://example.com/', 40);
    expect(found.links[0]).toMatchObject({ title: '刀锋', author: '毛姆', filename: '刀锋.txt' });
  });
});
