/**
 * Acquisition orchestration: discovery, download, quality gate, loose import and
 * recovery. It owns staged files and task records only — books still enter the
 * shelf through Library, and autonomous queueing still belongs to
 * SelectionCoordinator.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BookfishConfigSection } from '../config.ts';
import type { Library } from '../library.ts';
import { BestEffortRejected, AuthenticatedInputError, prepareFileBestEffort, type BestEffortDecoded } from '../stream-import.ts';
import { BrowserClient, BrowserError } from './browser-client.ts';
import { BridgeError, BrowserBridge } from './bridge.ts';
import { DownloadError, downloadFile } from './download.ts';
import { discoverLinks, extractIdentity } from './link-discovery.ts';
import { assessText, identityMatch, type Assessment, type IdentityMatch } from './quality.ts';
import { AcquisitionRecords } from './records.ts';
import { AcquisitionStaging, OriginalFileError, maintenanceFailure, type MaintenanceResult } from './staging.ts';
import {
  CANDIDATE_TTL_MS, MAX_CANDIDATES, MAX_TASKS, assertTransition, failureRecoverable, isTerminal,
  type AcquisitionOrigin, type AcquisitionStatus, type AcquisitionTask, type CandidateRecord,
  type DetectedEncoding, type FileFormat, type QualityReport, type TaskView, type DiscoveredLink,
} from './types.ts';
import { checkUrl, hostOf, isPolicyError, type HostResolver } from './url-policy.ts';
import { redactMessage, sourceReference } from './privacy.ts';

export interface PageLoadResult { html: string; close: () => Promise<void> }
export type PageLoader = (url: string, options: { allowNetwork: boolean; port: number; resolve?: HostResolver; signal?: AbortSignal }) => Promise<PageLoadResult>;

export interface AcquisitionOptions {
  onTaskCreated?: (task:AcquisitionTask)=>void;
  /** Durable task facts are replayable; notification failure never undoes a shelf insert. */
  onTaskStateChanged?: (task: AcquisitionTask) => void | Promise<void>;
  dataDir: string;
  library: Library;
  cfg: () => BookfishConfigSection;
  now?: () => number;
  fetchImpl?: typeof fetch;
  resolve?: HostResolver;
  pageLoader?: PageLoader;
  /** Test seam for the loopback bridge; production builds create their own. */
  bridge?: BrowserBridge;
  /** Supplied by the operator controller after enforcing the browser network boundary. */
  browserGuard?: (url: string) => Promise<void>;
  controllerReady?: () => boolean;
  /** Called after a successful shelf insert so autonomous selection can finish its intent. */
  onImported?: (task: AcquisitionTask, identity: IdentityMatch) => void | Promise<void>;
}

export interface ImportOutcome {
  task: TaskView;
  quality?: QualityReport;
  duplicate?: boolean;
}

class AcquisitionFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AcquisitionFailure';
  }
}

/**
 * Defense in depth after the request interception and external network guard.
 * This final URL check is not a request-before-connect SSRF boundary.
 */
export async function verifyLandedUrl(landed: unknown, options: { allowNetwork: boolean; resolve?: HostResolver }): Promise<void> {
  if (typeof landed !== 'string' || !landed.trim()) throw new BrowserError('policy_blocked', 'The browser did not report where the page landed');
  await checkUrl(landed, { allowNetwork: options.allowNetwork, ...(options.resolve ? { resolve: options.resolve } : {}) });
}

const defaultPageLoader = (fetchImpl?: typeof fetch): PageLoader => async (url, options) => {
  if (!options.port) throw new BrowserError('browser_unavailable', 'No browser debug port is configured');
  const client = new BrowserClient(options.port, fetchImpl ?? fetch);
  options.signal?.throwIfAborted();
  const page = await client.createPage();
  const abort = (): void => { void page.close().then(() => client.disconnect()).catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await page.protectNavigation(url);
    await page.navigate(url);
    await verifyLandedUrl(await page.evaluate<string>('location.href'), { allowNetwork: options.allowNetwork, ...(options.resolve ? { resolve: options.resolve } : {}) });
    const html = page.html();
    return { html, close: async () => { await page.close(); await client.disconnect(); } };
  } catch (error) {
    await page.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
    throw error;
  } finally { options.signal?.removeEventListener('abort', abort); }
};

function slugTitle(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '_').trim().slice(0, 120);
}

export class TxtAcquisition {
  readonly root: string;
  readonly staging: AcquisitionStaging;
  readonly records: AcquisitionRecords;
  private readonly library: Library;
  private readonly cfg: () => BookfishConfigSection;
  private readonly now: () => number;
  private readonly fetchImpl?: typeof fetch;
  private readonly resolve?: HostResolver;
  private readonly pageLoader: PageLoader;
  private bridge: BrowserBridge | undefined;
  private readonly controllerReady: () => boolean;
  private readonly browserGuard?: (url: string) => Promise<void>;
  private readonly pageUrls = new Map<string, string>();
  private readonly onImported?: (task: AcquisitionTask, identity: IdentityMatch) => void | Promise<void>;
  private stopped = false;
  selectionPersistenceError: string | undefined;
  initializationError: string | undefined;
  /** Candidate URLs stay in memory only; records carry their digest. */
  private readonly urls = new Map<string, { taskId: string; url: string }>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly onTaskCreated?:AcquisitionOptions['onTaskCreated'];
  private readonly onTaskStateChanged?:AcquisitionOptions['onTaskStateChanged'];
  private policyTimer?:ReturnType<typeof setInterval>;

  constructor(options: AcquisitionOptions) {
    this.root = join(options.dataDir, 'bookfish', 'txt-acquisition');
    this.staging = new AcquisitionStaging(this.root);
    this.records = new AcquisitionRecords(this.root,initialize=>initialize?this.staging.initializeDirectories():this.staging.assertSafeDirectories());
    this.onTaskCreated=options.onTaskCreated;
    this.onTaskStateChanged=options.onTaskStateChanged;
    this.library = options.library;
    this.cfg = options.cfg;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl;
    this.resolve = options.resolve;
    this.pageLoader = options.pageLoader ?? (async (url, settings) => {
      if (!this.browserGuard) throw new BrowserError('policy_blocked', 'A protected browser controller is required');
      if (!this.controllerReady()) throw new BrowserError('policy_blocked', 'Protected controller is not ready');
      await this.browserGuard(url); return defaultPageLoader(options.fetchImpl)(url, settings);
    });
    this.bridge = options.bridge;
    this.browserGuard = options.browserGuard;
    this.controllerReady = () => Boolean(options.browserGuard) && options.controllerReady?.() === true;
    if (options.onImported) this.onImported = options.onImported;
  }

  private importQueue: Promise<void> = Promise.resolve();
  private waitingImports = 0;
  private maintenance: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {
    this.stopped = false;
    try {
    await this.staging.init();
    this.records.load(this.now()); this.initializationError = undefined;
    await this.recoverRawCommits();
    await this.staging.clearAbandonedPrepared();
    this.recover();
    await this.prune();
    } catch {
      this.initializationError = 'Acquisition storage unavailable; original files preserved and acquisition disabled';
      throw new OriginalFileError('storage_unavailable', this.initializationError);
    }
    // A busy port must not stop reading; the failure surfaces on the first task.
    this.policyTimer=setInterval(()=>this.onConfigChanged(),100);this.policyTimer.unref?.();
    try { await this.ensureBridge(); } catch { /* reported by discover or import */ }
  }

  /**
   * The bridge is the browser-extension route: the world only listens on loopback
   * and the extension polls it. It is off unless the user turns it on, and it
   * never replaces the explicit CDP port.
   */
  private async ensureBridge(): Promise<BrowserBridge | undefined> {
    const cfg = this.cfg();
    if (cfg.browserBridgeEnabled !== true) {
      const existing = this.bridge;
      this.bridge = undefined;
      if (existing?.running) await existing.stop().catch(() => undefined);
      return undefined;
    }
    if (this.bridge?.running) return this.bridge;
    if (!this.bridge) {
      this.bridge = new BrowserBridge({
        dataDir: this.root,
        authorize: this.browserGuard ? async url => { if (!this.controllerReady()) throw new BrowserError('policy_blocked', 'Protected controller is not ready'); await this.browserGuard!(url); } : undefined,
        networkAllowed: () => this.cfg().allowNetwork && this.controllerReady(),
        ...(typeof cfg.browserBridgePort === 'number' && cfg.browserBridgePort > 0 ? { port: cfg.browserBridgePort } : {}),
        ...(this.resolve ? { resolve: this.resolve } : {}),
      });
    }
    await this.bridge.start();
    return this.bridge;
  }

  private get readiness() {
    const transportConnected = this.bridge?.connected === true;
    const controllerReady = this.controllerReady();
    const browserReady = !this.initializationError && this.cfg().allowNetwork && this.cfg().txtAcquisitionEnabled === true && this.cfg().browserBridgeEnabled === true && transportConnected && controllerReady;
    return { transportConnected, controllerReady, browserReady, unavailableReason: !controllerReady ? 'Protected isolated browser controller is not ready' : !transportConnected ? 'Extension transport is disconnected' : !browserReady ? 'Network or acquisition is disabled' : null };
  }

  /** Pairing details for the extension popup; the token never reaches the model. */
  get bridgeInfo() {
    const info = this.bridge?.info();
    return {
      ...this.readiness,
      enabled: this.cfg().browserBridgeEnabled === true,
      running: this.bridge?.running === true,
      connected: this.bridge?.connected === true,
      port: info?.port ?? 0,
      token: info?.token ?? '',
    };
  }

  /** A restart interrupts every in-flight task; files are kept for a later retry. */
  recover(): void {
    for (const task of this.records.list()) {
      if (task.status === 'completed' || task.status === 'completed_with_warning' || task.status === 'failed_terminal') continue;
      if (task.status === 'failed_recoverable') continue;
      this.fail(task.id, 'restart_interrupted', 'The extension restarted before this acquisition finished');
      void this.staging.clearPrepared(task.id);
    }
  }

  list(): TaskView[] {
    if (this.initializationError) throw new OriginalFileError('storage_unavailable', this.initializationError);
    return this.records.list().map((task) => this.view(task));
  }

  /** Small status block for the model; full task detail stays behind `status`. */
  summary() {
    const tasks = this.initializationError ? [] : this.records.list();
    return {
      enabled: this.cfg().txtAcquisitionEnabled === true,
      ...this.readiness,
      browserConfigured: this.readiness.browserReady,
      maintenance: this.lastMaintenance ?? null,
      selectionPersistenceError: this.selectionPersistenceError ?? null,
      initializationError: this.initializationError ?? null,
      active: tasks.filter((task) => !isTerminal(task.status)).length,
      history: { records: tasks.length, softLimit: MAX_TASKS, retainedOriginals: tasks.filter(task => task.file?.retained).length, protectedOverflow: Math.max(0, tasks.length - MAX_TASKS), pendingSelectionReceipts: tasks.filter(task => ['pending','failed'].includes(task.selection?.status ?? '')).length, newTaskReceiptLimit: MAX_TASKS },
      tasks: tasks.slice(-5).map((task) => ({
        taskId: task.id, status: task.status, title: task.target.title, updatedAt: task.updatedAt,
        ...(task.bookKey ? { bookKey: task.bookKey } : {}),
      })),
    };
  }

  status(taskId?: string): TaskView | TaskView[] {
    if (this.initializationError) throw new OriginalFileError('storage_unavailable', this.initializationError);
    if (!taskId) return this.list();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    return this.view(task);
  }

  cancel(taskId: string, code: 'cancelled' | 'restart_interrupted' = 'cancelled'): TaskView {
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (task.status === 'completed' || task.status === 'completed_with_warning') return this.view(task);
    if (task.status === 'failed_terminal' || task.status === 'failed_recoverable') return this.view(task);
    this.aborts.get(taskId)?.abort(new AcquisitionFailure(code, code === 'cancelled' ? 'Cancelled by the model or user' : 'World stopped before acquisition completed'));
    return this.view(this.fail(taskId, code, code === 'cancelled' ? 'Cancelled by the model or user' : 'World stopped; retained data can be retried explicitly'));
  }

  cancelByIntentId(intentId:string,reason?:'restart_interrupted'):void{for(const task of this.records.list())if(task.intentId===intentId&&!isTerminal(task.status))this.cancel(task.id,reason);}
  onConfigChanged():void{
    const cfg=this.cfg();for(const [id,abort] of this.aborts){const task=this.records.get(id);if(!cfg.allowNetwork||!cfg.txtAcquisitionEnabled||(task?.origin==='autonomous'&&!cfg.autonomousAcquisition))abort.abort(new Error('Acquisition permission revoked'));}
  }

  private view(task: AcquisitionTask): TaskView {
    const candidates = task.candidates.map((candidate) => {
      const live = this.urls.get(candidate.id);
      return {
        candidateId: candidate.id,
        filename: candidate.filename,
        format: candidate.format,
        host: candidate.host,
        ...(candidate.title ? { title: candidate.title } : {}),
        ...(candidate.author ? { author: candidate.author } : {}),
        ...(candidate.size ? { size: candidate.size } : {}),
        expiresAt: candidate.expiresAt,
        available: Boolean(live) && candidate.expiresAt > this.now(),
      };
    });
    const nextActions = ((): string[] => {
      switch (task.status) {
        case 'candidate_ready': return candidates.some((candidate) => candidate.available) ? ['import a candidateId'] : ['discover the page again'];
        case 'failed_recoverable': return task.file ? ['repair', 'retry'] : task.pageUrl ? ['retry', 'discover again'] : ['discover again'];
        case 'failed_terminal': return ['discover another page'];
        case 'discovering': case 'downloading': case 'validating': case 'repairing': case 'importing': case 'needs_repair': return ['status'];
        default: return [];
      }
    })();
    return {
      taskId: task.id,
      status: task.status,
      origin: task.origin,
      target: task.target,
      ...(task.intentId ? { intentId: task.intentId } : {}),
      ...(task.pageUrl ? { pageUrl: task.pageUrl, pageUrlHash: task.pageUrlHash, requiresRediscovery: task.requiresRediscovery } : {}),
      sourceHost: task.sourceHost,
      ...(task.bookKey ? { bookKey: task.bookKey } : {}),
      ...(task.selection ? { selection: task.selection } : {}),
      ...(task.duplicate !== undefined ? { duplicate: task.duplicate } : {}),
      ...(task.quality ? { quality: task.quality } : {}),
      ...(task.file ? { file: { filename: task.file.filename, bytes: task.file.bytes, sha256: task.file.sha256, retained: task.file.retained, ...(task.file.contentType ? { contentType: task.file.contentType } : {}) } } : {}),
      candidates,
      ...(task.failure ? { failure: task.failure } : {}),
      ...(task.rejection ? { rejection: task.rejection } : {}),
      nextActions,
      updatedAt: task.updatedAt,
    };
  }

  private requireEnabled(): void {
    if (this.initializationError) throw new OriginalFileError('storage_unavailable', this.initializationError);
    const cfg = this.cfg();
    if (!cfg.txtAcquisitionEnabled) throw new AcquisitionFailure('disabled', 'Browser-assisted TXT acquisition is disabled in settings');
  }

  private setStatus(taskId: string, status: AcquisitionStatus, note?: string): AcquisitionTask {
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (isTerminal(task.status) && !isTerminal(status) && this.records.list().filter(entry => !isTerminal(entry.status)).length >= MAX_TASKS) throw new AcquisitionFailure('busy', 'Active acquisition task limit reached');
    assertTransition(task.status, status);
    const updated = this.records.update(taskId, () => undefined, { status, ...(note ? { note } : {}) });
    // Active state notifications are synchronous in production. Async failures are
    // observed, and restart reconciliation consults the durable task rather than an event.
    if (updated.origin === 'autonomous' && updated.intentId) {
      try { Promise.resolve(this.onTaskStateChanged?.(updated)).catch(() => { this.selectionPersistenceError = 'Task state notification failed; durable task will be reconciled'; }); }
      catch { this.selectionPersistenceError = 'Task state notification failed; durable task will be reconciled'; }
    }
    return updated;
  }

  private fail(taskId: string, code: string, message: string): AcquisitionTask {
    const recoverable = failureRecoverable(code);
    const updated = this.records.update(taskId, (draft) => {
      draft.failure = { code, message: redactMessage(message), recoverable, at: this.now() };
      if (draft.origin === 'autonomous' && draft.intentId && this.onTaskStateChanged) draft.selection = { status: 'pending', identity: draft.selection?.identity ?? 'unknown' };
    }, { status: recoverable ? 'failed_recoverable' : 'failed_terminal', note: code });
    void this.integrateSelection(updated);
    return updated;
  }

  private newTask(input: { title: string; author?: string; pageUrl?: string; origin: AcquisitionOrigin; intentId?: string }): AcquisitionTask {
    if (input.origin === 'autonomous' && input.intentId && this.records.list().filter(task => ['pending','failed'].includes(task.selection?.status ?? '')).length >= MAX_TASKS) throw new AcquisitionFailure('selection_backlog_full', 'Selection receipt backlog is full; reconcile existing tasks before creating another autonomous acquisition');
    if (this.records.list().filter(task => !isTerminal(task.status)).length >= MAX_TASKS) throw new AcquisitionFailure('busy', 'Finish or cancel existing candidate tasks before creating another acquisition');
    const now = this.now();
    const task: AcquisitionTask = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      origin: input.origin,
      ...(input.intentId ? { intentId: input.intentId } : {}),
      target: { title: slugTitle(input.title), ...(input.author ? { author: slugTitle(input.author) } : {}) },
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      sourceHost: input.pageUrl ? hostOf(input.pageUrl) : '',
      candidates: [],
      attempts: { downloads: 0, imports: 0, repairs: 0 },
      history: [{ at: now, status: 'queued' }],
    };
    const created=this.records.put(task);
    try{if(created.origin==='autonomous'&&created.intentId)this.onTaskCreated?.(created);}catch(error){this.cancel(created.id);throw error;}
    return this.records.get(created.id)!;
  }

  private addCandidates(taskId: string, links: DiscoveredLink[]): AcquisitionTask {
    const now = this.now();
    const records = links.slice(0, MAX_CANDIDATES).map((link): CandidateRecord => {
      const candidate: CandidateRecord = {
        id: randomUUID(),
        filename: link.filename,
        format: link.format,
        host: hostOf(link.url),
        urlHash: createHash('sha256').update(link.url).digest('hex'),
        ...(link.title ? { title: link.title } : {}),
        ...(link.author ? { author: link.author } : {}),
        ...(link.size ? { size: link.size } : {}),
        discoveredAt: now,
        expiresAt: now + CANDIDATE_TTL_MS,
      };
      this.urls.set(candidate.id, { taskId, url: link.url });
      return candidate;
    });
    return this.records.update(taskId, (draft) => {
      const known = new Set(draft.candidates.map((candidate) => candidate.urlHash));
      draft.candidates = [...draft.candidates, ...records.filter((candidate) => !known.has(candidate.urlHash))].slice(-MAX_CANDIDATES);
    }, { status: 'candidate_ready', note: `${records.length} candidate(s)` });
  }

  async discover(input: { pageUrl: string; title: string; author?: string; origin?: AcquisitionOrigin; intentId?: string }): Promise<TaskView> {
    await this.maintenance;
    this.requireEnabled();
    const cfg = this.cfg();
    if (!cfg.allowNetwork) throw new AcquisitionFailure('network_disabled', 'Network access is disabled for this world');
    const pageUrl = String(input.pageUrl ?? '').trim();
    const title = String(input.title ?? '').trim();
    if (!pageUrl || !title) throw new AcquisitionFailure('invalid_input', 'pageUrl and title are required');
    const task = this.newTask({ title, ...(input.author ? { author: input.author } : {}), origin: input.origin ?? 'manual', ...(input.intentId ? { intentId: input.intentId } : {}) });
    return await this.runDiscovery(task.id, pageUrl);
  }

  /** Scan a page inside this task; re-running it replaces the stale candidate list. */
  private async runDiscovery(taskId: string, pageUrl: string): Promise<TaskView> {
    if(this.records.get(taskId)?.failure?.code==='cancelled')return this.status(taskId) as TaskView;
    const cfg = this.cfg();
    if (this.aborts.has(taskId)) throw new AcquisitionFailure('invalid_input', 'This task is already active');
    const controller = new AbortController(); this.aborts.set(taskId, controller);
    this.setStatus(taskId, 'discovering');
    try {
      const checked = await checkUrl(pageUrl, { allowNetwork: cfg.allowNetwork, ...(this.resolve ? { resolve: this.resolve } : {}) });
      this.forgetUrls(taskId);
      this.pageUrls.set(taskId, checked.href);
      const source = sourceReference(checked.href);
      this.records.update(taskId, (draft) => { draft.pageUrl = source.url; draft.pageUrlHash = source.sha256; draft.requiresRediscovery = source.requiresRediscovery; draft.sourceHost = checked.hostname; draft.candidates = []; });
      const port = cfg.browserDebugPort ?? 0;
      const bridge = await this.ensureBridge();
      let html: string;
      if (bridge) {
        // Only the protected isolated browser may supply its own authorized login state.
        const page = await bridge.fetchPage(checked.toString(), { allowNetwork: cfg.allowNetwork, signal: controller.signal });
        html = page.html;
      } else {
        if (!port) throw new BrowserError('browser_unavailable', 'Set a browser debug port (for example 9333) or start the BookFish browser extension');
        const page = await this.pageLoader(checked.toString(), { allowNetwork: cfg.allowNetwork, port, signal: controller.signal, ...(this.resolve ? { resolve: this.resolve } : {}) });
        try {
          html = page.html;
        } finally {
          await page.close().catch(() => undefined);
        }
      }
      controller.signal.throwIfAborted();
      const found = discoverLinks(html, checked.toString(), MAX_CANDIDATES);
      if (!found.links.length) {
        this.fail(taskId, 'no_candidates', 'No TXT or Markdown download link was found on that page');
        return this.status(taskId) as TaskView;
      }
      this.addCandidates(taskId, found.links);
      return this.status(taskId) as TaskView;
    } catch (error) {
      if (controller.signal.aborted) this.fail(taskId, controller.signal.reason instanceof AcquisitionFailure ? controller.signal.reason.code : 'cancelled', 'Discovery interrupted'); else this.classifyFailure(taskId, error);
      return this.status(taskId) as TaskView;
    } finally { this.aborts.delete(taskId); await this.prune(); }
  }

  /** Candidate addresses live in memory only, so a new scan drops the old ones. */
  private forgetUrls(taskId: string): void {
    for (const [candidateId, entry] of this.urls) if (entry.taskId === taskId) this.urls.delete(candidateId);
  }

  /** Import a candidate found by `discover`, or a direct file address. */
  async importFile(input: { taskId?: string; candidateId?: string; url?: string; title?: string; author?: string; origin?: AcquisitionOrigin; intentId?: string }): Promise<TaskView> {
    await this.maintenance;
    this.requireEnabled();
    const cfg = this.cfg();
    if (!cfg.allowNetwork) throw new AcquisitionFailure('network_disabled', 'Network access is disabled for this world');
    if (input.url) return this.importDirect(input as { url: string; title: string; author?: string; origin?: AcquisitionOrigin; intentId?: string });
    if (!input.taskId || !input.candidateId) throw new AcquisitionFailure('invalid_input', 'taskId and candidateId are required');
    const task = this.records.get(input.taskId);
    if (!task) throw new Error(`Unknown acquisition task ${input.taskId}`);
    if (task.status === 'completed' || task.status === 'completed_with_warning') return this.view(task);
    const candidate = task.candidates.find((entry) => entry.id === input.candidateId);
    if (!candidate) throw new AcquisitionFailure('candidate_unknown', 'That candidate id is not part of this task');
    if (candidate.expiresAt <= this.now()) {
      this.fail(task.id, 'candidate_expired', 'The candidate list expired; discover the page again');
      return this.status(task.id) as TaskView;
    }
    const live = this.urls.get(candidate.id);
    if (!live) {
      this.fail(task.id, 'candidate_unknown', 'The download address is no longer known; discover the page again');
      return this.status(task.id) as TaskView;
    }
    this.records.update(task.id, (draft) => { draft.selectedCandidateId = candidate.id; });
    return this.runPipeline(task.id, live.url, candidate.filename, { title: candidate.title, author: candidate.author });
  }

  private async importDirect(input: { url: string; title: string; author?: string; origin?: AcquisitionOrigin; intentId?: string }): Promise<TaskView> {
    const url = String(input.url ?? '').trim();
    const title = String(input.title ?? '').trim();
    if (!url || !title) throw new AcquisitionFailure('invalid_input', 'url and title are required');
    const task = this.newTask({ title, ...(input.author ? { author: input.author } : {}), origin: input.origin ?? 'manual', ...(input.intentId ? { intentId: input.intentId } : {}) });
    let filename = 'novel.txt';
    try {
      const parsed = new URL(url);
      filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'novel.txt') || 'novel.txt';
    } catch { /* keep the default */ }
    if (!/\.(txt|md|markdown)$/iu.test(filename)) filename = `${filename.replace(/[./\\]+$/gu, '')}.txt`;
    const identity = extractIdentity(filename);
    const candidate: CandidateRecord = {
      id: randomUUID(), filename, format: /\.md$|\.markdown$/iu.test(filename) ? 'md' : 'txt', host: hostOf(url),
      urlHash: createHash('sha256').update(url).digest('hex'), discoveredAt: this.now(), expiresAt: this.now() + CANDIDATE_TTL_MS,
      ...identity,
    };
    this.urls.set(candidate.id, { taskId: task.id, url });
    this.records.update(task.id, (draft) => { draft.candidates = [candidate]; draft.selectedCandidateId = candidate.id; }, { status: 'candidate_ready', note: 'direct file address' });
    return this.runPipeline(task.id, url, filename, identity);
  }

  /** download -> validate -> repair -> import, with the original file kept on any trouble. */
  private async runPipeline(taskId: string, url: string, filename: string, declared: { title?: string; author?: string }): Promise<TaskView> {
    if(this.records.get(taskId)?.failure?.code==='cancelled')return this.status(taskId) as TaskView;
    if (this.aborts.has(taskId)) throw new AcquisitionFailure('invalid_input', 'This task already has a transfer in progress');
    const cfg = this.cfg();
    const task = this.records.get(taskId)!;
    let rawRelative: string | undefined;
    let downloadedPart: string | undefined;
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    try {
      this.setStatus(taskId, 'downloading');
      controller.signal.throwIfAborted();
      this.records.update(taskId, (draft) => { draft.attempts.downloads += 1; });
      const checked = await checkUrl(url, { allowNetwork: cfg.allowNetwork, resolve: this.resolve });
      const bridge = await this.ensureBridge();
      // Both routes hand back raw bytes: the bridge appends what the browser read,
      // downloadFile streams the response. Neither decodes the text.
      const downloaded = bridge
        ? await bridge.fetchFile({
            url: checked.href,
            taskId,
            staging: this.staging,
            filename,
            allowNetwork: cfg.allowNetwork,
            signal: controller.signal,
          })
        : await downloadFile({
            url: checked.href,
            allowNetwork: cfg.allowNetwork,
            staging: this.staging,
            taskId,
            signal: controller.signal,
            ...(this.resolve ? { resolve: this.resolve } : {}),
            fetchImpl: this.fetchImpl,
            networkAllowed: () => this.cfg().allowNetwork,
          });
      downloadedPart = downloaded.partPath;
      this.onConfigChanged();
      controller.signal.throwIfAborted();
      // Write intent before moving bytes. A crash on either side of commitRaw is recoverable.
      const pendingFile = {
        sha256: downloaded.sha256, bytes: downloaded.bytes, filename,
        path: join('raw', downloaded.sha256 + (/\.md$|\.markdown$/iu.test(filename) ? '.md' : '.txt')),
        pendingPart: relative(this.root, downloaded.partPath), retained: true,
        ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
      };
      await this.staging.withRawLock(()=>{this.onConfigChanged();controller.signal.throwIfAborted();this.records.update(taskId,draft=>{draft.file=pendingFile;});});
      rawRelative = await this.staging.commitRaw(downloaded.partPath, downloaded.sha256, /\.md$|\.markdown$/iu.test(filename) ? 'md' : 'txt',(path,phase)=>{
      this.onConfigChanged();controller.signal.throwIfAborted();
      if(phase==='pending')return;
      this.records.update(taskId, (draft) => {
        draft.file = {
          sha256: downloaded.sha256,
          bytes: downloaded.bytes,
          filename,
          path,
          retained: true,
          ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
        };
      });});
      this.setStatus(taskId, 'validating');
      controller.signal.throwIfAborted();
      return await this.finishImport(taskId, rawRelative, filename, declared);
    } catch (error) {
      if (controller.signal.aborted) this.fail(taskId, controller.signal.reason instanceof AcquisitionFailure ? controller.signal.reason.code : 'cancelled', 'Acquisition interrupted');
      else this.classifyFailure(taskId, error);
      return this.status(taskId) as TaskView;
    } finally {
      if (downloadedPart && !rawRelative && !this.records.get(taskId)?.file?.pendingPart) await this.staging.removeIfPresent(downloadedPart);
      this.aborts.delete(taskId);
      await this.prune();
    }
  }

  private async withImportSlot<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (this.waitingImports >= 4) throw new AcquisitionFailure('import_busy', 'Import queue is full; retry the retained original later');
    this.waitingImports++;
    const previous = this.importQueue; let release!: () => void;
    this.importQueue = new Promise<void>(done => { release = done; });
    try { await previous; this.aborts.get(taskId)?.signal.throwIfAborted(); return await operation(); }
    finally { this.waitingImports--; release(); }
  }

  private async finishImport(taskId: string, rawRelative: string, filename: string, declared: { title?: string; author?: string }, forced?: DetectedEncoding): Promise<TaskView> {
    return this.withImportSlot(taskId, async () => {
    const task = this.records.get(taskId)!;
    const absolute = await this.staging.verifiedOriginal({ ...task.file!, path: rawRelative });
    let decoded: BestEffortDecoded;
    try {
      this.staging.assertSafeDirectories();decoded = prepareFileBestEffort(absolute, 16 * 1024, undefined, forced,{sha256:task.file!.sha256,bytes:task.file!.bytes});
    } catch (error) {
      if (error instanceof BestEffortRejected) {
        this.records.update(taskId, (draft) => { draft.rejection = { code: error.code, message: error.message }; });
        this.fail(taskId, error.code, error.message);
        return this.status(taskId) as TaskView;
      }
      throw error;
    } finally { await this.staging.removeIfPresent(absolute); }
    return await this.importDecoded(taskId, rawRelative, filename, decoded, declared);
    });
  }

  private async importDecoded(taskId: string, rawRelative: string, filename: string, decoded: BestEffortDecoded, declared: { title?: string; author?: string }): Promise<TaskView> {
    try {
    this.aborts.get(taskId)?.signal.throwIfAborted();
    const task = this.records.get(taskId)!;
    const assessment: Assessment = assessText({
      text: decoded.text,
      metrics: decoded.metrics,
      warnings: decoded.warnings,
      encoding: decoded.encoding,
      replacements: decoded.replacements,
      truncatedTail: decoded.truncatedTail,
      repairs: decoded.repairs,
      filename,
      wanted: { title: task.target.title, ...(task.target.author ? { author: task.target.author } : {}) },
      ...(declared.title || declared.author ? { declared } : {}),
    });

    if (assessment.verdict === 'reject' && assessment.reject) {
      this.records.update(taskId, (draft) => { draft.rejection = { code: assessment.reject!.code, message: assessment.reject!.message }; });
      this.fail(taskId, assessment.reject.code, assessment.reject.message);
      return this.status(taskId) as TaskView;
    }

    if (decoded.repairs.length) {
      this.setStatus(taskId, 'needs_repair', decoded.repairs.map((issue) => issue.code).join(','));
      this.setStatus(taskId, 'repairing');
      this.records.update(taskId, (draft) => { draft.attempts.repairs += 1; });
    }
    this.setStatus(taskId, 'importing');

    const absolute = this.staging.resolveInside(rawRelative);
    let result: ReturnType<Library['importFileBestEffort']>;
    try {
      result = this.library.importFileBestEffort(
        { filename,
          title: declared.title?.trim() || `未确认作品（${filename.slice(0, 80)} · ${task.file!.sha256.slice(0, 12)}）`,
          ...(declared.title?.trim() && declared.author ? { author: declared.author } : {}),
        },
        absolute,
        {
          wanted: { title: task.target.title, ...(task.target.author ? { author: task.target.author } : {}) },
          ...(declared.title || declared.author ? { declared } : {}),
          decoded,
        },
      );
      this.records.update(taskId, (draft) => { draft.attempts.imports += 1; });
    } catch (error) {
      this.classifyFailure(taskId, error);
      return this.status(taskId) as TaskView;
    }

    const quality = result.quality;
    if (this.aborts.get(taskId)?.signal.aborted) {
      this.records.update(taskId, draft => { draft.bookKey = result.book.key; draft.quality = quality; draft.duplicate = result.duplicate; });
      this.fail(taskId, 'cancelled', 'Acquisition cancelled during shelf commit; the unread shelf item is retained, queue integration was not started');
      return this.view(this.records.get(taskId)!);
    }
    const clean = quality.quality === 'clean';
    const updated = this.records.update(taskId, (draft) => {
      draft.quality = quality;
      draft.bookKey = result.book.key;
      draft.duplicate = result.duplicate;
      if (draft.file) draft.file.retained = !clean;
      draft.failure = undefined;
      if (this.onImported && draft.origin === 'autonomous' && draft.intentId) draft.selection = { status: 'pending', identity: result.identity };
    }, {
      status: clean ? 'completed' : 'completed_with_warning',
      note: `${quality.quality}${result.duplicate ? ', duplicate' : ''}`,
    });
    this.urls.delete(task.selectedCandidateId ?? '');
    if (clean && updated.file) await this.dropRaw(updated.file.path);
    await this.integrateSelection(updated);
    return this.view(this.records.get(taskId)!);
    } finally { if (decoded.canonicalFile) await this.staging.removeIfPresent(decoded.canonicalFile); }
  }

  private async dropRaw(relative?: string): Promise<void> {
    if (!relative) return;
    return this.staging.withRawLock(async()=>{
    if (this.records.list().some(task => task.file?.path === relative && task.file.retained)) return;
    await this.staging.removeIfPresent(this.staging.resolveInside(relative));
    });
  }

  /** Re-run the import from the retained original file; a new revision is a new book version. */
  async retry(taskId: string): Promise<TaskView> {
    await this.maintenance;
    this.requireEnabled();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (task.status === 'completed' || task.status === 'completed_with_warning') {
      if (task.selection?.status !== 'completed') await this.integrateSelection(task);
      return this.view(this.records.get(taskId)!);
    }
    if (task.status !== 'failed_recoverable' && task.status !== 'failed_terminal' && task.status !== 'needs_repair') {
      throw new AcquisitionFailure('invalid_input', `Task ${taskId} is ${task.status}; retry only applies to a failed task`);
    }
    if (!task.file?.path) {
      // Nothing was downloaded yet: retry the same address while it is still known,
      // so a network hiccup does not turn into a second task or a second download.
      const known = task.selectedCandidateId ? this.urls.get(task.selectedCandidateId) : undefined;
      const candidate = task.candidates.find((entry) => entry.id === task.selectedCandidateId);
      if (known && candidate && candidate.expiresAt > this.now()) {
        this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
        return await this.runPipeline(taskId, known.url, candidate.filename, { title: candidate.title, author: candidate.author });
      }
      // The address is gone (for example after a restart): scan the page again.
      const pageUrl = this.pageUrls.get(taskId) ?? (!task.requiresRediscovery ? task.pageUrl : undefined);
      if (!pageUrl) throw new AcquisitionFailure('candidate_expired', 'The signed or path-specific resource must be discovered again; its address was not retained');
      // Same task, same page: never pile up duplicate tasks for one book.
      this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
      return await this.runDiscovery(taskId, pageUrl);
    }
    if (this.aborts.has(taskId)) throw new AcquisitionFailure('busy', 'This task is active');
    this.aborts.set(taskId, new AbortController());
    try {
    await this.recoverRawCommits(taskId);
    this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
    this.setStatus(taskId, 'validating', 'retry from retained file');
    const candidate = task.candidates.find(row => row.id === task.selectedCandidateId);
    const declared = { title: candidate?.title, author: candidate?.author };
    return await this.finishImport(taskId, task.file.path, task.file.filename, declared);
    } catch (error) { this.classifyFailure(taskId, error); return this.status(taskId) as TaskView; }
    finally { this.aborts.delete(taskId); await this.prune(); }
  }

  /**
   * Try a different decoding strategy on the retained bytes and import the result
   * as a new revision. The old shelf entry and its reading progress are untouched.
   */
  async repair(taskId: string, encoding?: DetectedEncoding): Promise<TaskView> {
    await this.maintenance;
    this.requireEnabled();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (!task.file?.path) {
      throw new AcquisitionFailure('invalid_input', 'No retained original file for this task');
    }
    if (this.aborts.has(taskId)) throw new AcquisitionFailure('busy', 'This task is active');
    this.aborts.set(taskId, new AbortController());
    try {
    await this.recoverRawCommits(taskId);
    this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
    const from = task.status;
    if (from === 'failed_recoverable' || from === 'failed_terminal') {
      this.records.update(taskId, (draft) => { draft.attempts.repairs += 1; });
      this.setStatus(taskId, 'validating', 'repair');
    } else {
      this.setStatus(taskId, 'validating', 'repair');
    }
    const candidate = task.candidates.find(row => row.id === task.selectedCandidateId);
    return await this.finishImport(taskId, task.file.path, task.file.filename, { title: candidate?.title, author: candidate?.author }, encoding);
    } catch (error) { this.classifyFailure(taskId, error); return this.status(taskId) as TaskView; }
    finally { this.aborts.delete(taskId); await this.prune(); }
  }

  private classifyFailure(taskId: string, error: unknown): void {
    if (error instanceof OriginalFileError || error instanceof AuthenticatedInputError) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof AcquisitionFailure) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BestEffortRejected) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof DownloadError) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BrowserError) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BridgeError) {
      // A missing extension is a setup problem, not a bad file: retrying is useful,
      // but the message must say what to fix.
      const code = error.code === 'bridge_timeout' ? 'timeout' : error.code === 'bridge_offline' || error.code === 'busy' ? 'browser_unavailable' : error.code;
      this.fail(taskId, code, error.message);
      return;
    }
    if (isPolicyError(error)) { this.fail(taskId, 'policy_blocked', error.message); return; }
    if (['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'ENOENT', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) { this.fail(taskId, 'storage_unavailable', 'Storage operation failed (' + (error as NodeJS.ErrnoException).code + ')'); return; }
    const message = (error as Error)?.message ?? 'Acquisition failed';
    if (/library is full/iu.test(message)) { this.fail(taskId, 'library_full', message); return; }
    if (/Book must be between|exceeds 100 MiB/iu.test(message)) { this.fail(taskId, 'too_large', message); return; }
    this.fail(taskId, 'import_failed', message);
  }

  private async recoverRawCommits(taskId?: string): Promise<void> {
    for (const task of this.records.list()) {
      if (taskId && task.id !== taskId) continue;
      if (!task.file?.pendingPart) continue;
      try {
        const pending = task.file.pendingPart;
        if (!/^work[\\/][a-f0-9-]+\.part$/u.test(pending)) throw new OriginalFileError('original_integrity', 'Invalid pending original path');
        if (existsSync(this.staging.resolveInside(pending))) await this.staging.commitRaw(this.staging.resolveInside(pending), task.file.sha256, task.file.path?.endsWith('.md') ? 'md' : 'txt');
        const verified = await this.staging.verifiedOriginal(task.file);
        await this.staging.removeIfPresent(verified);
        this.records.update(task.id, draft => { delete draft.file!.pendingPart; });
      } catch (error) { if (taskId) throw error; this.classifyFailure(task.id, error); }
    }
  }

  /** Keep the staging area under the configured bound; refuses while a task runs. */
  lastMaintenance: MaintenanceResult | undefined;
  async prune(): Promise<MaintenanceResult> {
    const run = this.maintenance.then(async () => {
      if (this.records.hasActive() || this.aborts.size) return { status: 'skipped_active_tasks', removed: [] } as MaintenanceResult;
      const limit = (this.cfg().txtAcquisitionRetentionMb ?? 512) * 1024 * 1024;
      const referenced = new Set<string>();
      for (const task of this.records.list()) if (task.file?.retained) referenced.add(task.file.sha256);
      await this.staging.clearExpiredParts(this.now(), this.records.list().filter(task => task.file?.pendingPart).map(task => task.id));
      return this.staging.enforceQuota(limit, referenced, sha => !this.records.hasActive() && !this.aborts.size && !this.records.list().some(task => task.file?.retained && task.file.sha256 === sha));
    });
    this.maintenance = run.catch(() => undefined);
    const result = await run.catch(error => maintenanceFailure(error));
    this.lastMaintenance = result;
    return result; // maintenance failure is observable without reversing a committed shelf insert
  }

  /** Release the loopback port when the world stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if(this.policyTimer)clearInterval(this.policyTimer);this.policyTimer=undefined;
    for (const abort of this.aborts.values()) abort.abort(new AcquisitionFailure('restart_interrupted','World stopped'));
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge?.running) await bridge.stop().catch(() => undefined);
  }

  /** Called only after SelectionCoordinator is started; never downloads or imports again. */
  async resumeSelection(): Promise<void> {
    if (this.initializationError) return;
    for (const task of this.records.list()) if (isTerminal(task.status) && task.selection?.status !== 'completed') await this.integrateSelection(task);
  }

  private async integrateSelection(task: AcquisitionTask): Promise<void> {
    if (this.stopped || task.origin !== 'autonomous' || !task.intentId) return;
    task = this.records.get(task.id) ?? task;
    const success = ['completed','completed_with_warning'].includes(task.status);
    if (success ? !this.onImported : !this.onTaskStateChanged) return;
    const candidate = task.candidates.find(row => row.id === task.selectedCandidateId);
    // Recheck persisted source lineage, including old pending receipts created by
    // the earlier wanted-field fallback. Missing provenance cannot become exact.
    const sourceIdentity = identityMatch(task.target, candidate);
    const identity = task.selection?.identity === 'exact' ? sourceIdentity : task.selection?.identity ?? 'unknown';
    let result: NonNullable<AcquisitionTask['selection']>;
    try {
      if (success) await this.onImported!(task, identity);
      else await this.onTaskStateChanged!(task);
      if (this.stopped) return; // persistent pending receipt is replayed after the next mount
      result = { status: 'completed', identity };
    } catch (error) { result = { status: 'failed', identity, message: redactMessage((error as Error)?.message ?? 'Queue integration failed') }; }
    try { this.records.update(task.id, draft => { if (draft.status === task.status && draft.updatedAt === task.updatedAt && JSON.stringify(draft.attempts) === JSON.stringify(task.attempts)) draft.selection = result; }); }
    catch { this.selectionPersistenceError = 'Queue integration receipt could not be persisted; pending shelf success will be reconciled after restart'; }
  }

  /** Apply a changed bridge setting without restarting the world. */
  async restartBridge() {
    await this.stop();
    await this.ensureBridge().catch(() => undefined);
    return this.bridgeInfo;
  }
}




