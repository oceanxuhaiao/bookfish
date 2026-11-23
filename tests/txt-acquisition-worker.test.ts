import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto, randomUUID, createHash } from 'node:crypto';
const SOURCE = 'https://files.example.com/book.txt';
async function worker(responseFactory: () => Response, allowedOrigins = ['https://files.example.com'], revokeDuringFetch = false, bridgeStatus=200,stallUpstream=false,allowAllSites=false) {
  const replies: Response[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = []; let upstreamCalls = 0;
  const listeners = new Set<(...args: any[]) => void>();
  const intervals:Array<()=>Promise<void>>=[];
  const event = { addListener(fn: (...args: any[]) => void) { listeners.add(fn); }, removeListener(fn: (...args: any[]) => void) { listeners.delete(fn); } };
  const chrome = {
    storage: { onChanged: event, local: { get: async () => ({ token: '', state: {} }), set: async () => undefined } },
    permissions: { onRemoved: event, contains: async () => true }, runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} },
  };
  const context = {
    btoa: (text: string) => Buffer.from(text, 'latin1').toString('base64'), chrome, crypto: { randomUUID, subtle: webcrypto.subtle }, AbortController, AbortSignal, URL, Uint8Array, TextDecoder,
    setTimeout: () => 1, clearTimeout() {}, setInterval: (fn:()=>Promise<void>) => {intervals.push(fn);return 1;}, clearInterval() {},
    fetch: async (value: string, init?: RequestInit) => {
      const url = String(value); calls.push({ url, init: init?.body instanceof Uint8Array ? {...init,body:Uint8Array.from(init.body)} : init });
      if (url.startsWith('http://127.0.0.1:')) { const reply = new Response('{}', { status: bridgeStatus }); replies.push(reply); return reply; }
      upstreamCalls++;if(stallUpstream)return new Promise<Response>((_ok,no)=>{init!.signal!.addEventListener('abort',()=>no(new Error('Test upstream aborted')),{once:true});}); if (revokeDuringFetch) for (const listener of listeners) listener({ allowedOrigins: { newValue: [] } }, 'local'); const response = responseFactory(); if (!response.url) Object.defineProperty(response, 'url', { value: SOURCE }); return response;
    },
  } as Record<string, unknown>;
  runInNewContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8') + '\nglobalThis.api = { handle,allowed,settings };', context);
  const api = context.api as { allowed:(config:unknown,url:string)=>Promise<URL>;settings:()=>Promise<unknown>; handle: (job: unknown, config: unknown) => Promise<void> };
  return { allowed:api.allowed,settings:api.settings,permission:(value:boolean)=>{chrome.permissions.contains=async()=>value;}, calls, replies,pulse:async()=>Promise.all(intervals.map(fn=>fn())),change:(key:string)=>{for(const listener of listeners)listener({[key]:{newValue:'changed'}},'local');}, run: async (kind = 'file', url = SOURCE) => api.handle({ id: randomUUID(), kind, url, lease: randomUUID(), leaseMs: 30000, maxBytes: kind === 'file' ? 100 * 1024 * 1024 : 8 * 1024 * 1024 }, { port: 47823, token: 'paired', allowedOrigins, allowAllSites }), get upstreamCalls() { return upstreamCalls; } };
}
describe('actual extension worker streaming policy', () => {
  it('enforces the per-site source list by default',async()=>{
    const env=await worker(()=>new Response('unused'),[]);const cfg={allowedOrigins:[],bingSearchEnabled:true,allowAllSites:false};
    expect((await env.allowed(cfg,'https://cn.bing.com/search?q=novel')).origin).toBe('https://cn.bing.com');
    for(const url of ['http://cn.bing.com/search','https://www.bing.com/search','https://other.cn.bing.com/search','https://cn.bing.com:8443/search','https://files.example.com/a'])await expect(env.allowed(cfg,url)).rejects.toMatchObject({code:'policy_blocked'});
    await expect(env.allowed({allowedOrigins:['https://cn.bing.com'],bingSearchEnabled:false},'https://cn.bing.com/search')).rejects.toMatchObject({code:'policy_blocked'});
    env.permission(false);await expect(env.allowed(cfg,'https://cn.bing.com/search')).rejects.toMatchObject({code:'permission_missing'});
  });
  it('allows any http(s) source once all sites is granted',async()=>{
    const env=await worker(()=>new Response('unused'),[]);const cfg={allowedOrigins:[],bingSearchEnabled:false,allowAllSites:true};
    for(const url of ['https://files.example.com/a','https://www.bing.com/search','http://novel.example.net/x.txt'])expect((await env.allowed(cfg,url)).protocol).toMatch(/^https?:$/u);
    env.permission(false);await expect(env.allowed(cfg,'https://files.example.com/a')).rejects.toMatchObject({code:'permission_missing'});
    await expect(env.allowed(cfg,'https://user:pass@files.example.com/a')).rejects.toMatchObject({code:'policy_blocked'});
    await expect(env.allowed(cfg,'file:///etc/passwd')).rejects.toMatchObject({code:'policy_blocked'});
  });
  it('declares the exact built-in search host at installation, without granting all websites',()=>{
    const manifest=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*','https://cn.bing.com/*']);
  });
  it.each(['lease-cancel','token','port','bingSearchEnabled'])('aborts a stalled browser fetch through %s',async reason=>{
    const env=await worker(()=>new Response('unused'),['https://files.example.com'],false,reason==='lease-cancel'?404:200,true),running=env.run();
    for(let n=0;n<100&&!env.upstreamCalls;n++)await Promise.resolve();expect(env.upstreamCalls).toBe(1);
    const upstream=env.calls.find(c=>c.url===SOURCE)!;if(reason==='lease-cancel')await env.pulse();else env.change(reason);await running;
    expect(upstream.init!.signal!.aborted).toBe(true);expect(env.calls.some(c=>c.url.endsWith('/done'))).toBe(false);
  });
  it('sends exact 4MiB chunks and the final tail without decoding bytes', async () => {
    const bytes=new Uint8Array(4*1024*1024+137);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    const env=await worker(()=>new Response(bytes,{headers:{'content-type':'text/plain'}}));await env.run();
    const chunks=env.calls.filter(c=>c.url.endsWith('/chunk'));
    expect(chunks.map(c=>(c.init!.body as Uint8Array).byteLength)).toEqual([4*1024*1024,137]);
    expect(chunks.map(c=>(c.init!.headers as Record<string,string>)['x-bookfish-sequence'])).toEqual(['0','1']);
    const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
    expect(sha(Buffer.concat(chunks.map(c=>Buffer.from(c.init!.body as Uint8Array))))).toBe(sha(bytes));
  });
  it('does not send completed after a server rejects a chunk ACK', async () => {
    const env=await worker(()=>new Response('raw bytes',{headers:{'content-type':'text/plain'}}),['https://files.example.com'],false,503);await env.run();
    expect(env.calls.some(c=>c.url.endsWith('/chunk'))).toBe(true);expect(env.calls.some(c=>c.url.endsWith('/done'))).toBe(false);
  });
  it('transfers original non-UTF8 bytes with ordered chunks and final byte count', async () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); const env = await worker(() => new Response(bytes, { headers: { 'content-type': 'text/plain' } })); await env.run();
    const chunk = env.calls.find(call => call.url.endsWith('/chunk'))!; expect(Buffer.from(chunk.init!.body as Uint8Array)).toEqual(Buffer.from(bytes)); expect((chunk.init!.headers as Record<string, string>)['x-bookfish-sequence']).toBe('0');
    expect(JSON.parse(env.calls.find(call => call.url.endsWith('/done'))!.init!.body as string).bytes).toBe(bytes.length);
    const fetch = env.calls.find(call => call.url === SOURCE)!; expect(fetch.init?.redirect).toBe('follow'); expect(env.replies.length).toBeGreaterThan(0); expect(env.replies.every(reply => reply.bodyUsed)).toBe(true);
  });
  it('follows a redirect and re-checks the landed source', async () => {
    const redirecting = () => { const response = new Response('body', { headers: { 'content-type': 'text/plain' } }); Object.defineProperty(response, 'url', { value: 'https://other.example.com/x.txt' }); return response; };
    const strict = await worker(redirecting, ['https://files.example.com']); await strict.run();
    expect(strict.calls.some(call => /\/(chunk|done)$/.test(call.url))).toBe(false);
    expect(JSON.parse(strict.calls.find(call => call.url.endsWith('/fail'))!.init!.body as string).code).toBe('policy_blocked');
    const open = await worker(redirecting, [], false, 200, false, true); await open.run();
    expect(open.calls.some(call => call.url.endsWith('/done'))).toBe(true);
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
