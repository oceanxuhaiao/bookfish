import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BOOK_BYTES } from '../books.ts';
import { DownloadError, TEXT_CONTENT_TYPE } from './download.ts';
import type { AcquisitionStaging } from './staging.ts';
import { checkUrl, type HostResolver } from './url-policy.ts';

export const BRIDGE_VERSION = 2;
export const DEFAULT_BRIDGE_PORT = 47823;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const LONG_POLL_MS = 25_000;

export class BridgeError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable = true) { super(message); this.name = 'BridgeError'; }
}
export interface BridgeOptions {
  dataDir: string; port?: number; now?: () => number; resolve?: HostResolver; allowOrigins?: string[];
  /** Operator-supplied protection, independent of extension claims. Missing protection fails closed. */
  authorize?: (url: string) => Promise<void>;
  networkAllowed?: () => boolean;
  leaseMs?: number;
}
export interface BridgeFileRequest {
  url: string; taskId: string; staging: AcquisitionStaging; filename: string; allowNetwork: boolean; signal?: AbortSignal; timeoutMs?: number;
}
export interface BridgeFileResult { partPath: string; bytes: number; sha256: string; contentType?: string; finalUrl: string }
interface BridgeJob { id: string; kind: 'page' | 'file'; url: string; maxBytes: number; filename?: string }
interface Lease { consumer: string; token: string; expiresAt: number; attempt: string }
interface Pending {
  job: BridgeJob; allowNetwork: boolean; timer: NodeJS.Timeout; settled: boolean; busy: boolean;
  promise: Promise<Settled>; settle: (outcome: Settled) => void; lease?: Lease;
  staging?: AcquisitionStaging; taskId?: string; partPath?: string; hash?: ReturnType<typeof createHash>; bytes: number; sequence: number;
}
type Settled = { ok: true; value: unknown } | { ok: false; error: Error };
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
}
function header(req: IncomingMessage, name: string): string { const value = req.headers[name]; return Array.isArray(value) ? value[0] ?? '' : value ?? ''; }
function sameSecret(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length > 0 && left.length === right.length && timingSafeEqual(left, right); }
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const value of req) { const part = value as Buffer; bytes += part.length; if (bytes > max) throw new BridgeError('too_large', 'Bridge request is too large', false); parts.push(part); }
  return Buffer.concat(parts);
}
async function readJson(req: IncomingMessage, max = 64 * 1024): Promise<Record<string, unknown>> {
  try { const value: unknown = JSON.parse((await readBody(req, max)).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('invalid_input', 'Expected a JSON object', false); }
}

/** Authenticated loopback transport. Only a claimed attempt can mutate its own temporary file. */
export class BrowserBridge {
  private server?: Server; private pairingToken = ''; private boundPort = 0; private lastSeen = 0;
  private sweep?: NodeJS.Timeout;
  private readonly pending = new Map<string, Pending>();
  private readonly waiting = new Set<() => void>();
  constructor(private readonly options: BridgeOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  get running(): boolean { return this.server !== undefined; }
  get port(): number { return this.boundPort; }
  get connected(): boolean { return this.lastSeen > 0 && this.now() - this.lastSeen < 90_000; }
  private loadToken(): string {
    const path = join(this.options.dataDir, 'bridge.json');
    try { const value = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }; if (typeof value.token === 'string' && value.token.length >= 16) return value.token; } catch { /* generate a new pairing */ }
    mkdirSync(this.options.dataDir, { recursive: true }); const token = randomBytes(24).toString('base64url'); writeFileSync(path, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 }); return token;
  }
  async start(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.boundPort, token: this.pairingToken };
    this.pairingToken = this.loadToken(); const server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((ok, no) => { server.once('error', no); server.listen(this.options.port ?? DEFAULT_BRIDGE_PORT, '127.0.0.1', () => { server.off('error', no); ok(); }); });
    this.boundPort = (server.address() as { port: number }).port; this.server = server;
    this.sweep = setInterval(() => { this.expireLeases(); this.notify(); }, Math.min(1000, this.options.leaseMs ?? 30_000)); this.sweep.unref();
    return { port: this.boundPort, token: this.pairingToken };
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined; clearInterval(this.sweep);
    for (const entry of this.pending.values()) this.finish(entry, { ok: false, error: new BridgeError('cancelled', 'The browser bridge stopped') });
    this.notify(); if (server) { server.closeIdleConnections(); await new Promise<void>(ok => server.close(() => ok())); }
  }
  info(): { port: number; token: string; connected: boolean; lastSeen: number } { return { port: this.boundPort, token: this.pairingToken, connected: this.connected, lastSeen: this.lastSeen }; }
  private networkAllowed(entry: Pending): boolean { return entry.allowNetwork && (this.options.networkAllowed?.() ?? true); }
  private async preflight(url: string, allowNetwork: boolean): Promise<string> {
    const checked = await checkUrl(url, { allowNetwork: allowNetwork && (this.options.networkAllowed?.() ?? true), resolve: this.options.resolve });
    if (!this.options.authorize) throw new BridgeError('policy_blocked', 'A protected browser instance must be configured before network jobs can run', false);
    await this.options.authorize(checked.href); return checked.href;
  }
  private assertLease(entry: Pending, req: IncomingMessage): void {
    if (entry.settled || !this.pending.has(entry.job.id) || !entry.lease || entry.lease.expiresAt <= this.now() ||
      header(req, 'x-bookfish-consumer') !== entry.lease.consumer || !sameSecret(header(req, 'x-bookfish-lease'), entry.lease.token)) {
      throw new BridgeError('lease_stale', 'This attempt no longer owns the job', false);
    }
    if (!this.networkAllowed(entry)) throw new BridgeError('policy_blocked', 'Network access is disabled', false);
  }
  private removePart(entry: Pending): void { if (entry.partPath) { rmSync(entry.partPath, { force: true }); entry.partPath = undefined; } }
  private finish(entry: Pending, outcome: Settled): void {
    if (entry.settled) return;
    entry.settled = true; clearTimeout(entry.timer); this.pending.delete(entry.job.id);
    if (!outcome.ok) { try { this.removePart(entry); } catch { outcome = { ok: false, error: new BridgeError('storage_unavailable', 'Could not clean the incomplete download') }; } }
    entry.settle(outcome);
  }
  private expireLeases(): void {
    for (const entry of this.pending.values()) {
      if (!this.networkAllowed(entry)) { this.finish(entry, { ok: false, error: new BridgeError('policy_blocked', 'Network access is disabled', false) }); continue; }
      if (entry.lease && entry.lease.expiresAt <= this.now() && !entry.busy) {
        try { this.removePart(entry); entry.lease = undefined; entry.bytes = 0; entry.sequence = 0; entry.hash = undefined; }
        catch { this.finish(entry, { ok: false, error: new BridgeError('storage_unavailable', 'Could not clear an expired attempt') }); }
      }
    }
  }
  private nextJob(consumer: string): Record<string, unknown> | undefined {
    this.expireLeases();
    for (const entry of this.pending.values()) {
      if (entry.settled || entry.lease || entry.busy) continue;
      const lease: Lease = { consumer, token: randomUUID(), attempt: randomUUID(), expiresAt: this.now() + (this.options.leaseMs ?? 30_000) };
      if (entry.staging) {
        entry.partPath = entry.staging.partialPath(`${entry.taskId}-${lease.attempt}`);
        try { writeFileSync(entry.partPath, Buffer.alloc(0), { flag: 'wx' }); entry.hash = createHash('sha256'); }
        catch { this.finish(entry, { ok: false, error: new BridgeError('storage_unavailable', 'Could not initialize a download attempt') }); continue; }
      }
      entry.lease = lease; return { ...entry.job, lease: lease.token, attemptId: lease.attempt, leaseMs: this.options.leaseMs ?? 30_000 };
    }
    return undefined;
  }
  private notify(): void { for (const wake of [...this.waiting]) wake(); }
  private async poll(req: IncomingMessage, res: ServerResponse, immediate: boolean): Promise<void> {
    const consumer = header(req, 'x-bookfish-consumer');
    if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(consumer)) throw new BridgeError('invalid_input', 'A consumer identity is required', false);
    const job = this.nextJob(consumer); if (job || immediate || !this.running) { sendJson(res, 200, { ok: true, job: job ?? null }); return; }
    if (this.waiting.size >= 16) throw new BridgeError('busy', 'Too many bridge pollers');
    await new Promise<void>(ok => {
      const finish = (job?: Record<string, unknown>): void => { clearTimeout(timer); this.waiting.delete(wake); sendJson(res, 200, { ok: true, job: job ?? null }); ok(); };
      const wake = (): void => { const next = this.running ? this.nextJob(consumer) : undefined; if (next || !this.running) finish(next); };
      const timer = setTimeout(() => finish(), LONG_POLL_MS); this.waiting.add(wake);
      res.once('close', () => { clearTimeout(timer); this.waiting.delete(wake); ok(); });
    });
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const origin = req.headers.origin;
      if (origin && !this.options.allowOrigins?.includes(origin) && !/^chrome-extension:\/\/[a-z0-9]{16,}$/iu.test(origin) && !/^moz-extension:\/\/[0-9a-f-]{16,}$/iu.test(origin)) { sendJson(res, 403, { code: 'policy_blocked' }); return; }
      if (!sameSecret(header(req, 'x-bookfish-token'), this.pairingToken)) { sendJson(res, 401, { code: 'unauthorized' }); return; }
      this.lastSeen = this.now(); const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort}`);
      if (req.method === 'GET' && url.pathname === '/bridge/hello') { sendJson(res, 200, { ok: true, name: 'bookfish', version: BRIDGE_VERSION, port: this.boundPort }); return; }
      if (req.method === 'GET' && url.pathname === '/bridge/jobs') { await this.poll(req, res, url.searchParams.get('wait') === '0'); return; }
      const match = /^\/bridge\/jobs\/([0-9a-f-]{36})\/(page|chunk|done|fail|heartbeat)$/u.exec(url.pathname);
      if (req.method !== 'POST' || !match) { sendJson(res, 404, { code: 'not_found' }); return; }
      const entry = this.pending.get(match[1]!); if (!entry) { sendJson(res, 409, { code: 'job_unknown' }); return; }
      this.assertLease(entry, req);
      if (match[2] === 'heartbeat') { entry.lease!.expiresAt = this.now() + (this.options.leaseMs ?? 30_000); sendJson(res, 200, { ok: true }); return; }
      if (entry.busy) { sendJson(res, 409, { code: 'job_busy' }); return; }
      entry.busy = true;
      try {
        const action = match[2];
        if (action === 'chunk') {
          if (entry.job.kind !== 'file') throw new BridgeError('invalid_input', 'This job does not accept file chunks', false);
          const raw = await readBody(req, MAX_CHUNK_BYTES); this.assertLease(entry, req);
          const sequence = Number(header(req, 'x-bookfish-sequence'));
          if (!header(req, 'x-bookfish-sequence') || !Number.isSafeInteger(sequence) || sequence !== entry.sequence) { sendJson(res, 409, { code: 'sequence_invalid' }); return; }
          if (entry.bytes + raw.length > MAX_BOOK_BYTES) throw new BridgeError('too_large', 'The file is too large', false);
          appendFileSync(entry.partPath!, raw); entry.hash!.update(raw); entry.bytes += raw.length; entry.sequence++;
          entry.lease!.expiresAt = this.now() + (this.options.leaseMs ?? 30_000); sendJson(res, 200, { ok: true, received: entry.bytes }); return;
        }
        const body = await readJson(req, action === 'page' ? MAX_PAGE_BYTES * 6 + 1024 : 64 * 1024); this.assertLease(entry, req);
        if (action === 'fail') {
          const allowed = new Set(['policy_blocked', 'permission_missing', 'too_large', 'network', 'network_error', 'http_error', 'cancelled', 'timeout']);
          const code = typeof body.code === 'string' && allowed.has(body.code) ? body.code : 'download_failed';
          this.finish(entry, { ok: false, error: new DownloadError(code === 'permission_missing' ? 'policy_blocked' : code, 'The browser could not complete the transfer', !['policy_blocked', 'permission_missing', 'too_large'].includes(code)) });
          sendJson(res, 200, { ok: true }); return;
        }
        const finalUrl = await this.preflight(typeof body.finalUrl === 'string' ? body.finalUrl : entry.job.url, entry.allowNetwork); this.assertLease(entry, req);
        if (finalUrl !== entry.job.url) throw new BridgeError('policy_blocked', 'Automatic browser redirects are not allowed; discover the final address again', false);
        if (action === 'page') {
          if (entry.job.kind !== 'page' || typeof body.html !== 'string') throw new BridgeError('invalid_input', 'Expected a page result', false);
          if (Buffer.byteLength(body.html, 'utf8') > MAX_PAGE_BYTES) throw new BridgeError('too_large', 'The page is too large', false);
          this.finish(entry, { ok: true, value: { html: body.html, finalUrl } }); sendJson(res, 200, { ok: true }); return;
        }
        if (entry.job.kind !== 'file') throw new BridgeError('invalid_input', 'Expected a file result', false);
        const contentType = typeof body.contentType === 'string' ? body.contentType : undefined;
        if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) throw new DownloadError('download_failed', /html/iu.test(contentType) ? 'The address returned an HTML page, not a text file' : 'The server returned an unsupported content type', false);
        if (typeof body.bytes !== 'number' || body.bytes !== entry.bytes) throw new DownloadError('download_failed', 'The browser byte count does not match', true);
        const incomingHash = entry.hash!.digest('hex'); const disk = createHash('sha256'); const fd = openSync(entry.partPath!, 'r'); let diskBytes = 0;
        try { const buffer = Buffer.alloc(256 * 1024); for (;;) { const count = readSync(fd, buffer); if (!count) break; diskBytes += count; disk.update(buffer.subarray(0, count)); } if (diskBytes !== fstatSync(fd).size) throw new Error('size'); } finally { closeSync(fd); }
        const digest = disk.digest('hex');
        if (diskBytes !== entry.bytes || digest !== incomingHash || (typeof body.sha256 === 'string' && body.sha256 !== digest)) throw new DownloadError('download_failed', 'The stored bytes do not match the transfer', true);
        this.finish(entry, { ok: true, value: { finalUrl, contentType, sha256: digest, bytes: diskBytes, partPath: entry.partPath! } }); sendJson(res, 200, { ok: true });
      } catch (error) {
        if (!(error instanceof BridgeError && error.code === 'lease_stale')) this.finish(entry, { ok: false, error: error instanceof Error ? error : new BridgeError('download_failed', 'Transfer failed') });
        throw error;
      } finally { entry.busy = false; }
    } catch (error) {
      const code = error instanceof BridgeError || error instanceof DownloadError ? error.code : 'download_failed';
      sendJson(res, code === 'lease_stale' ? 409 : code === 'too_large' ? 413 : 400, { ok: false, code, message: 'The bridge could not accept this transfer' });
    }
  }
  private create(job: BridgeJob, allowNetwork: boolean, timeout: number, file?: { staging: AcquisitionStaging; taskId: string }): Pending {
    if (this.pending.size >= 4) throw new BridgeError('busy', 'The browser bridge is busy');
    let settle!: (outcome: Settled) => void; const promise = new Promise<Settled>(ok => { settle = ok; });
    const entry: Pending = { job, allowNetwork, promise, settle, settled: false, busy: false, bytes: 0, sequence: 0,
      timer: setTimeout(() => this.finish(entry, { ok: false, error: new BridgeError('bridge_timeout', 'The browser did not answer in time') }), timeout), ...file };
    this.pending.set(job.id, entry); this.notify(); return entry;
  }
  async fetchPage(url: string, options: { allowNetwork: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<{ html: string; finalUrl: string }> {
    if (!this.running) throw new BridgeError('bridge_offline', 'The browser bridge is not running');
    options.signal?.throwIfAborted(); const checked = await this.preflight(url, options.allowNetwork); options.signal?.throwIfAborted(); if (!this.running) throw new BridgeError('bridge_offline', 'The browser bridge stopped');
    const entry = this.create({ id: randomUUID(), kind: 'page', url: checked, maxBytes: MAX_PAGE_BYTES }, options.allowNetwork, options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    const abort = (): void => this.finish(entry, { ok: false, error: new BridgeError('cancelled', 'Page request cancelled') });
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    try { const outcome = await entry.promise; if (!outcome.ok) throw outcome.error; return outcome.value as { html: string; finalUrl: string }; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  async fetchFile(request: BridgeFileRequest): Promise<BridgeFileResult> {
    if (!this.running) throw new BridgeError('bridge_offline', 'The browser bridge is not running');
    request.signal?.throwIfAborted(); const checked = await this.preflight(request.url, request.allowNetwork); request.signal?.throwIfAborted();
    if (!this.running) throw new BridgeError('bridge_offline', 'The browser bridge stopped');
    const entry = this.create({ id: randomUUID(), kind: 'file', url: checked, maxBytes: MAX_BOOK_BYTES, filename: request.filename }, request.allowNetwork, request.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS, { staging: request.staging, taskId: request.taskId });
    const abort = (): void => this.finish(entry, { ok: false, error: new DownloadError('cancelled', 'Download cancelled', true) });
    request.signal?.addEventListener('abort', abort, { once: true }); if (request.signal?.aborted) abort();
    try { const outcome = await entry.promise; if (!outcome.ok) throw outcome.error; return outcome.value as BridgeFileResult; }
    finally { request.signal?.removeEventListener('abort', abort); }
  }
}
