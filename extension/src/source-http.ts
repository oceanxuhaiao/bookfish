import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { SourceError, type HtmlPage } from './source-types.ts';

export const SOURCE_HOST = 'www.02345.cc';
export function sourceUrl(value: string, hosts: readonly string[] = [SOURCE_HOST]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceError('unsupported', 'Invalid source URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !hosts.includes(url.hostname) || url.search || url.hash) throw new SourceError('unsupported', `Only public book URLs on ${hosts.join(', ')} are supported`);
  return url;
}
export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export interface HttpOptions {
  timeoutMs?: number; maxBytes?: number; intervalMs?: number;
  /** Force a source text encoding when the site mislabels its charset. */
  encoding?: string;
  /** Host allowlist; defaults to the adapted Biquge host. */
  hosts?: readonly string[];
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** DNS results are checked, then pinned to the socket lookup; redirects are validated at every hop. */
export class SourceHttp {
  private nextRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: HttpOptions = {}) {}
  get(url: string, callerSignal?: AbortSignal): Promise<HtmlPage> {
    const operation = this.queue.catch(() => {}).then(() => this.fetch(url, callerSignal));
    this.queue = operation; return operation;
  }
  private async fetch(rawUrl: string, callerSignal?: AbortSignal): Promise<HtmlPage> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    try {
      let url = sourceUrl(rawUrl, this.options.hosts);
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal.throwIfAborted();
        await wait(Math.max(0, this.nextRequestAt - Date.now()), signal);
        this.nextRequestAt = Date.now() + (this.options.intervalMs ?? 700);
        const resolver = this.options.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
        const addresses = await Promise.race([
          resolver(url.hostname),
          new Promise<never>((_, reject) => {
            const onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
        if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new SourceError('restricted', 'Source DNS resolved to a non-public address');
        const pinned = addresses[0];
        const response = await new Promise<{ status: number; location?: string; type: string; contentEncoding: string; bytes: Buffer }>((resolve, reject) => {
          const request = (this.options.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
            signal, family: pinned.family,
            lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
            headers: { 'User-Agent': 'Bookfish/0.3 (personal novel reader)', Accept: 'text/html', 'Accept-Encoding': 'identity' },
          }, (res) => {
            const status = res.statusCode ?? 0;
            const type = String(res.headers['content-type'] ?? '');
            const contentEncoding = String(res.headers['content-encoding'] ?? '');
            if (status >= 300 && status < 400) { res.destroy(); resolve({ status, location: res.headers.location, type, contentEncoding, bytes: Buffer.alloc(0) }); return; }
            if (status !== 200) { res.destroy(); resolve({ status, type, contentEncoding, bytes: Buffer.alloc(0) }); return; }
            if (!/text\/html|application\/xhtml\+xml/i.test(type)) { res.destroy(); reject(new SourceError('invalid_content', 'Source did not return HTML')); return; }
            const chunks: Buffer[] = []; let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > (this.options.maxBytes ?? 1024 * 1024)) res.destroy(new SourceError('limit', 'HTML response exceeds 1 MiB'));
              else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => resolve({ status, type, contentEncoding, bytes: Buffer.concat(chunks) }));
          });
          request.on('error', reject); request.end();
        });
        if (response.status >= 300 && response.status < 400) {
          if (!response.location || redirects === 3) throw new SourceError('restricted', 'Source redirected too many times');
          url = sourceUrl(new URL(response.location, url).href, this.options.hosts); continue;
        }
        if ([401].includes(response.status)) throw new SourceError('needs_login', 'Source requires login');
        if ([402, 403, 429].includes(response.status)) throw new SourceError('restricted', `Source refused access (HTTP ${response.status})`);
        if ([404, 410].includes(response.status)) throw new SourceError('missing', 'Source chapter or page is missing');
        if (response.status !== 200) throw new SourceError('temporary', `Source failed (HTTP ${response.status})`);
        let body = response.bytes;
        try {
          const encoding = response.contentEncoding.toLowerCase();
          if (encoding === 'gzip') body = gunzipSync(body);
          else if (encoding === 'deflate') body = inflateSync(body);
          else if (encoding === 'br') body = brotliDecompressSync(body);
        } catch { throw new SourceError('invalid_content', 'Source compression decoding failed'); }
        const prefix = body.subarray(0, 4096).toString('ascii');
        const declared = response.type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? prefix.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8';
        if (!/^(utf-?8|gbk|gb2312|gb18030)$/i.test(declared) && !this.options.encoding) throw new SourceError('invalid_content', 'Unsupported source encoding');
        // Some chapter templates switch encodings inside the same book (the
        // 序 page can be GBK while later chapters are UTF-8). Try UTF-8, GBK,
        // then the declared value instead of trusting one header.
        const candidates = [...new Set([this.options.encoding, 'utf-8', 'gb18030', 'gbk', declared].filter((value): value is string => !!value))];
        let html: string | undefined;
        for (const encoding of candidates) {
          if (!/^(utf-?8|gbk|gb2312|gb18030)$/i.test(encoding)) continue;
          try { html = new TextDecoder(encoding, { fatal: true }).decode(body); break; }
          catch { /* try the next encoding */ }
        }
        if (html === undefined) throw new SourceError('invalid_content', 'Source text decoding failed');
        return { url: url.href, html };
      }
      throw new SourceError('restricted', 'Redirect limit reached');
    } catch (error) {
      if (callerSignal?.aborted) throw new SourceError('cancelled', 'Source request cancelled');
      if (error instanceof SourceError) throw error;
      throw new SourceError('temporary', timeout.aborted ? 'Source request timed out' : 'Source network request failed');
    }
  }
}

