import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
import { DownloadError, downloadFile, type DownloadRequest } from '../src/txt-acquisition/download.ts';

let root: string;
let staging: AcquisitionStaging;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bookfish-download-'));
  staging = new AcquisitionStaging(root);
  await staging.init();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const publicDns = async (): Promise<string[]> => ['93.184.216.34'];

function request(overrides: Partial<DownloadRequest> & { fetchImpl: typeof fetch }): DownloadRequest {
  return { url: 'https://files.example.com/novel.txt', allowNetwork: true, staging, taskId: 'task-1', resolve: publicDns, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<DownloadError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(DownloadError); return error as DownloadError; }
  throw new Error('expected the download to fail');
}

describe('raw byte download', () => {
  it('reports a write failure during backpressure and cleans the partial instead of hanging', async () => {
    const original=staging.beginDownload.bind(staging);vi.spyOn(staging,'beginDownload').mockImplementation(async id=>{const result=await original(id);result.stream.write=(()=>{queueMicrotask(()=>result.stream.destroy(Object.assign(Error('full disk'),{code:'ENOSPC'})));return false;}) as typeof result.stream.write;return result;});
    const result=await failure(downloadFile(request({fetchImpl:(async()=>new Response(Buffer.alloc(64*1024))) as typeof fetch})));expect(result.code).toBe('storage_unavailable');expect(readdirSync(staging.workDir)).toEqual([]);
  });
  it('keeps GBK bytes exactly as sent and reports progress', async () => {
    // "中文测试。" in GBK: decoding here would destroy these bytes.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3]);
    const seen: Array<number> = [];
    const fetchImpl = (async () => new Response(gbk, { status: 200, headers: { 'content-type': 'text/plain; charset=gbk', 'content-length': String(gbk.length) } })) as unknown as typeof fetch;
    const result = await downloadFile(request({ fetchImpl, onProgress: (received) => seen.push(received) }));
    expect(readFileSync(result.partPath).equals(gbk)).toBe(true);
    expect(result.sha256).toBe(createHash('sha256').update(gbk).digest('hex'));
    expect(result.bytes).toBe(gbk.length);
    expect(result.contentType).toBe('text/plain');
    expect(seen.at(-1)).toBe(gbk.length);
  });

  it('re-checks every redirect hop and follows a normal chain', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/step/two.txt' } });
      if (calls.length === 2) return new Response(null, { status: 307, headers: { location: 'https://cdn.example.net/final.txt' } });
      return new Response('正文。', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const result = await downloadFile(request({ fetchImpl }));
    expect(result.redirects).toBe(2);
    expect(result.finalUrl).toBe('https://cdn.example.net/final.txt');
    expect(calls).toHaveLength(3);
  });

  it('refuses a redirect that points at a loopback or metadata address', async () => {
    for (const location of ['http://127.0.0.1:8080/secret.txt', 'http://169.254.169.254/latest/meta-data/']) {
      const fetchImpl = (async () => new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;
      const error = await failure(downloadFile(request({ fetchImpl })));
      expect(error.code).toBe('policy_blocked');
      expect(error.recoverable).toBe(false);
      expect(readdirSync(join(root, 'work'))).toEqual([]);
    }
  });

  it('stops after five redirects', async () => {
    let hop = 0;
    const fetchImpl = (async () => { hop += 1; return new Response(null, { status: 302, headers: { location: `/hop-${hop}.txt` } }); }) as unknown as typeof fetch;
    const error = await failure(downloadFile(request({ fetchImpl })));
    expect(error.code).toBe('http_error');
    expect(error.message).toMatch(/More than 5 redirects/);
    expect(error.recoverable).toBe(false);
  });

  it('refuses a file above the byte limit without writing it', async () => {
    const big = Buffer.alloc(4096, 0x61);
    const declared = (async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(big.length) } })) as unknown as typeof fetch;
    expect((await failure(downloadFile(request({ fetchImpl: declared, maxBytes: 1024 })))).code).toBe('too_large');
    // No trustworthy Content-Length: the running total still stops the transfer.
    const undeclared = (async () => new Response(new ReadableStream({
      start(controller) { for (let index = 0; index < 8; index += 1) controller.enqueue(new Uint8Array(512)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    expect((await failure(downloadFile(request({ fetchImpl: undeclared, maxBytes: 1024 })))).code).toBe('too_large');
    expect(readdirSync(join(root, 'work'))).toEqual([]);
  });

  it('refuses an HTML page and unexpected content types', async () => {
    const html = (async () => new Response('<!doctype html><title>登录</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
    const error = await failure(downloadFile(request({ fetchImpl: html })));
    expect(error.code).toBe('download_failed');
    expect(error.message).toMatch(/HTML page/);
    const pdf = (async () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    expect((await failure(downloadFile(request({ fetchImpl: pdf })))).message).toMatch(/Unexpected content type/);
  });

  it('accepts an octet-stream download and a server error is recoverable', async () => {
    const binary = (async () => new Response('正文。', { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as unknown as typeof fetch;
    await expect(downloadFile(request({ fetchImpl: binary }))).resolves.toMatchObject({ bytes: Buffer.byteLength('正文。') });
    const busy = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const error = await failure(downloadFile(request({ fetchImpl: busy })));
    expect(error.code).toBe('http_error');
    expect(error.recoverable).toBe(true);
  });

  it('cancels mid-transfer and removes the partial file', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array(64)); controller.abort(); },
    }), { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const error = await failure(downloadFile(request({ fetchImpl, signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    expect(error.recoverable).toBe(true);
    expect(readdirSync(join(root, 'work'))).toEqual([]);
  });

  it('refuses to reach the network when the world has no permission', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('x'); }) as unknown as typeof fetch;
    const error = await failure(downloadFile(request({ fetchImpl, allowNetwork: false })));
    expect(error.code).toBe('policy_blocked');
    expect(called).toBe(false);
    expect(existsSync(join(root, 'work'))).toBe(true);
  });
});
