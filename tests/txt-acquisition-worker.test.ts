import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
const SOURCE = 'https://files.example.com/book.txt';
async function worker(responseFactory: () => Response, allowedOrigins = ['https://files.example.com'], revokeDuringFetch = false) {
  const replies: Response[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = []; let upstreamCalls = 0;
  const listeners = new Set<(...args: any[]) => void>();
  const event = { addListener(fn: (...args: any[]) => void) { listeners.add(fn); }, removeListener(fn: (...args: any[]) => void) { listeners.delete(fn); } };
  const chrome = {
    storage: { onChanged: event, local: { get: async () => ({ token: '', state: {} }), set: async () => undefined } },
    permissions: { onRemoved: event, contains: async () => true }, runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} },
  };
  const context = {
    btoa: (text: string) => Buffer.from(text, 'latin1').toString('base64'), chrome, crypto: { randomUUID, subtle: webcrypto.subtle }, AbortController, AbortSignal, URL, Uint8Array, TextDecoder,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (value: string, init?: RequestInit) => {
      const url = String(value); calls.push({ url, init });
      if (url.startsWith('http://127.0.0.1:')) { const reply = new Response('{}', { status: 200 }); replies.push(reply); return reply; }
      upstreamCalls++; if (revokeDuringFetch) for (const listener of listeners) listener({ allowedOrigins: { newValue: [] } }, 'local'); const response = responseFactory(); Object.defineProperty(response, 'url', { value: SOURCE }); return response;
    },
  } as Record<string, unknown>;
  runInNewContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8') + '\nglobalThis.api = { handle };', context);
  const api = context.api as { handle: (job: unknown, config: unknown) => Promise<void> };
  return { calls, replies, run: async (kind = 'file', url = SOURCE) => api.handle({ id: randomUUID(), kind, url, lease: randomUUID(), leaseMs: 30000, maxBytes: kind === 'file' ? 100 * 1024 * 1024 : 8 * 1024 * 1024 }, { port: 47823, token: 'paired', allowedOrigins }), get upstreamCalls() { return upstreamCalls; } };
}
describe('actual extension worker streaming policy', () => {
  it('transfers original non-UTF8 bytes with ordered chunks and final byte count', async () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); const env = await worker(() => new Response(bytes, { headers: { 'content-type': 'text/plain' } })); await env.run();
    const chunk = env.calls.find(call => call.url.endsWith('/chunk'))!; expect(Buffer.from(chunk.init!.body as Uint8Array)).toEqual(Buffer.from(bytes)); expect((chunk.init!.headers as Record<string, string>)['x-bookfish-sequence']).toBe('0');
    expect(JSON.parse(env.calls.find(call => call.url.endsWith('/done'))!.init!.body as string).bytes).toBe(bytes.length);
    const fetch = env.calls.find(call => call.url === SOURCE)!; expect(fetch.init?.redirect).toBe('error'); expect(env.replies.length).toBeGreaterThan(0); expect(env.replies.every(reply => reply.bodyUsed)).toBe(true);
  });
  it('never sends login-state requests to unapproved third-party origins', async () => { const env = await worker(() => new Response('body'), []); await env.run(); expect(env.upstreamCalls).toBe(0); expect(JSON.parse(env.calls.find(call => call.url.endsWith('/fail'))!.init!.body as string).code).toBe('policy_blocked'); });
  it('rejects declared oversized pages before reading their body', async () => {
    let cancelled = false; const env = await worker(() => new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }));
    await env.run('page'); expect(env.calls.some(call => call.url.endsWith('/page'))).toBe(false); expect(JSON.parse(env.calls.find(call => call.url.endsWith('/fail'))!.init!.body as string).code).toBe('too_large');
    // The body must also be cancelled when rejection happens before getReader.
    expect(cancelled).toBe(true);
  });
  it('cancels a streaming page when actual bytes exceed 8MiB without Content-Length', async () => {
    let pulls = 0, cancelled = false;
    const env = await worker(() => new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })));
    await env.run('page'); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(10); expect(env.calls.some(call => call.url.endsWith('/page'))).toBe(false);
  });
  it('does not publish bytes after source permission is revoked during transfer', async () => {
    const env = await worker(() => new Response('private bytes'), ['https://files.example.com'], true); await env.run();
    expect(env.calls.some(call => /\/(chunk|done)$/.test(call.url))).toBe(false);
    expect(JSON.parse(env.calls.find(call => call.url.endsWith('/fail'))!.init!.body as string).code).toBe('cancelled');
  });
  it('rejects HTML file headers before uploading chunks', async () => { const env = await worker(() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })); await env.run(); expect(env.calls.some(call => call.url.endsWith('/chunk'))).toBe(false); });
});
