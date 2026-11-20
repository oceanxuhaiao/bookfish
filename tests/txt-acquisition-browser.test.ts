import { describe, expect, it } from 'vitest';
import { BrowserClient, BrowserError, type CdpSocket } from '../src/txt-acquisition/browser-client.ts';
import { verifyLandedUrl } from '../src/txt-acquisition/acquisition.ts';

type Handler = (event: { data?: string }) => void;

/** Minimal stand-in for a CDP WebSocket; it records every frame the client sends. */
class FakeSocket {
  readonly sent: Array<{ id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  private readonly handlers = new Map<string, Handler[]>();

  constructor(private readonly responder: (message: { id?: number; method?: string; params?: Record<string, unknown> }, socket: FakeSocket) => void) {
    queueMicrotask(() => this.emit('open'));
  }

  addEventListener(type: string, listener: Handler, options?: { once?: boolean }): void {
    const wrapped: Handler = (event) => { if (options?.once) this.remove(type, wrapped); listener(event); };
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), options?.once ? wrapped : listener]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> };
    this.sent.push(message);
    this.responder(message, this);
  }

  close(): void { this.emit('close'); }

  reply(id: number, result: unknown, sessionId?: string): void {
    this.emit('message', { data: JSON.stringify(sessionId ? { id, result, sessionId } : { id, result }) });
  }

  fail(id: number, message: string): void {
    this.emit('message', { data: JSON.stringify({ id, error: { message } }) });
  }

  event(method: string, params: unknown, sessionId?: string): void {
    this.emit('message', { data: JSON.stringify({ method, params, sessionId }) });
  }

  methods(): string[] { return this.sent.map((message) => message.method ?? ''); }

  private emit(type: string, event: { data?: string } = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }

  private remove(type: string, handler: Handler): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((entry) => entry !== handler));
  }
}

type Responder = (message: { id?: number; method?: string; params?: Record<string, unknown> }, socket: FakeSocket) => void;

function versionResponse(url: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ webSocketDebuggerUrl: url }), { status: 200 })) as unknown as typeof fetch;
}

function client(responder: Responder, options: { port?: number; wsUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const port = options.port ?? 9333;
  const holder: { socket?: FakeSocket } = {};
  const instance = new BrowserClient(port, options.fetchImpl ?? versionResponse(options.wsUrl ?? `ws://127.0.0.1:${port}/devtools/browser/abc`),
    () => { holder.socket = new FakeSocket(responder); return holder.socket as unknown as CdpSocket; });
  return { client: instance, socket: () => holder.socket! };
}
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(BrowserError); return (error as BrowserError).code; }
  throw new Error('expected a BrowserError');
}

describe('CDP client isolation', () => {
  it('only accepts a dedicated port in the user range', () => {
    expect(() => new BrowserClient(0)).toThrow(/Invalid browser debug port/);
    expect(() => new BrowserClient(80)).toThrow(/Invalid browser debug port/);
    expect(() => new BrowserClient(70_000)).toThrow(/Invalid browser debug port/);
    expect(() => new BrowserClient(93.5)).toThrow(/Invalid browser debug port/);
    expect(() => new BrowserClient(9333)).not.toThrow();
  });

  it('refuses a WebSocket that is not loopback on the configured port', async () => {
    for (const wsUrl of ['ws://127.0.0.1:9222/devtools/browser/abc', 'ws://10.0.0.5:9333/devtools/browser/abc', 'wss://127.0.0.1:9333/devtools/browser/abc']) {
      const { client: instance } = client(() => undefined, { wsUrl });
      expect(await code(instance.connect())).toBe('browser_unavailable');
    }
    const offline = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const { client: refused } = client(() => undefined, { fetchImpl: offline });
    expect(await code(refused.connect())).toBe('browser_unavailable');
  });

  it('fails instead of adopting an existing tab when it cannot create one', async () => {
    const { client: instance, socket } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.fail(message.id!, 'Cannot create target');
    });
    expect(await code(instance.createPage())).toBe('browser_unavailable');
    expect(socket().methods()).toEqual(['Target.createTarget']);
    expect(socket().methods()).not.toContain('Target.getTargets');
    expect(socket().methods()).not.toContain('Target.attachToTarget');
    expect(instance.createdTargets()).toEqual([]);
    await instance.disconnect();
    expect(socket().methods()).not.toContain('Target.closeTarget');
  });

  it('drives its own tab, waits for load, and closes only that tab', async () => {
    const { client: instance, socket } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 'tab-task-1' });
      else if (message.method === 'Target.attachToTarget') fake.reply(message.id!, { sessionId: 'session-1' });
      else if (message.method === 'Page.enable') fake.reply(message.id!, {});
      else if (message.method === 'Page.navigate') { fake.reply(message.id!, {}); fake.event('Page.loadEventFired', { timestamp: 1 }, 'session-1'); }
      else if (message.method === 'Runtime.evaluate') fake.reply(message.id!, { result: { value: 'complete' } }, 'session-1');
      else if (message.method === 'Target.closeTarget') fake.reply(message.id!, {});
    });
    const page = await instance.createPage();
    expect(page.targetId).toBe('tab-task-1');
    await page.navigate('https://example.com/book/1/', 500);
    await page.close();
    expect(socket().methods()).toContain('Target.attachToTarget');
    expect(socket().sent.find((message) => message.method === 'Page.navigate')?.params).toEqual({ url: 'https://example.com/book/1/' });
    expect(socket().sent.filter((message) => message.method === 'Target.closeTarget').map((message) => message.params)).toEqual([{ targetId: 'tab-task-1' }]);
    expect(instance.createdTargets()).toEqual([]);
  });

  it('falls back to document.readyState when the load event is missed', async () => {
    let evaluated = 0;
    const { client: instance } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 't1' });
      else if (message.method === 'Target.attachToTarget') fake.reply(message.id!, { sessionId: 's1' });
      else if (message.method === 'Page.navigate') fake.reply(message.id!, {});
      else if (message.method === 'Runtime.evaluate') { evaluated += 1; fake.reply(message.id!, { result: { value: 'complete' } }, 's1'); }
      else fake.reply(message.id!, {});
    });
    const page = await instance.createPage();
    await page.navigate('https://example.com/', 50);
    expect(evaluated).toBeGreaterThan(0);
  });

  it('reports a timeout when the page never becomes interactive', async () => {
    const { client: instance } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 't1' });
      else if (message.method === 'Target.attachToTarget') fake.reply(message.id!, { sessionId: 's1' });
      else if (message.method === 'Page.navigate') fake.reply(message.id!, {});
      else if (message.method === 'Runtime.evaluate') fake.reply(message.id!, { result: { value: 'loading' } }, 's1');
      else fake.reply(message.id!, {});
    });
    const page = await instance.createPage();
    expect(await code(page.navigate('https://example.com/', 50))).toBe('timeout');
  });

  it('closes a tab it created when attaching fails, and never leaves it behind', async () => {
    const { client: instance, socket } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 't1' });
      else if (message.method === 'Target.attachToTarget') fake.fail(message.id!, 'attach denied');
      else fake.reply(message.id!, {});
    });
    expect(await code(instance.createPage())).toBe('browser_unavailable');
    expect(socket().sent.filter((message) => message.method === 'Target.closeTarget').map((message) => message.params)).toEqual([{ targetId: 't1' }]);
    expect(instance.createdTargets()).toEqual([]);
  });
});
describe('browser navigation stays inside the URL policy', () => {
  it('re-checks where the tab actually landed, not only the address it was given', async () => {
    await expect(verifyLandedUrl('https://example.com/book.txt', { allowNetwork: true, resolve: async () => ['93.184.216.34'] })).resolves.toBeUndefined();
  });

  it('refuses a page that redirected into a local, private or metadata address', async () => {
    for (const landed of ['http://127.0.0.1:8080/book', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/a.txt', 'file:///C:/Windows/win.ini']) {
      await expect(verifyLandedUrl(landed, { allowNetwork: true, resolve: async () => ['93.184.216.34'] })).rejects.toMatchObject({ code: 'policy_blocked' });
    }
  });

  it('refuses a landing address whose DNS answers only non-public ranges', async () => {
    await expect(verifyLandedUrl('https://intranet.example/book', { allowNetwork: true, resolve: async () => ['192.168.1.20'] }))
      .rejects.toMatchObject({ code: 'policy_blocked' });
  });

  it('refuses to read a page when the browser reports no landing address or network is off', async () => {
    await expect(verifyLandedUrl('', { allowNetwork: true })).rejects.toMatchObject({ code: 'policy_blocked' });
    await expect(verifyLandedUrl(undefined, { allowNetwork: true })).rejects.toMatchObject({ code: 'policy_blocked' });
    await expect(verifyLandedUrl('https://example.com/a.txt', { allowNetwork: false })).rejects.toMatchObject({ code: 'policy_blocked' });
  });
});

describe('CDP request-before-dispatch policy', () => {
  it('refuses redirects and child resources before continuing their requests', async () => {
    const approved = 'https://example.com/book';
    const { client: instance, socket } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 't1' });
      else if (message.method === 'Target.attachToTarget') fake.reply(message.id!, { sessionId: 's1' });
      else fake.reply(message.id!, {});
    });
    const page = await instance.createPage(); await page.protectNavigation(approved);
    for (const event of [
      { requestId: 'private', request: { url: 'http://127.0.0.1/private' }, resourceType: 'Document' },
      { requestId: 'redirect', request: { url: approved }, resourceType: 'Document', redirectedRequestId: 'prior' },
      { requestId: 'image', request: { url: approved }, resourceType: 'Image' },
      { requestId: 'response', request: { url: approved }, resourceType: 'Document', responseStatusCode: 302 },
    ]) socket().event('Fetch.requestPaused', event, 's1');
    await new Promise(ok => setTimeout(ok, 5));
    expect(socket().sent.filter(message => message.method === 'Fetch.continueRequest')).toHaveLength(0);
    expect(socket().sent.filter(message => message.method === 'Fetch.failRequest')).toHaveLength(4); await instance.disconnect();
  });
  it('caps response bytes before fulfilling a document', async () => {
    const { client: instance, socket } = client((message, fake) => {
      if (message.method === 'Target.createTarget') fake.reply(message.id!, { targetId: 't1' });
      else if (message.method === 'Target.attachToTarget') fake.reply(message.id!, { sessionId: 's1' });
      else fake.reply(message.id!, {});
    });
    const page = await instance.createPage(); await page.protectNavigation('https://example.com/book');
    socket().event('Fetch.requestPaused', { requestId: 'large', request: { url: 'https://example.com/book' }, resourceType: 'Document', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Length', value: String(8 * 1024 * 1024 + 1) }] }, 's1');
    await new Promise(ok => setTimeout(ok, 5)); expect(socket().methods()).toContain('Fetch.failRequest'); expect(socket().methods()).not.toContain('Fetch.fulfillRequest'); await instance.disconnect();
  });
});
