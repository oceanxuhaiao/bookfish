import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserClient, type CdpSocket } from '../src/txt-acquisition/browser-client.ts';
import { PageChannel } from '../src/txt-acquisition/page-channel.ts';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';

type Handler = (event: { data?: string }) => void;
class FakeSocket {
  readonly sent: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
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
  event(method: string, params: unknown, sessionId?: string): void {
    this.emit('message', { data: JSON.stringify({ method, params, sessionId }) });
  }
  private emit(type: string, event: { data?: string } = {}): void { for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event); }
  private remove(type: string, handler: Handler): void { this.handlers.set(type, (this.handlers.get(type) ?? []).filter((entry) => entry !== handler)); }
}

type Responder = (message: { id?: number; method?: string; params?: Record<string, unknown> }, socket: FakeSocket) => void;

function fakeBrowser(responder: Responder, port = 9333) {
  let socket: FakeSocket | undefined;
  const factory = (value: number): BrowserClient => new BrowserClient(
    value,
    (async () => new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${value}/devtools/browser/abc` }), { status: 200 })) as unknown as typeof fetch,
    () => { socket = new FakeSocket(responder); return socket as unknown as CdpSocket; },
  );
  return { channel: new PageChannel({ port, resolve: async () => ['93.184.216.34'], client: factory }), socket: () => socket! };
}

const PAGE = 'https://files.example.com/book.html';

/** A tiny browser: navigation always lands on `landed`, evaluate answers by expression. */
function browser(landed: string, html: string, file: { bytes: Uint8Array; type: string } | { status: number } = { bytes: new Uint8Array([104, 101, 108, 108, 111]), type: 'text/plain' }) {
  return fakeBrowser((message, socket) => {
    if (message.method === 'Target.createTarget') { socket.reply(message.id!, { targetId: 'tab-1' }); return; }
    if (message.method === 'Target.attachToTarget') { socket.reply(message.id!, { sessionId: 's-1' }); return; }
    if (message.method === 'Page.navigate') { socket.reply(message.id!, {}); socket.event('Page.loadEventFired', { timestamp: 1 }, 's-1'); return; }
    if (message.method === 'Runtime.evaluate') {
      const expression = String(message.params?.expression ?? '');
      if (expression === 'location.href') { socket.reply(message.id!, { result: { value: landed } }, 's-1'); return; }
      if (expression === 'document.readyState') { socket.reply(message.id!, { result: { value: 'complete' } }, 's-1'); return; }
      if (expression === 'document.documentElement.outerHTML') { socket.reply(message.id!, { result: { value: html } }, 's-1'); return; }
      if (expression.includes('window.__bookfish_page =')) {
        socket.reply(message.id!, { result: { value: 'status' in file ? { status: file.status, error: `HTTP ${file.status}` } : { bytes: file.bytes.length, type: file.type } } }, 's-1');
        return;
      }
      if (expression.includes('state.offset')) {
        const bytes = 'bytes' in file ? file.bytes : new Uint8Array();
        socket.reply(message.id!, { result: { value: Buffer.from(bytes).toString('base64') } }, 's-1');
        return;
      }
      socket.reply(message.id!, { result: { value: true } }, 's-1');
      return;
    }
    socket.reply(message.id!, {});
  });
}

function stagingDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bf-channel-'));
  const staging = new AcquisitionStaging(dir);
  return { dir, staging };
}

describe('real-tab page channel', () => {
  it('opens its own tab, returns the landed page and closes only that tab', async () => {
    const { channel, socket } = browser(PAGE, '<html><title>ok</title></html>');
    const page = await channel.loadPage('https://files.example.com/book', { allowNetwork: true });
    expect(page.html).toContain('<title>ok</title>');
    expect(page.finalUrl).toBe(PAGE);
    await page.close();
    const sent = socket().sent;
    expect(sent.filter((message) => message.method === 'Target.createTarget')).toHaveLength(1);
    expect(sent.filter((message) => message.method === 'Target.closeTarget')).toHaveLength(1);
  });

  it('refuses a page that lands on a private address', async () => {
    const { channel } = browser('http://192.168.1.10/admin', '<html></html>');
    await expect(channel.loadPage('https://files.example.com/book', { allowNetwork: true })).rejects.toMatchObject({ code: 'policy_blocked' });
  });

  it('reads file bytes from the page context and keeps the exact hash', async () => {
    const { dir, staging } = stagingDir(); await staging.init();
    const { channel } = browser('https://files.example.com/book.txt', '<html></html>');
    const result = await channel.download('https://files.example.com/book.txt', { staging, taskId: 'task-1', filename: 'book.txt', allowNetwork: true });
    expect(readFileSync(result.partPath)).toEqual(Buffer.from('hello'));
    expect(result.bytes).toBe(5);
    expect(result.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(result.contentType).toBe('text/plain');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an HTML landing page instead of importing it as text', async () => {
    const { dir, staging } = stagingDir(); await staging.init();
    const { channel } = browser('https://files.example.com/download', '<html></html>', { bytes: new Uint8Array([1, 2, 3]), type: 'text/html; charset=utf-8' });
    await expect(channel.download('https://files.example.com/download', { staging, taskId: 'task-2', filename: 'book.txt', allowNetwork: true }))
      .rejects.toMatchObject({ code: 'download_failed' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a 403 as a permission problem, not as a book', async () => {
    const { dir, staging } = stagingDir(); await staging.init();
    const { channel } = browser('https://files.example.com/book.txt', '<html></html>', { status: 403 });
    await expect(channel.download('https://files.example.com/book.txt', { staging, taskId: 'task-3', filename: 'book.txt', allowNetwork: true }))
      .rejects.toMatchObject({ code: 'permission_missing' });
    rmSync(dir, { recursive: true, force: true });
  });
});
