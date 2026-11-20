/**
 * Minimal Chrome DevTools Protocol client for one dedicated loopback port.
 *
 * Deliberate limits (the group patch did the opposite):
 *  - only the explicitly configured port, never 9222/9223/9224 scanning;
 *  - the browser WebSocket must be loopback on that same port;
 *  - every task creates its own target and only that target is driven;
 *  - if a target cannot be created the call fails, it never adopts an existing tab;
 *  - page readiness is an event plus a readyState probe, not a fixed sleep.
 */
import { isLoopbackWs } from './url-policy.ts';

export class BrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export interface CdpTargetInfo { targetId: string; type: string; url: string; title?: string }

/** The small slice of WebSocket the client needs; tests inject a fake with the same shape. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: never) => void, options?: { once?: boolean }): void;
}

export type CdpSocketFactory = (url: string) => CdpSocket;

const defaultSocketFactory: CdpSocketFactory = (url) => new WebSocket(url) as unknown as CdpSocket;

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

export class BrowserClient {
  private socket?: CdpSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>();
  private readonly created = new Set<string>();
  private closed = false;

  constructor(readonly port: number, private readonly fetchImpl: typeof fetch = fetch, private readonly socketFactory: CdpSocketFactory = defaultSocketFactory) {
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new BrowserError('browser_unavailable', `Invalid browser debug port ${port}`);
  }

  /** Ask the configured port for its browser endpoint; refuse anything non-loopback. */
  private async endpoint(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new BrowserError('browser_unavailable', `No browser debugging endpoint on 127.0.0.1:${this.port}`);
    }
    if (!response.ok) throw new BrowserError('browser_unavailable', `Browser endpoint answered ${response.status} on 127.0.0.1:${this.port}`);
    const payload = await response.json().catch(() => undefined) as { webSocketDebuggerUrl?: string } | undefined;
    const url = payload?.webSocketDebuggerUrl;
    if (!url) throw new BrowserError('browser_unavailable', 'Browser endpoint did not report a WebSocket URL');
    if (!isLoopbackWs(url, this.port)) throw new BrowserError('browser_unavailable', 'Browser WebSocket is not on the configured loopback port');
    return url;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const endpoint = await this.endpoint();
    await new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(endpoint);
      const timer = setTimeout(() => { socket.close(); reject(new BrowserError('browser_unavailable', 'Browser WebSocket did not open in time')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); this.socket = socket; resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new BrowserError('browser_unavailable', 'Browser WebSocket failed to open')); }, { once: true });
      socket.addEventListener('message', (event) => this.onMessage(event));
      socket.addEventListener('close', () => { this.closed = true; this.failAll(new BrowserError('browser_unavailable', 'Browser disconnected')); });
    });
  }

  private onMessage(event: { data: unknown }): void {
    let payload: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string }; sessionId?: string };
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(Buffer.from(event.data as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (typeof payload.id === 'number') {
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.error) entry.reject(new BrowserError('browser_unavailable', payload.error.message ?? 'CDP command failed'));
      else entry.resolve(payload.result);
      return;
    }
    if (payload.method) for (const listener of this.listeners) listener(payload.method, payload.params, payload.sessionId);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<unknown> {
    if (!this.socket || this.closed) return Promise.reject(new BrowserError('browser_unavailable', 'Browser is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError('browser_unavailable', `CDP command ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, ...(sessionId ? { sessionId } : {}), params }));
    });
  }

  waitForEvent(method: string, sessionId: string, timeoutMs: number): Promise<unknown> {    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new BrowserError('timeout', `Page did not emit ${method}`)); }, timeoutMs);
      const listener = (eventMethod: string, params: unknown, eventSession?: string) => {
        if (eventMethod !== method || eventSession !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(params);
      };
      this.listeners.add(listener);
    });
  }

  /** Create a fresh about:blank tab. Failures are fatal — no adopting user tabs. */
  async createPage(): Promise<PageSession> {
    await this.connect();
    let result: { targetId?: string } | undefined;
    try {
      result = await this.send('Target.createTarget', { url: 'about:blank', background: true }) as { targetId?: string };
    } catch (error) {
      throw new BrowserError('browser_unavailable', `Could not create a tab: ${(error as Error).message}`);
    }
    const targetId = result?.targetId;
    if (!targetId) throw new BrowserError('browser_unavailable', 'Browser did not return a new tab id');
    this.created.add(targetId);
    let attached: { sessionId?: string } | undefined;
    try {
      attached = await this.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string };
    } catch (error) {
      await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
      this.created.delete(targetId);
      throw new BrowserError('browser_unavailable', `Could not attach to the new tab: ${(error as Error).message}`);
    }
    const sessionId = attached?.sessionId;
    if (!sessionId) {
      await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
      this.created.delete(targetId);
      throw new BrowserError('browser_unavailable', 'Browser did not return a session for the new tab');
    }
    return new PageSession(this, targetId, sessionId);
  }

  /** Targets this client created, for diagnostics. */
  createdTargets(): string[] {
    return [...this.created];
  }

  async closeTarget(targetId: string): Promise<void> {
    if (!this.created.has(targetId)) return;
    this.created.delete(targetId);
    try { await this.send('Target.closeTarget', { targetId }, undefined, 5000); } catch { /* tab may already be gone */ }
  }

  async disconnect(): Promise<void> {
    for (const targetId of [...this.created]) await this.closeTarget(targetId);
    this.closed = true;
    this.failAll(new BrowserError('browser_unavailable', 'Browser client closed'));
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
  }
}

export class PageSession {
  constructor(private readonly client: BrowserClient, readonly targetId: string, private readonly sessionId: string) {}

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return this.client.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as {
      result?: { value?: T }; exceptionDetails?: { text?: string };
    };
    if (result.exceptionDetails) throw new BrowserError('browser_unavailable', result.exceptionDetails.text ?? 'Page script failed');
    return result.result?.value as T;
  }

  /** Navigate and wait for load, with a readyState probe as the authority. */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    await this.send('Page.enable');
    const loaded = this.client.waitForEvent('Page.loadEventFired', this.sessionId, timeoutMs);
    const started = await this.send('Page.navigate', { url }) as { errorText?: string };
    if (started.errorText) throw new BrowserError('network', `Navigation failed: ${started.errorText}`);
    await loaded.catch(async () => {
      // A load event can be missed for cached or instantly-complete pages; the DOM decides.
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state !== 'complete' && state !== 'interactive') throw new BrowserError('timeout', 'Page did not finish loading');
    });
    const state = await this.evaluate<string>('document.readyState');
    if (state !== 'complete' && state !== 'interactive') throw new BrowserError('timeout', `Page readyState is ${state}`);
  }

  async close(): Promise<void> {
    await this.client.closeTarget(this.targetId);
  }
}
