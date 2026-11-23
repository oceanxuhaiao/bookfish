import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserBridge, type BridgeOptions } from '../src/txt-acquisition/bridge.ts';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
const url = 'https://files.example.com/book.txt';
const resources: Array<{ bridge: BrowserBridge; dir: string }> = [];
afterEach(async () => { for (const item of resources.splice(0)) { await item.bridge.stop(); rmSync(item.dir, { recursive: true, force: true }); } });
const capture = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
async function setup(options: Partial<BridgeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-bridge-v2-')); const staging = new AcquisitionStaging(dir); await staging.init();
  const bridge = new BrowserBridge({ dataDir: dir, port: 0, resolve: async () => ['93.184.216.34'], authorize: async () => undefined, ...options });
  resources.push({ bridge, dir }); const { port, token } = await bridge.start();
  const base = `http://127.0.0.1:${port}/bridge/jobs`;
  const auth = (consumer: string, lease?: string, sequence?: number) => ({ 'x-bookfish-token': token, 'x-bookfish-consumer': consumer, ...(lease ? { 'x-bookfish-lease': lease } : {}), ...(sequence === undefined ? {} : { 'x-bookfish-sequence': String(sequence) }) });
  const poll = async (consumer = 'consumer-one') => ((await (await fetch(`${base}?wait=0`, { headers: auth(consumer) })).json()) as { job: unknown }).job as { id: string; lease: string; attemptId: string } | null;
  const post = (job: { id: string; lease: string }, action: string, body: string | Buffer, consumer = 'consumer-one', sequence?: number) => fetch(`${base}/${job.id}/${action}`, { method: 'POST', headers: auth(consumer, job.lease, sequence), body });
  const start = (taskId = 'task', signal?: AbortSignal, timeoutMs = 2000) => capture(bridge.fetchFile({ url, staging, taskId, filename: 'book.txt', allowNetwork: true, signal, timeoutMs }));
  const done = (job: { id: string; lease: string }, bytes: number, consumer = 'consumer-one') => post(job, 'done', JSON.stringify({ finalUrl: url, contentType: 'text/plain', bytes }), consumer);
  const waitJob = async (consumer = 'consumer-one') => { for (let i = 0; i < 100; i++) { const job = await poll(consumer); if (job) return job; await new Promise(ok => setTimeout(ok, 1)); } throw new Error('No job'); };
  return { dir, staging, bridge, poll, post, start, done, waitJob };
}
describe('bridge v2 ownership and file integrity', () => {
  it('fails closed without independently supplied browser protection', async () => {
    const env = await setup({ authorize: undefined }); await expect(env.bridge.fetchPage(url, { allowNetwork: true })).rejects.toMatchObject({ code: 'policy_blocked' }); expect(await env.poll()).toBeNull();
  });
  it('refuses initial private targets and disabled network before dispatch', async () => {
    const env = await setup(); for (const target of ['http://127.0.0.1/a.txt', 'http://169.254.169.254/a.txt', 'http://[::1]/']) await expect(env.bridge.fetchPage(target, { allowNetwork: true })).rejects.toMatchObject({ code: 'policy_blocked' });
    await expect(env.bridge.fetchPage(url, { allowNetwork: false })).rejects.toMatchObject({ code: 'policy_blocked' }); expect(await env.poll()).toBeNull();
  });
  it('assigns one pending job to only one of two concurrent consumers', async () => {
    const env = await setup(); const result = env.start(); const a = await env.waitJob(); const b = await env.poll('consumer-two'); expect(b).toBeNull();
    expect((await env.post(a, 'chunk', Buffer.from('evil'), 'consumer-two', 0)).status).toBe(409);
    await env.post(a, 'chunk', Buffer.from('good'), 'consumer-one', 0); await env.done(a, 4); expect(readFileSync((await result).value!.partPath, 'utf8')).toBe('good');
  });
  it('reassigns expired claims into new files and rejects late old consumers', async () => {
    let now = 1000; const env = await setup({ now: () => now, leaseMs: 1000 }); const result = env.start(); const first = await env.waitJob();
    await env.post(first, 'chunk', Buffer.from('OLD'), 'consumer-one', 0); const previous = readdirSync(env.staging.workDir)[0];
    now += 1001; const next = await env.waitJob('consumer-two'); expect(next.attemptId).not.toBe(first.attemptId); expect(readdirSync(env.staging.workDir)).not.toContain(previous);
    expect((await env.post(first, 'chunk', Buffer.from('LATE'), 'consumer-one', 1)).status).toBe(409);
    await env.post(next, 'chunk', Buffer.from('NEW'), 'consumer-two', 0); await env.done(next, 3, 'consumer-two'); expect(readFileSync((await result).value!.partPath, 'utf8')).toBe('NEW');
  });
  it.each([30,99])('retries after a %i percent interrupted transfer without old bytes', async percent => {
    const env = await setup(); const full = Buffer.from('0123456789'.repeat(1000)); const first = env.start(); const a = await env.waitJob();
    await env.post(a, 'chunk', full.subarray(0, full.length*percent/100), 'consumer-one', 0); await env.post(a, 'fail', JSON.stringify({ code: 'network' })); expect((await first).error).toBeTruthy(); expect(readdirSync(env.staging.workDir)).toEqual([]);
    const second = env.start(); const b = await env.waitJob(); await env.post(b, 'chunk', full, 'consumer-one', 0); await env.done(b, full.length);
    const value = (await second).value!; expect(readFileSync(value.partPath)).toEqual(full); expect(value.sha256).toBe(createHash('sha256').update(full).digest('hex')); expect(value.bytes).toBe(full.length);
  });
  it('rejects duplicate sequence writes without appending them', async () => {
    const env = await setup(); const result = env.start(); const a = await env.waitJob(); await env.post(a, 'chunk', 'ONE', 'consumer-one', 0);
    expect((await env.post(a, 'chunk', 'BAD', 'consumer-one', 0)).status).toBe(409); await env.post(a, 'chunk', 'TWO', 'consumer-one', 1); await env.done(a, 6); expect(readFileSync((await result).value!.partPath, 'utf8')).toBe('ONETWO');
  });
  it('recomputes the stored checksum and rejects disk tampering before success', async () => {
    const env = await setup(); const result = env.start(); const a = await env.waitJob(); await env.post(a, 'chunk', 'GOOD', 'consumer-one', 0);
    writeFileSync(join(env.staging.workDir, readdirSync(env.staging.workDir)[0]!), 'EVIL'); expect((await env.done(a, 4)).status).toBe(400); expect((await result).error).toBeTruthy(); expect(readdirSync(env.staging.workDir)).toEqual([]);
  });
  it('requires the browser final byte count and cleans a mismatch', async () => {
    const env = await setup(); const result = env.start(); const a = await env.waitJob(); await env.post(a, 'chunk', 'GOOD', 'consumer-one', 0); await env.done(a, 3); expect((await result).error).toBeTruthy(); expect(readdirSync(env.staging.workDir)).toEqual([]);
  });
  it('cleans files on cancellation, timeout, content rejection and bridge stop', async () => {
    for (const mode of ['cancel', 'timeout', 'html', 'stop']) {
      const env = await setup(); const abort = new AbortController(); const result = env.start('task', abort.signal, mode === 'timeout' ? 120 : 2000); const a = await env.waitJob();
      await env.post(a, 'chunk', 'BODY', 'consumer-one', 0);
      if (mode === 'cancel') abort.abort(); else if (mode === 'html') await env.post(a, 'done', JSON.stringify({ finalUrl: url, contentType: 'text/html', bytes: 4 })); else if (mode === 'stop') await env.bridge.stop();
      expect((await result).error).toBeTruthy(); expect(readdirSync(env.staging.workDir)).toEqual([]);
    }
  });
  it('does not queue already aborted requests', async () => { const env = await setup(); const abort = new AbortController(); abort.abort(); expect((await env.start('task', abort.signal)).error).toBeTruthy(); expect(await env.poll()).toBeNull(); });
  it('does not persist or return extension-provided signed error URLs', async () => {
    const env = await setup(); const result = env.start(); const a = await env.waitJob(); await env.post(a, 'fail', JSON.stringify({ code: 'network', message: 'https://alice:password@files.example.com/file?token=secret' })); expect(String((await result).error)).not.toContain('secret');
  });
  it('accepts a public redirect after re-checking the landed address', async () => {
    const env = await setup(); const result = capture(env.bridge.fetchPage(url, { allowNetwork: true })); const a = await env.waitJob();
    await env.post(a, 'page', JSON.stringify({ html: 'ok', finalUrl: 'https://other.example.com/search' }));
    expect((await result).value).toEqual({ html: 'ok', finalUrl: 'https://other.example.com/search' });
  });
  it('still refuses a redirect that lands on a private or metadata address', async () => {
    const env = await setup(); const result = capture(env.bridge.fetchPage(url, { allowNetwork: true })); const a = await env.waitJob();
    await env.post(a, 'page', JSON.stringify({ html: 'unsafe', finalUrl: 'http://169.254.169.254/latest/meta-data' }));
    expect((await result).error).toMatchObject({ code: 'policy_blocked' });
  });
});
