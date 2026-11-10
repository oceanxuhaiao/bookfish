import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { request as requestType } from 'node:https';
import { SourceHttp, isPublicAddress, sourceUrl } from '../src/source-http.ts';
const URL = 'https://www.02345.cc/sample/';
interface Response { status?: number; type?: string; location?: string; body?: Buffer | string; hang?: boolean; encoding?: string }
function transport(responses: Response[]) {
  const seen: Array<{ url: string; pinned: string; headers: Record<string, string> }> = [];
  const request = ((url: globalThis.URL, options: any, callback: any) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    const abort = () => req.emit('error', new Error('aborted'));
    req.end = () => queueMicrotask(() => {
      const response = responses.shift(); if (!response) { req.emit('error', new Error('No fixture response')); return; }
      options.lookup(url.hostname, { all: false }, (_error: unknown, address: string) => {
        seen.push({ url: url.href, pinned: address, headers: options.headers });
        if (response.hang) { options.signal.addEventListener('abort', abort, { once: true }); return; }
        const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string | undefined> };
        res.statusCode = response.status ?? 200;
        res.headers = { 'content-type': response.type ?? 'text/html; charset=utf-8', location: response.location, 'content-encoding': response.encoding };
        callback(res); if (!res.destroyed) res.end(response.body ?? '<html>test</html>');
      });
    });
    return req;
  }) as unknown as typeof requestType;
  return { request, seen };
}
function client(responses: Response[], options = {}) {
  const fake = transport(responses);
  return { ...fake, http: new SourceHttp({ intervalMs: 0, resolve: async () => [{ address: '93.184.216.34', family: 4 }], request: fake.request, ...options }) };
}
describe('bounded public source HTTP', () => {
  it('rejects private, loopback, mapped-private, multicast and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('refuses userinfo, arbitrary domains, ports, queries, fragments and file URLs before connecting', () => {
    for (const url of ['https://user:password@www.02345.cc/sample/', 'http://localhost/', 'http://2130706433/', URL + '?redirect=x', URL + '#x', 'https://www.02345.cc:444/sample/', 'file:///tmp/x']) expect(() => sourceUrl(url)).toThrow();
  });
  it('rejects mixed public and private DNS results before any transport request', async () => {
    const c = client([], { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }] });
    await expect(c.http.get(URL)).rejects.toMatchObject({ code: 'restricted' }); expect(c.seen).toEqual([]);
  });
  it('pins the checked public IP to the connection and sends neither cookies nor credentials', async () => {
    const c = client([{ body: '<html>正文</html>' }]);
    expect((await c.http.get(URL)).html).toContain('正文'); expect(c.seen[0].pinned).toBe('93.184.216.34');
    expect(Object.keys(c.seen[0].headers)).not.toContain('Cookie'); expect(Object.keys(c.seen[0].headers)).not.toContain('Authorization');
  });
  it('blocks redirects outside the allowed source rather than fetching their destination', async () => {
    const c = client([{ status: 302, location: 'http://127.0.0.1/private' }]);
    await expect(c.http.get(URL)).rejects.toMatchObject({ code: 'unsupported' }); expect(c.seen).toHaveLength(1);
  });
  it('follows at most three validated redirects', async () => {
    const c = client(Array.from({ length: 4 }, () => ({ status: 302, location: '/another/' })));
    await expect(c.http.get(URL)).rejects.toMatchObject({ code: 'restricted' }); expect(c.seen).toHaveLength(4);
  });
  it('checks DNS again for redirected requests, preventing a later private-address answer', async () => {
    let answers = 0;
    const c = client([{ status: 302, location: '/another/' }], { resolve: async () => [{ address: answers++ ? '127.0.0.1' : '93.184.216.34', family: 4 }] });
    await expect(c.http.get(URL)).rejects.toMatchObject({ code: 'restricted' }); expect(c.seen).toHaveLength(1);
  });
  it('maps login, refusal, missing chapter and server failure responses to explicit states', async () => {
    for (const [status, code] of [[401, 'needs_login'], [403, 'restricted'], [429, 'restricted'], [404, 'missing'], [503, 'temporary']] as const) {
      await expect(client([{ status }]).http.get(URL)).rejects.toMatchObject({ code });
    }
  });
  it('rejects non-HTML and bounded response overflow', async () => {
    await expect(client([{ type: 'application/octet-stream' }]).http.get(URL)).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(client([{ body: 'x'.repeat(100) }], { maxBytes: 20 }).http.get(URL)).rejects.toMatchObject({ code: 'limit' });
  });
  it('decodes GBK but rejects unknown encoding and malformed UTF-8', async () => {
    expect((await client([{ type: 'text/html; charset=gbk', body: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) }]).http.get(URL)).html).toBe('中文');
    await expect(client([{ type: 'text/html; charset=unknown' }]).http.get(URL)).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(client([{ body: Buffer.from([0xff, 0xfe, 0xff]) }]).http.get(URL)).rejects.toMatchObject({ code: 'invalid_content' });
  });
  it('decompresses gzip responses before decoding text', async () => {
    const body = gzipSync(Buffer.from('<html>压缩正文</html>', 'utf8'));
    expect((await client([{ encoding: 'gzip', body }]).http.get(URL)).html).toBe('<html>压缩正文</html>');
  });
  it('bounds request time and respects explicit cancellation without retrying', async () => {
    const timeout = client([{ hang: true }], { timeoutMs: 20 }); await expect(timeout.http.get(URL)).rejects.toMatchObject({ code: 'temporary' }); expect(timeout.seen).toHaveLength(1);
    const abort = new AbortController(); abort.abort(); const cancelled = client([]);
    await expect(cancelled.http.get(URL, abort.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(cancelled.seen).toHaveLength(0);
  });
  it('bounds DNS time even when the resolver does not return', async () => {
    const c = client([], { timeoutMs: 20, resolve: async () => new Promise<never>(() => {}) });
    await expect(c.http.get(URL)).rejects.toMatchObject({ code: 'temporary' }); expect(c.seen).toHaveLength(0);
  });
});
