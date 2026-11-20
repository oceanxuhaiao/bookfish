import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BOOK_BYTES } from '../books.ts';
import { DownloadError, TEXT_CONTENT_TYPE } from './download.ts';
import type { AcquisitionStaging } from './staging.ts';
import { checkUrl, type HostResolver } from './url-policy.ts';

/**
 * Local bridge between this world and a browser extension.
 *
 * Driving the user's own Edge/Chrome through CDP means asking them to restart the
 * browser with a debug port. Instead the extension polls this loopback server for
 * work: only 127.0.0.1 is bound, every request needs the pairing token, and a page
 * origin is refused, so a web page cannot borrow the bridge.
 */

export const BRIDGE_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 47823;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const LONG_POLL_MS = 25_000;
const MAX_WAITING_JOBS = 4;

export class BridgeError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable = true) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface BridgeOptions {
  /** Directory that keeps the pairing token, so restarts do not break pairing. */
  dataDir: string;
  port?: number;
  now?: () => number;
  resolve?: HostResolver;
  /** Test seam: accept these extra origins. */
  allowOrigins?: string[];
}

export interface BridgeFileRequest {
  url: string;
  taskId: string;
  staging: AcquisitionStaging;
  filename: string;
  allowNetwork: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BridgeFileResult {
  partPath: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  finalUrl: string;
}

interface PageJob {
  id: string;
  kind: 'page';
  url: string;
}

interface FileJob {
  id: string;
  kind: 'file';
  url: string;
  maxBytes: number;
  filename: string;
}

type BridgeJob = PageJob | FileJob;

interface Pending {
  job: BridgeJob;
  allowNetwork: boolean;
  /** Never rejects: a failure is a value, so no rejection can escape unobserved. */
  promise: Promise<Settled>;
  timer: NodeJS.Timeout;
  settled: boolean;
  settle: (outcome: Settled) => void;
  partPath?: string;
  hash?: ReturnType<typeof createHash>;
  bytes?: number;
}

type Settled = { ok: true; value: unknown } | { ok: false; error: Error };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) throw new BridgeError('too_large', 'Bridge request body is too large', false);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const body = await readBody(request, limit);
  if (!body.length) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new BridgeError('invalid_input', 'Bridge request body must be a JSON object', false);
  }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers['x-bookfish-token'];
  return Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class BrowserBridge {
  private server: Server | undefined;
  private pairingToken = '';
  private boundPort = 0;
  private lastSeen = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly waiting = new Set<(job: BridgeJob | undefined) => void>();
  private readonly allowOrigins: string[];

  constructor(private readonly options: BridgeOptions) {
    this.allowOrigins = options.allowOrigins ?? [];
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    return this.boundPort;
  }

  get connected(): boolean {
    return this.lastSeen > 0 && this.now() - this.lastSeen < 90_000;
  }

  private tokenFile(): string {
    return join(this.options.dataDir, 'bridge.json');
  }

  private loadToken(): string {
    try {
      if (existsSync(this.tokenFile())) {
        const parsed: unknown = JSON.parse(readFileSync(this.tokenFile(), 'utf8'));
        if (parsed && typeof parsed === 'object') {
          const value = (parsed as { token?: unknown }).token;
          if (typeof value === 'string' && value.length >= 16) return value;
        }
      }
    } catch { /* a damaged token file is simply replaced */ }
    const token = randomBytes(24).toString('base64url');
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileSync(this.tokenFile(), `${JSON.stringify({ token }, null, 2)}\n`, 'utf8');
    return token;
  }

  async start(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.boundPort, token: this.pairingToken };
    this.pairingToken = this.loadToken();
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? DEFAULT_BRIDGE_PORT, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : (this.options.port ?? DEFAULT_BRIDGE_PORT);
    this.server = server;
    return { port: this.boundPort, token: this.pairingToken };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const entry of [...this.pending.values()]) this.settleFailure(entry, new BridgeError('cancelled', 'The browser bridge stopped', true));
    for (const waiter of [...this.waiting]) waiter(undefined);
    this.waiting.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** What the user pastes into the extension popup. */
  info(): { port: number; token: string; connected: boolean; lastSeen: number } {
    return { port: this.boundPort, token: this.pairingToken, connected: this.connected, lastSeen: this.lastSeen };
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // non-browser client; the token is still required
    if (this.allowOrigins.includes(origin)) return true;
    return /^chrome-extension:\/\/[a-z0-9]{16,}$/iu.test(origin) || /^moz-extension:\/\/[0-9a-f-]{16,}$/iu.test(origin);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.originAllowed(request)) {
        sendJson(response, 403, { ok: false, code: 'policy_blocked', message: 'Only the paired browser extension may use the bridge' });
        return;
      }
      if (!sameSecret(bearer(request), this.pairingToken)) {
        sendJson(response, 401, { ok: false, code: 'unauthorized', message: 'Bridge pairing token is missing or wrong' });
        return;
      }
      this.lastSeen = this.now();
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.boundPort}`);
      if (url.pathname === '/bridge/hello' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, name: 'bookfish', version: BRIDGE_VERSION, port: this.boundPort });
        return;
      }
      if (url.pathname === '/bridge/jobs' && request.method === 'GET') {
        await this.pollJobs(response);
        return;
      }
      const match = /^\/bridge\/jobs\/([0-9a-f-]{36})\/(page|chunk|done|fail)$/u.exec(url.pathname);
      if (!match) {
        sendJson(response, 404, { ok: false, code: 'not_found', message: 'Unknown bridge route' });
        return;
      }
      const jobId = match[1] ?? '';
      const action = match[2] ?? '';
      const entry = this.pending.get(jobId);
      if (!entry || entry.settled) {
        sendJson(response, 409, { ok: false, code: 'job_unknown', message: 'That bridge job is no longer waiting' });
        return;
      }
      try {
        if (action === 'page') {
        const body = await readJson(request, MAX_PAGE_BYTES + 1024);
        const html = typeof body.html === 'string' ? body.html : '';
        if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new BridgeError('too_large', 'The page is too large to hand back', false);
        const finalUrl = typeof body.finalUrl === 'string' && body.finalUrl ? body.finalUrl : entry.job.url;
        await this.verifyLanded(finalUrl, entry.allowNetwork);
        this.settleSuccess(entry, { html, finalUrl });
        sendJson(response, 200, { ok: true });
        return;
      }
      if (action === 'chunk') {
        if (entry.job.kind !== 'file') throw new BridgeError('invalid_input', 'This job does not accept bytes', false);
        const raw = await readBody(request, MAX_CHUNK_BYTES);
        const received = (entry.bytes ?? 0) + raw.length;
        if (received > entry.job.maxBytes) {
          this.settleFailure(entry, new DownloadError('too_large', `The file is larger than ${entry.job.maxBytes} bytes`, false));
          sendJson(response, 413, { ok: false, code: 'too_large', message: 'The file is too large' });
          return;
        }
        appendFileSync(entry.partPath!, raw);
        entry.hash?.update(raw);
        entry.bytes = received;
        sendJson(response, 200, { ok: true, received });
        return;
      }
      if (action === 'done') {
        const body = await readJson(request);
        const finalUrl = typeof body.finalUrl === 'string' && body.finalUrl ? body.finalUrl : entry.job.url;
        await this.verifyLanded(finalUrl, entry.allowNetwork);
        const contentType = typeof body.contentType === 'string' ? body.contentType : undefined;
        this.assertContentType(contentType, finalUrl);
        const sha256 = entry.hash?.digest('hex') ?? createHash('sha256').digest('hex');
        if (typeof body.sha256 === 'string' && body.sha256 && body.sha256 !== sha256) {
          this.settleFailure(entry, new DownloadError('download_failed', 'The bytes changed in transit', true));
          sendJson(response, 409, { ok: false, code: 'checksum', message: 'The sent checksum does not match' });
          return;
        }
        this.settleSuccess(entry, { finalUrl, contentType, sha256, bytes: entry.bytes ?? 0 });
        sendJson(response, 200, { ok: true });
        return;
      }
      this.settleFailure(entry, this.mapFailure(await readJson(request)));
      sendJson(response, 200, { ok: true });
      } catch (error) {
        // The job must not hang: whatever went wrong here is that job's failure.
        this.settleFailure(entry, error instanceof Error ? error : new Error('Bridge request failed'));
        throw error;
      }
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : error instanceof DownloadError ? error.code : 'invalid_input';
      const message = error instanceof Error ? error.message : 'Bridge request failed';
      if (!response.headersSent) sendJson(response, code === 'too_large' ? 413 : 400, { ok: false, code, message });
      else response.end();
    }
  }

  private mapFailure(body: Record<string, unknown>): Error {
    const code = typeof body.code === 'string' ? body.code : 'download_failed';
    const message = typeof body.message === 'string' ? body.message : 'The browser could not fetch that address';
    if (code === 'permission_missing') return new DownloadError('policy_blocked', message, false);
    if (code === 'network' || code === 'network_error') return new DownloadError('network', message, true);
    if (code === 'http_error') return new DownloadError('http_error', message, true);
    if (code === 'cancelled') return new DownloadError('cancelled', message, true);
    return new DownloadError('download_failed', message, true);
  }

  private assertContentType(contentType: string | undefined, url: string): void {
    if (!contentType) return;
    if (TEXT_CONTENT_TYPE.test(contentType)) return;
    if (/^(text\/html|application\/xhtml\+xml)/iu.test(contentType)) {
      throw new DownloadError('download_failed', 'The address returned an HTML page, not a text file', false);
    }
    throw new DownloadError('download_failed', `Unexpected content type ${contentType} for ${url}`, false);
  }

  /** The browser follows redirects itself, so the address it landed on is what counts. */
  private async verifyLanded(landed: string, allowNetwork: boolean): Promise<void> {
    if (!landed) throw new DownloadError('policy_blocked', 'The browser did not report where it landed', false);
    try {
      await checkUrl(landed, { allowNetwork, ...(this.options.resolve ? { resolve: this.options.resolve } : {}) });
    } catch (error) {
      throw new DownloadError('policy_blocked', error instanceof Error ? error.message : 'Landing address refused', false);
    }
  }

  private settleSuccess(entry: Pending, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.job.id);
    entry.settle({ ok: true, value });
  }

  private settleFailure(entry: Pending, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.job.id);
    entry.settle({ ok: false, error });
  }

  private nextJob(): BridgeJob | undefined {
    const entry = this.pending.values().next().value as Pending | undefined;
    return entry?.settled ? undefined : entry?.job;
  }

  private notify(): void {
    for (const waiter of [...this.waiting]) {
      this.waiting.delete(waiter);
      waiter(this.nextJob());
    }
  }

  private async pollJobs(response: ServerResponse): Promise<void> {
    const immediate = this.nextJob();
    if (immediate) {
      sendJson(response, 200, { ok: true, job: immediate });
      return;
    }
    const job = await new Promise<BridgeJob | undefined>((resolve) => {
      let done = false;
      const finish = (value: BridgeJob | undefined): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiting.delete(finish);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), LONG_POLL_MS);
      this.waiting.add(finish);
      response.once('close', () => finish(undefined));
    });
    if (response.writableEnded) return;
    sendJson(response, 200, { ok: true, job: job ?? null });
  }

  private createPending(job: BridgeJob, allowNetwork: boolean, timeoutMs: number, extra: Partial<Pending> = {}): Pending {
    if (this.pending.size >= MAX_WAITING_JOBS) throw new BridgeError('busy', 'The browser bridge is already handling other work');
    let settleFn: (outcome: Settled) => void = () => undefined;
    const promise = new Promise<Settled>((resolve) => { settleFn = resolve; });
    const entry: Pending = {
      job,
      allowNetwork,
      promise,
      settled: false,
      timer: setTimeout(() => {
        this.settleFailure(entry, new BridgeError('bridge_timeout', 'The browser did not answer in time; is the extension connected?'));
      }, timeoutMs),
      settle: settleFn,
      ...extra,
    };
    this.pending.set(job.id, entry);
    this.notify();
    return entry;
  }

  async fetchPage(url: string, options: { allowNetwork: boolean; timeoutMs?: number }): Promise<{ html: string; finalUrl: string }> {
    if (!this.running) throw new BridgeError('bridge_offline', 'Start the BookFish browser bridge in settings first');
    const entry = this.createPending({ id: randomUUID(), kind: 'page', url }, options.allowNetwork, options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    const outcome = await entry.promise;
    if (!outcome.ok) throw outcome.error;
    return outcome.value as { html: string; finalUrl: string };
  }

  async fetchFile(request: BridgeFileRequest): Promise<BridgeFileResult> {
    if (!this.running) throw new BridgeError('bridge_offline', 'Start the BookFish browser bridge in settings first');
    const partPath = request.staging.partialPath(request.taskId);
    const entry = this.createPending(
      { id: randomUUID(), kind: 'file', url: request.url, maxBytes: MAX_BOOK_BYTES, filename: request.filename },
      request.allowNetwork,
      request.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      { partPath, hash: createHash('sha256'), bytes: 0 },
    );
    const onAbort = (): void => { this.settleFailure(entry, new DownloadError('cancelled', 'Download cancelled', true)); };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const outcome = await entry.promise;
      if (!outcome.ok) throw outcome.error;
      const result = outcome.value as { finalUrl: string; contentType?: string; sha256: string; bytes: number };
      return { partPath, bytes: result.bytes, sha256: result.sha256, ...(result.contentType ? { contentType: result.contentType } : {}), finalUrl: result.finalUrl };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
