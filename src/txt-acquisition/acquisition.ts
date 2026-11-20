/**
 * Acquisition orchestration: discovery, download, quality gate, loose import and
 * recovery. It owns staged files and task records only — books still enter the
 * shelf through Library, and autonomous queueing still belongs to
 * SelectionCoordinator.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookfishConfigSection } from '../config.ts';
import type { Library } from '../library.ts';
import { BestEffortRejected, decodeFileBestEffort, type BestEffortDecoded } from '../stream-import.ts';
import { BrowserClient, BrowserError } from './browser-client.ts';
import { BridgeError, BrowserBridge } from './bridge.ts';
import { DownloadError, downloadFile } from './download.ts';
import { discoverLinks, extractIdentity } from './link-discovery.ts';
import { assessText, type Assessment, type IdentityMatch } from './quality.ts';
import { AcquisitionRecords } from './records.ts';
import { decodeBestEffort, detectEncoding, looksBinary, normalizeText } from './repair.ts';
import { AcquisitionStaging } from './staging.ts';
import {
  CANDIDATE_TTL_MS, MAX_CANDIDATES, assertTransition, failureRecoverable, isTerminal,
  type AcquisitionOrigin, type AcquisitionStatus, type AcquisitionTask, type CandidateRecord,
  type DetectedEncoding, type FileFormat, type QualityReport, type TaskView, type DiscoveredLink,
} from './types.ts';
import { checkUrl, hostOf, isPolicyError, type HostResolver } from './url-policy.ts';
import { redactMessage, sourceReference } from './privacy.ts';

export interface PageLoadResult { html: string; close: () => Promise<void> }
export type PageLoader = (url: string, options: { allowNetwork: boolean; port: number; resolve?: HostResolver; signal?: AbortSignal }) => Promise<PageLoadResult>;

export interface AcquisitionOptions {
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
  /** Called after a successful shelf insert so autonomous selection can finish its intent. */
  onImported?: (task: AcquisitionTask, identity: IdentityMatch) => void;
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
    const html = await page.evaluate<string>("document.documentElement.outerHTML");
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
  private readonly browserGuard?: (url: string) => Promise<void>;
  private readonly pageUrls = new Map<string, string>();
  private readonly onImported?: (task: AcquisitionTask, identity: IdentityMatch) => void;
  /** Candidate URLs stay in memory only; records carry their digest. */
  private readonly urls = new Map<string, { taskId: string; url: string }>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: AcquisitionOptions) {
    this.root = join(options.dataDir, 'bookfish', 'txt-acquisition');
    this.staging = new AcquisitionStaging(this.root);
    this.records = new AcquisitionRecords(this.root);
    this.library = options.library;
    this.cfg = options.cfg;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl;
    this.resolve = options.resolve;
    this.pageLoader = options.pageLoader ?? (async (url, settings) => {
      if (!this.browserGuard) throw new BrowserError('policy_blocked', 'A protected browser controller is required');
      await this.browserGuard(url); return defaultPageLoader(options.fetchImpl)(url, settings);
    });
    this.bridge = options.bridge;
    this.browserGuard = options.browserGuard;
    if (options.onImported) this.onImported = options.onImported;
  }

  async init(): Promise<void> {
    await this.staging.init();
    this.records.load(this.now());
    this.recover();
    await this.staging.clearExpiredParts(this.now());
    // A busy port must not stop reading; the failure surfaces on the first task.
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
        authorize: this.browserGuard,
        networkAllowed: () => this.cfg().allowNetwork,
        ...(typeof cfg.browserBridgePort === 'number' && cfg.browserBridgePort > 0 ? { port: cfg.browserBridgePort } : {}),
        ...(this.resolve ? { resolve: this.resolve } : {}),
      });
    }
    await this.bridge.start();
    return this.bridge;
  }

  /** Pairing details for the extension popup; the token never reaches the model. */
  get bridgeInfo(): { enabled: boolean; running: boolean; connected: boolean; port: number; token: string } {
    const info = this.bridge?.info();
    return {
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
      this.records.update(task.id, (draft) => {
        draft.failure = { code: 'restart_interrupted', message: 'The extension restarted before this acquisition finished', recoverable: true, at: this.now() };
      }, { status: 'failed_recoverable', note: 'interrupted by restart' });
      void this.staging.clearPrepared(task.id);
    }
  }

  list(): TaskView[] {
    return this.records.list().map((task) => this.view(task));
  }

  /** Small status block for the model; full task detail stays behind `status`. */
  summary(): { enabled: boolean; browserConfigured: boolean; active: number; tasks: Array<{ taskId: string; status: string; title: string; updatedAt: number; bookKey?: string }> } {
    const tasks = this.records.list();
    return {
      enabled: this.cfg().txtAcquisitionEnabled === true,
      browserConfigured: (this.cfg().browserDebugPort ?? 0) > 0 || this.bridge?.running === true,
      active: tasks.filter((task) => !isTerminal(task.status)).length,
      tasks: tasks.slice(-5).map((task) => ({
        taskId: task.id, status: task.status, title: task.target.title, updatedAt: task.updatedAt,
        ...(task.bookKey ? { bookKey: task.bookKey } : {}),
      })),
    };
  }

  status(taskId?: string): TaskView | TaskView[] {
    if (!taskId) return this.list();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    return this.view(task);
  }

  cancel(taskId: string): TaskView {
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (task.status === 'completed' || task.status === 'completed_with_warning') return this.view(task);
    if (task.status === 'failed_terminal' || task.status === 'failed_recoverable') return this.view(task);
    this.aborts.get(taskId)?.abort(new Error('cancelled'));
    return this.view(this.records.update(taskId, (draft) => {
      draft.failure = { code: 'cancelled', message: 'Cancelled by the model or user', recoverable: true, at: this.now() };
    }, { status: 'failed_recoverable', note: 'cancelled' }));
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
    const cfg = this.cfg();
    if (!cfg.txtAcquisitionEnabled) throw new AcquisitionFailure('disabled', 'Browser-assisted TXT acquisition is disabled in settings');
  }

  private setStatus(taskId: string, status: AcquisitionStatus, note?: string): AcquisitionTask {
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    assertTransition(task.status, status);
    return this.records.update(taskId, () => undefined, { status, ...(note ? { note } : {}) });
  }

  private fail(taskId: string, code: string, message: string): AcquisitionTask {
    const recoverable = failureRecoverable(code);
    return this.records.update(taskId, (draft) => {
      draft.failure = { code, message: redactMessage(message), recoverable, at: this.now() };
    }, { status: recoverable ? 'failed_recoverable' : 'failed_terminal', note: code });
  }

  private newTask(input: { title: string; author?: string; pageUrl?: string; origin: AcquisitionOrigin; intentId?: string }): AcquisitionTask {
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
    return this.records.put(task);
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
        // The extension runs in the user's own browser, so their logins are already there.
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
      if (controller.signal.aborted) this.fail(taskId, 'cancelled', 'Discovery cancelled'); else this.classifyFailure(taskId, error);
      return this.status(taskId) as TaskView;
    } finally { this.aborts.delete(taskId); }
  }

  /** Candidate addresses live in memory only, so a new scan drops the old ones. */
  private forgetUrls(taskId: string): void {
    for (const [candidateId, entry] of this.urls) if (entry.taskId === taskId) this.urls.delete(candidateId);
  }

  /** Import a candidate found by `discover`, or a direct file address. */
  async importFile(input: { taskId?: string; candidateId?: string; url?: string; title?: string; author?: string; origin?: AcquisitionOrigin; intentId?: string }): Promise<TaskView> {
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
    const candidate: CandidateRecord = {
      id: randomUUID(), filename, format: /\.md$|\.markdown$/iu.test(filename) ? 'md' : 'txt', host: hostOf(url),
      urlHash: createHash('sha256').update(url).digest('hex'), discoveredAt: this.now(), expiresAt: this.now() + CANDIDATE_TTL_MS,
    };
    this.urls.set(candidate.id, { taskId: task.id, url });
    this.records.update(task.id, (draft) => { draft.candidates = [candidate]; draft.selectedCandidateId = candidate.id; }, { status: 'candidate_ready', note: 'direct file address' });
    const identity = extractIdentity(filename);
    return this.runPipeline(task.id, url, filename, { title: identity.title ?? title, author: identity.author ?? input.author });
  }

  /** download -> validate -> repair -> import, with the original file kept on any trouble. */
  private async runPipeline(taskId: string, url: string, filename: string, declared: { title?: string; author?: string }): Promise<TaskView> {
    if (this.aborts.has(taskId)) throw new AcquisitionFailure('invalid_input', 'This task already has a transfer in progress');
    const cfg = this.cfg();
    const task = this.records.get(taskId)!;
    let rawRelative: string | undefined;
    let downloadedPart: string | undefined;
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    try {
      this.setStatus(taskId, 'downloading');
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
      controller.signal.throwIfAborted();
      rawRelative = await this.staging.commitRaw(downloaded.partPath, downloaded.sha256, /\.md$|\.markdown$/iu.test(filename) ? 'md' : 'txt');
      this.records.update(taskId, (draft) => {
        draft.file = {
          sha256: downloaded.sha256,
          bytes: downloaded.bytes,
          filename,
          path: rawRelative,
          retained: true,
          ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
        };
      });
      this.setStatus(taskId, 'validating');
      controller.signal.throwIfAborted();
      return await this.finishImport(taskId, rawRelative, filename, declared);
    } catch (error) {
      if (controller.signal.aborted) this.fail(taskId, 'cancelled', 'Acquisition cancelled');
      else this.classifyFailure(taskId, error);
      return this.status(taskId) as TaskView;
    } finally {
      if (downloadedPart && !rawRelative) await this.staging.removeIfPresent(downloadedPart);
      this.aborts.delete(taskId);
    }
  }

  private async finishImport(taskId: string, rawRelative: string, filename: string, declared: { title?: string; author?: string }): Promise<TaskView> {
    const task = this.records.get(taskId)!;
    const absolute = this.staging.resolveInside(rawRelative);
    let decoded: BestEffortDecoded;
    try {
      decoded = await decodeFileBestEffort(absolute, 16 * 1024);
    } catch (error) {
      if (error instanceof BestEffortRejected) {
        this.records.update(taskId, (draft) => { draft.rejection = { code: error.code, message: error.message }; });
        this.fail(taskId, error.code, error.message);
        return this.status(taskId) as TaskView;
      }
      throw error;
    }
    return await this.importDecoded(taskId, rawRelative, filename, decoded, declared);
  }

  private async importDecoded(taskId: string, rawRelative: string, filename: string, decoded: BestEffortDecoded, declared: { title?: string; author?: string }): Promise<TaskView> {
    this.aborts.get(taskId)?.signal.throwIfAborted();
    const task = this.records.get(taskId)!;
    const assessment: Assessment = assessText({
      text: decoded.text,
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
        { filename, title: task.target.title, ...(task.target.author ? { author: task.target.author } : {}) },
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
    const clean = quality.quality === 'clean';
    const updated = this.records.update(taskId, (draft) => {
      draft.quality = quality;
      draft.bookKey = result.book.key;
      draft.duplicate = result.duplicate;
      if (draft.file) draft.file.retained = !clean;
      draft.failure = undefined;
    }, {
      status: clean ? 'completed' : 'completed_with_warning',
      note: `${quality.quality}${result.duplicate ? ', duplicate' : ''}`,
    });
    this.urls.delete(task.selectedCandidateId ?? '');
    if (clean && updated.file) await this.dropRaw(updated.file.path);
    this.onImported?.(updated, result.identity);
    return this.view(updated);
  }

  private async dropRaw(relative?: string): Promise<void> {
    if (!relative) return;
    if (this.records.list().some(task => task.file?.path === relative && task.file.retained)) return;
    await this.staging.removeIfPresent(this.staging.resolveInside(relative));
  }

  /** Re-run the import from the retained original file; a new revision is a new book version. */
  async retry(taskId: string): Promise<TaskView> {
    this.requireEnabled();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (task.status !== 'failed_recoverable' && task.status !== 'failed_terminal' && task.status !== 'needs_repair') {
      throw new AcquisitionFailure('invalid_input', `Task ${taskId} is ${task.status}; retry only applies to a failed task`);
    }
    if (!task.file?.path || !existsSync(this.staging.resolveInside(task.file.path))) {
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
    this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
    this.setStatus(taskId, 'validating', 'retry from retained file');
    const declared = { title: task.candidates[0]?.title, author: task.candidates[0]?.author };
    const outcome = await this.decodeOrRecordRejection(taskId, task.file.path, task.file.filename);
    if ('rejected' in outcome) return outcome.rejected;
    return await this.importDecoded(taskId, task.file.path, task.file.filename, outcome.decoded, declared);
  }

  /**
   * Try a different decoding strategy on the retained bytes and import the result
   * as a new revision. The old shelf entry and its reading progress are untouched.
   */
  async repair(taskId: string, encoding?: DetectedEncoding): Promise<TaskView> {
    this.requireEnabled();
    const task = this.records.get(taskId);
    if (!task) throw new Error(`Unknown acquisition task ${taskId}`);
    if (!task.file?.path || !existsSync(this.staging.resolveInside(task.file.path))) {
      throw new AcquisitionFailure('invalid_input', 'No retained original file for this task');
    }
    this.records.update(taskId, (draft) => { draft.failure = undefined; draft.rejection = undefined; });
    const from = task.status;
    if (from === 'failed_recoverable' || from === 'failed_terminal') {
      this.records.update(taskId, (draft) => { draft.attempts.repairs += 1; });
      this.setStatus(taskId, 'validating', 'repair');
    } else {
      this.setStatus(taskId, 'validating', 'repair');
    }
    const outcome = await this.decodeOrRecordRejection(taskId, task.file.path, task.file.filename, encoding);
    if ('rejected' in outcome) return outcome.rejected;
    return await this.importDecoded(taskId, task.file.path, task.file.filename, outcome.decoded, { title: task.candidates[0]?.title, author: task.candidates[0]?.author });
  }

  /**
   * A rejected file is a normal outcome: record it and keep the bytes so the task
   * can be repaired or retried instead of throwing away the only copy.
   */
  private async decodeOrRecordRejection(taskId: string, relative: string, filename: string, forced?: DetectedEncoding): Promise<{ decoded: BestEffortDecoded } | { rejected: TaskView }> {
    try {
      return { decoded: await this.decodeRetained(relative, filename, forced) };
    } catch (error) {
      if (!(error instanceof BestEffortRejected)) throw error;
      this.records.update(taskId, (draft) => { draft.rejection = { code: error.code, message: error.message }; });
      this.fail(taskId, error.code, error.message);
      return { rejected: this.status(taskId) as TaskView };
    }
  }

  /**
   * Decode retained bytes, optionally trying every plausible encoding and keeping
   * the one with the fewest replacement characters.
   */
  private async decodeRetained(relative: string, filename: string, forced?: DetectedEncoding): Promise<BestEffortDecoded> {
    const absolute = this.staging.resolveInside(relative);
    const bytes = await readFile(absolute);
    if (!bytes.length) throw new BestEffortRejected('empty_file', 'The retained file is empty');
    const detected = detectEncoding(bytes);
    if (looksBinary(bytes, detected)) throw new BestEffortRejected('binary_file', 'The retained file looks binary, not text');
    const candidates: DetectedEncoding[] = forced ? [forced] : [detected, 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'];
    let best: BestEffortDecoded | undefined;
    for (const encoding of [...new Set(candidates)]) {
      const decoded = decodeBestEffort(bytes, encoding);
      const normalized = normalizeText(decoded.text);
      const attempt: BestEffortDecoded = {
        text: normalized.text,
        encoding,
        repairs: [...decoded.issues, ...normalized.issues],
        replacements: decoded.replacements,
        truncatedTail: normalized.truncatedTail,
        bytes: bytes.length,
      };
      if (!best || attempt.replacements < best.replacements) best = attempt;
      if (attempt.replacements === 0) break;
    }
    if (!best) throw new BestEffortRejected('unreadable_text', 'The retained file could not be decoded');
    if (!forced) {
      const assessed = assessText({
        text: best.text, encoding: best.encoding, replacements: best.replacements, truncatedTail: best.truncatedTail,
        repairs: best.repairs, filename,
      });
      if (assessed.verdict === 'reject') throw new BestEffortRejected(assessed.reject?.code ?? 'unreadable_text', assessed.reject?.message ?? 'The retained file is not readable text');
    }
    return best;
  }

  private classifyFailure(taskId: string, error: unknown): void {
    if (error instanceof AcquisitionFailure) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BestEffortRejected) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof DownloadError) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BrowserError) { this.fail(taskId, error.code, error.message); return; }
    if (error instanceof BridgeError) {
      // A missing extension is a setup problem, not a bad file: retrying is useful,
      // but the message must say what to fix.
      const code = error.code === 'bridge_offline' || error.code === 'bridge_timeout' || error.code === 'busy' ? 'browser_unavailable' : error.code;
      this.fail(taskId, code, error.message);
      return;
    }
    if (isPolicyError(error)) { this.fail(taskId, 'policy_blocked', error.message); return; }
    const message = (error as Error)?.message ?? 'Acquisition failed';
    if (/library is full/iu.test(message)) { this.fail(taskId, 'library_full', message); return; }
    if (/Book must be between|exceeds 100 MiB/iu.test(message)) { this.fail(taskId, 'too_large', message); return; }
    this.fail(taskId, 'import_failed', message);
  }

  /** Keep the staging area under the configured bound; refuses while a task runs. */
  async prune(): Promise<string[]> {
    if (this.records.hasActive()) return [];
    const limit = (this.cfg().txtAcquisitionRetentionMb ?? 512) * 1024 * 1024;
    const referenced = new Set<string>();
    for (const task of this.records.list()) if (task.file?.path) referenced.add(task.file.sha256);
    await this.staging.clearExpiredParts(this.now());
    return this.staging.enforceQuota(limit, referenced);
  }

  /** Release the loopback port when the world stops. */
  async stop(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge?.running) await bridge.stop().catch(() => undefined);
  }

  /** Apply a changed bridge setting without restarting the world. */
  async restartBridge(): Promise<{ enabled: boolean; running: boolean; connected: boolean; port: number; token: string }> {
    await this.stop();
    await this.ensureBridge().catch(() => undefined);
    return this.bridgeInfo;
  }
}




