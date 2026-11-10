/**
 * Streaming downloader for the runtime archive.
 *
 * Only trusted HTTPS origins are accepted. Every redirect hop is re-checked,
 * private/loopback addresses are refused, and the body is written to disk in
 * chunks so a 100+ MiB archive never sits in memory.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

const MAX_REDIRECTS = 5;

export interface DownloadOptions {
  url: string;
  dest: string;
  maxBytes: number;
  allowedHosts: readonly string[];
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  /** Only isolated tests enable plain HTTP on loopback. */
  allowInsecureLoopback?: boolean;
}

export class RuntimeDownloadError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeDownloadError'; }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80') || value.startsWith('::ffff:127.');
  }
  return false;
}

export async function assertAllowedUrl(raw: string, opts: { allowedHosts: readonly string[]; allowInsecureLoopback?: boolean }): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RuntimeDownloadError('download_url', '下载地址无效'); }
  if (url.username || url.password) throw new RuntimeDownloadError('download_url', '下载地址不能包含账号信息');
  if (!(url.protocol === 'https:' || (opts.allowInsecureLoopback && url.protocol === 'http:'))) throw new RuntimeDownloadError('download_url', '只允许 HTTPS 下载地址');
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:' && !(host === '127.0.0.1' || host === 'localhost')) throw new RuntimeDownloadError('download_url', '测试下载只允许本机地址');
  if (isIP(host) && isPrivateAddress(host) && !(opts.allowInsecureLoopback && url.protocol === 'http:')) throw new RuntimeDownloadError('download_url', '下载地址不能指向内网');
  const allowed = opts.allowedHosts.map((item) => item.toLowerCase());
  if (!allowed.includes(host)) throw new RuntimeDownloadError('download_host', `下载来源不在受信列表：${host}`);
  if (url.port && url.port !== '443' && !(opts.allowInsecureLoopback && url.protocol === 'http:')) throw new RuntimeDownloadError('download_url', '下载地址端口不受支持');
  if (url.protocol === 'https:') {
    try {
      const addresses = await lookup(host, { all: true });
      if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new RuntimeDownloadError('download_address', '下载域名解析到内网地址');
    } catch (error) {
      if (error instanceof RuntimeDownloadError) throw error;
      throw new RuntimeDownloadError('download_dns', '无法解析下载域名');
    }
  }
  return url;
}

function open(url: URL, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; stream: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = { method: 'GET', headers: { 'user-agent': 'bookfish-runtime-installer', accept: 'application/zip,application/octet-stream' } };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, options, (response) => {
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, headers, stream: response });
        return;
      }
      if (status !== 200) { response.resume(); reject(new RuntimeDownloadError('download_http', `下载失败（HTTP ${status}）`)); return; }
      resolve({ status, headers, stream: response });
    });
    const onAbort = (): void => { req.destroy(new RuntimeDownloadError('cancelled', '已取消下载')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error instanceof RuntimeDownloadError ? error : new RuntimeDownloadError('download_network', `下载网络错误：${error.message}`)); });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}

/** Download to `dest` (which must not exist), streaming and enforcing a total size cap. */
export async function downloadRuntimeArchive(options: DownloadOptions): Promise<{ bytes: number }> {
  let url = await assertAllowedUrl(options.url, options);
  let redirects = 0;
  let response;
  for (;;) {
    response = await open(url, options.signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== 'string' || redirects >= MAX_REDIRECTS) throw new RuntimeDownloadError('download_redirect', '下载重定向次数过多');
      redirects++;
      url = await assertAllowedUrl(new URL(location, url).toString(), options);
      continue;
    }
    break;
  }
  const declared = Number(response.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > options.maxBytes) throw new RuntimeDownloadError('download_too_large', '运行时包超过允许的大小');
  mkdirSync(dirname(options.dest), { recursive: true });
  if (existsSync(options.dest)) rmSync(options.dest, { force: true });
  const stream = createWriteStream(options.dest, { flags: 'wx', mode: 0o600 });
  let received = 0;
  let lastReport = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      try { response!.stream.destroy(); } catch { /* already closed */ }
      stream.destroy();
      try { if (existsSync(options.dest)) rmSync(options.dest, { force: true }); } catch { /* best effort */ }
      reject(error);
    };
    const onAbort = (): void => fail(new RuntimeDownloadError('cancelled', '已取消下载'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    response!.stream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > options.maxBytes) { fail(new RuntimeDownloadError('download_too_large', '运行时包超过允许的大小')); response!.stream.destroy(); return; }
      if (declared && received > declared) { fail(new RuntimeDownloadError('download_length', '下载内容长度异常')); response!.stream.destroy(); return; }
      if (!stream.write(chunk)) response!.stream.pause();
      const now = Date.now();
      if (now - lastReport > 120) { lastReport = now; options.onProgress?.(received, declared || Math.max(received, options.maxBytes)); }
    });
    stream.on('drain', () => response!.stream.resume());
    response!.stream.on('error', (error) => fail(new RuntimeDownloadError('download_network', `下载中断：${error.message}`)));
    stream.on('error', (error) => fail(new RuntimeDownloadError('download_write', `无法写入下载文件：${error.message}`)));
    response!.stream.on('end', () => {
      if (settled) return;
      stream.end(() => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        if (declared && received !== declared) return reject(new RuntimeDownloadError('download_length', '下载内容长度与服务器声明不符'));
        try { if (statSync(options.dest).size !== received) return reject(new RuntimeDownloadError('download_length', '下载文件大小异常')); }
        catch { return reject(new RuntimeDownloadError('download_write', '下载文件丢失')); }
        options.onProgress?.(received, received);
        resolve({ bytes: received });
      });
    });
  });
}
