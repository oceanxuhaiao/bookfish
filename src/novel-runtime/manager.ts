/**
 * Single owner of the novel runtime: detection, install, verification,
 * activation, leases, upgrade, rollback and uninstall.
 *
 * The only commit point is `active.json`. A staging copy is fully verified and
 * probed before it can become active; a failed install never touches the old
 * runtime. Novel tasks hold leases so activation waits for in-flight searches
 * and downloads.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { probeRuntime, javaBinary } from './probe.ts';
import { extractRuntimeZip, verifyExtractedPayload } from './archive.ts';
import { downloadRuntimeArchive } from './download.ts';
import {
  findFile, parseRuntimeManifest, payloadManifestMatches, requireTrustedManifest, sha256File, verifyArchive,
} from './manifest.ts';
import {
  atomicWriteJson, ensureLayout, manifestMarker, readJson, readVersionMarker, removeIfExists, runtimeLayout, safeJoin, writeVersionMarker,
  type ActivePointer, type InstallRecord, type RuntimeLayout,
} from './storage.ts';
import { RuntimeUploads } from './upload.ts';
import type {
  InstallPhase, RuntimeAccess, RuntimeDownloadInfo, RuntimeErrorView, RuntimeHealth, RuntimeInstallView, RuntimeManifest, RuntimeProbeResult,
  RuntimeStatusView, RuntimeUpdateInfo, RuntimeVersionView, TrustedRuntimeManifest,
} from './types.ts';
import { SUPPORTED_PLATFORM } from './types.ts';
import { NovelEngine } from '../novel-engine.ts';
import type { NovelEngineLike } from '../novel-fetch.ts';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MIN_FREE_RESERVE = 256 * 1024 * 1024;
/** Ordered mirrors. The domestic mirror is tried first; GitHub remains the canonical fallback. */
const BUILTIN_RUNTIME_SOURCES = [
  { name: '国内镜像', baseUrl: 'https://bookfish-runtime.oss-cn-hangzhou.aliyuncs.com/', hosts: ['bookfish-runtime.oss-cn-hangzhou.aliyuncs.com'] },
  { name: 'GitHub Release', baseUrl: 'https://github.com/oceanxuhaiao/bookfish/releases/download/runtime-1.12.0-bf1/', hosts: ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] },
] as const;
interface RuntimeSource { name: string; baseUrl: URL; hosts: string[] }
async function moveDirectoryWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

export interface RuntimeManagerOptions {
  dataDir: string;
  workDir: string;
  bridgeClasses: string;
  manifest: TrustedRuntimeManifest;
  baseUrl?: string | null;
  offlineUrl?: string | null;
  allowedHosts?: readonly string[];
  updateUrl?: string | null;
  updatePublicKey?: string | null;
  allowInsecureLoopback?: boolean;
  now?: () => number;
  /** Test seams; production uses the real implementations. */
  probe?: typeof probeRuntime;
  extract?: typeof extractRuntimeZip;
  download?: typeof downloadRuntimeArchive;
  engineFactory?: (dir: string, workDir: string, bridgeClasses: string) => NovelEngineLike;
}

interface InternalInstall {
  record: InstallRecord;
  controller: AbortController;
  speed: number | null;
  lastSample?: { at: number; bytes: number };
  promise?: Promise<void>;
}

interface CachedRelease { manifest: TrustedRuntimeManifest }

function errorView(code: string, message: string, retryable = true): RuntimeErrorView {
  return { code, message, retryable };
}

function mapError(error: unknown): RuntimeErrorView {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw === 'cancelled' || raw.includes('已取消')) return errorView('cancelled', '安装已取消，原有引擎保持不变', true);
  if (raw.includes('SHA-256') || raw.includes('size mismatch') || raw.includes('摘要')) return errorView('archive_hash', '安装包校验失败，文件可能损坏或被篡改', true);
  if (raw.includes('磁盘') || raw.includes('ENOSPC')) return errorView('disk_full', '磁盘空间不足', true);
  if (raw.includes('zip_')) return errorView('archive_invalid', `安装包无法安全解压：${raw.slice(0, 180)}`, true);
  if (raw.includes('下载') || raw.includes('download_')) return errorView('download_failed', raw.slice(0, 240), true);
  if (raw.includes('HTTP')) return errorView('download_failed', raw.slice(0, 240), true);
  if (raw.includes('Java') || raw.includes('桥接') || raw.includes('书源规则') || raw.includes('引擎')) return errorView('probe_failed', raw.slice(0, 240), true);
  return errorView('install_failed', raw.slice(0, 240), true);
}

function parsePhase(phase: unknown): InstallPhase {
  const allowed: InstallPhase[] = ['idle', 'preparing', 'downloading', 'uploading', 'verifying', 'extracting', 'probing', 'waiting_idle', 'activating', 'ready', 'failed', 'cancelled', 'interrupted'];
  return allowed.includes(phase as InstallPhase) ? phase as InstallPhase : 'failed';
}

export class NovelRuntimeManager implements RuntimeAccess {
  private readonly layout: RuntimeLayout;
  private readonly uploads: RuntimeUploads;
  private readonly now: () => number;
  private active: ActivePointer | null = null;
  private previous: ActivePointer | null = null;
  private install: InternalInstall | null = null;
  private health: RuntimeHealth = { state: 'unknown', checkedAt: null };
  private lastError: RuntimeErrorView | null = null;
  private leases = 0;
  private switching = false;
  private stopped = false;
  private stopping = false;
  private releases: CachedRelease[] = [];
  private note: string | null = null;
  private readonly platformSupported: boolean;
  private readonly baseUrl: URL | null;
  private readonly onlineSources: RuntimeSource[];
  private readonly offlineUrl: string | null;
  private readonly allowedHosts: string[];

  constructor(private readonly options: RuntimeManagerOptions) {
    this.options.probe ??= probeRuntime;
    this.options.extract ??= extractRuntimeZip;
    this.options.download ??= downloadRuntimeArchive;
    this.layout = runtimeLayout(options.dataDir);
    this.now = options.now ?? Date.now;
    this.uploads = new RuntimeUploads(this.layout.downloads, MAX_ARCHIVE_BYTES, this.now);
    this.platformSupported = process.platform === SUPPORTED_PLATFORM.platform && process.arch === SUPPORTED_PLATFORM.arch;
    // Coopanion exposes deployment secrets through its own `.env`; World
    // process.env does not contain it. Read only this feature's own names.
    const deploymentEnv = readDeploymentEnv(options.dataDir);
    const readEnv = (name: string): string | null => process.env[name]?.trim() || deploymentEnv[name]?.trim() || null;
    const configuredOffline = options.offlineUrl ?? readEnv('BOOKFISH_NOVEL_RUNTIME_OFFLINE_URL');
    let parsedOffline: string | null = null;
    if (configuredOffline) {
      try {
        const offline = new URL(configuredOffline);
        if (offline.protocol === 'https:' || (offline.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(offline.hostname))) parsedOffline = offline.toString();
      } catch { /* ignore malformed offline URL */ }
    }
    this.offlineUrl = parsedOffline;
    const configuredHosts = options.allowedHosts ?? (readEnv('BOOKFISH_NOVEL_RUNTIME_HOSTS') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const sources: RuntimeSource[] = [];
    const envBase = readEnv('BOOKFISH_NOVEL_RUNTIME_BASE_URL');
    const addSource = (name: string, raw: string, hosts: string[]) => {
      try {
        const parsed = new URL(raw);
        const insecureLoopback = !!options.allowInsecureLoopback && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !insecureLoopback) return;
        sources.push({ name, baseUrl: parsed, hosts: hosts.length ? [...hosts] : [parsed.hostname] });
      } catch { /* skip malformed source */ }
    };
    if (options.baseUrl !== null) {
      if (options.baseUrl !== undefined || envBase) {
        const raw = options.baseUrl ?? envBase!;
        addSource('自定义下载源', raw, [...configuredHosts]);
      } else {
        for (const source of BUILTIN_RUNTIME_SOURCES) addSource(source.name, source.baseUrl, configuredHosts.length ? [...configuredHosts] : [...source.hosts]);
      }
    }
    this.onlineSources = sources;
    this.baseUrl = sources[0]?.baseUrl ?? null;
    this.allowedHosts = [...new Set(sources.flatMap((source) => source.hosts))];
    this.options.updateUrl = options.updateUrl ?? readEnv('BOOKFISH_NOVEL_RUNTIME_UPDATE_URL');
    this.options.updatePublicKey = options.updatePublicKey ?? readEnv('BOOKFISH_NOVEL_RUNTIME_PUBKEY');
  }

  // ---------------------------------------------------------------- startup

  async start(): Promise<void> {
    ensureLayout(this.layout);
    this.uploads.recover();
    this.cleanStaleUploadParts();
    this.active = this.loadPointer('active.json');
    this.previous = this.loadPointer('previous.json');
    this.markInterruptedInstalls();
    this.cleanStaleStaging();
    if (this.active) {
      const dir = this.activeDir();
      if (!dir) { this.active = null; this.health = { state: 'failed', checkedAt: new Date().toISOString(), message: '运行时记录指向无效目录，需要修复安装' }; return; }
      this.health = await this.probeAt(dir, this.manifestForActive());
      if (this.health.state !== 'ok') this.note = '现有运行时未通过启动自检，可在配置页修复';
      return;
    }
    const legacy = await this.detectLegacy();
    if (legacy) {
      this.active = legacy.pointer;
      this.health = legacy.health;
      atomicWriteJson(join(this.layout.base, 'active.json'), legacy.pointer);
    } else if (legacy === null && existsSync(join(this.layout.base, 'app.jar'))) {
      this.note = '检测到未受管的旧版引擎目录，但未通过受信校验；不会自动使用，可在配置页修复安装';
    }
  }

  private cleanStaleUploadParts(): void {
    try {
      for (const name of readdirSync(this.layout.downloads)) {
        if (/^(upload-|download-)[a-f0-9-]{36}\.part$/u.test(name)) rmSync(join(this.layout.downloads, name), { force: true });
      }
    } catch { /* directory may not exist yet */ }
  }

  /** At startup no task holds a lease, so abandoned staging trees are safe to remove. */
  private cleanStaleStaging(): void {
    try {
      for (const name of readdirSync(this.layout.staging)) rmSync(join(this.layout.staging, name), { recursive: true, force: true });
    } catch { /* no staging yet */ }
  }

  private markInterruptedInstalls(): void {
    try {
      for (const name of readdirSync(this.layout.installs)) {
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
        const record = readJson<InstallRecord>(join(this.layout.installs, name));
        if (!record) continue;
        const phase = parsePhase(record.phase);
        if (['preparing', 'downloading', 'uploading', 'verifying', 'extracting', 'probing', 'waiting_idle', 'activating'].includes(phase)) {
          record.phase = 'interrupted';
          record.error = errorView('interrupted', '上次安装因宿主关闭而中断，请重试', true);
          record.updatedAt = new Date(this.now()).toISOString();
          atomicWriteJson(join(this.layout.installs, name), record);
          this.lastError = record.error;
        }
      }
    } catch { /* no install records */ }
  }

  private loadPointer(name: string): ActivePointer | null {
    const pointer = readJson<ActivePointer>(join(this.layout.base, name));
    if (!pointer || pointer.schema !== 1 || (pointer.source !== 'managed' && pointer.source !== 'legacy')) return null;
    if (typeof pointer.path !== 'string' || !pointer.path || pointer.path.split('/').some((part) => part === '..')) return null;
    return pointer;
  }

  private detectLegacy(): Promise<{ pointer: ActivePointer; health: RuntimeHealth } | null> {
    const base = this.layout.base;
    if (!existsSync(join(base, 'app.jar')) || !existsSync(join(base, 'runtime', 'bin', 'java.exe')) || !existsSync(join(base, 'rules', 'main.json'))) return Promise.resolve(null);
    const manifest = this.options.manifest;
    const jar = findFile(manifest, 'app.jar');
    const rules = findFile(manifest, 'rules/main.json');
    if (!jar || !rules) return Promise.resolve(null);
    return (async () => {
      try {
        if (statSync(join(base, 'app.jar')).size !== jar.size) return null;
        if (statSync(join(base, 'rules', 'main.json')).size !== rules.size) return null;
        if (await sha256File(join(base, 'app.jar')) !== jar.sha256) return null;
        if (await sha256File(join(base, 'rules', 'main.json')) !== rules.sha256) return null;
        const health = await this.probeAt(base, manifest);
        if (health.state !== 'ok') { this.health = health; return null; }
        this.note = '已识别受信的旧版平铺目录，正在沿用；可升级到受管版本';
        const pointer: ActivePointer = {
          schema: 1, runtimeId: manifest.runtimeId, source: 'legacy', path: '.', manifestDigest: manifest.archive.sha256,
          runtimeVersion: manifest.runtimeVersion, soNovelVersion: manifest.soNovelVersion, activatedAt: new Date(this.now()).toISOString(),
        };
        return { pointer, health };
      } catch { return null; }
    })();
  }

  // ---------------------------------------------------------------- reading

  status(): RuntimeStatusView {
    const dir = this.activeDir();
    const manifest = this.manifestForActive();
    const usable = !!dir && this.health.state === 'ok' && !this.stopped;
    return {
      platform: { platform: process.platform, arch: process.arch, supported: this.platformSupported },
      installed: !!this.active,
      usable,
      runtimeId: this.active?.runtimeId ?? null,
      runtimeVersion: this.active?.runtimeVersion ?? null,
      soNovelVersion: this.active?.soNovelVersion ?? null,
      javaVersion: this.health.javaMajor ? `Java ${this.health.javaMajor}` : manifest ? manifest.java.version : null,
      source: this.active?.source ?? null,
      health: { ...this.health },
      install: this.installView(),
      error: this.install ? this.install.record.error : this.lastError,
      online: this.onlineState(),
      archiveBytes: this.options.manifest.archive.size,
      payloadBytes: this.options.manifest.payloadBytes,
      versions: this.versionViews(dir),
      canRollback: !!this.previous && this.previous.path !== this.active?.path,
      canUninstall: !!this.active && this.active.source === 'managed',
      busyTasks: this.leases,
      bridgeProtocol: this.options.manifest.bridgeProtocol,
      note: this.note,
    };
  }

  private onlineState(): RuntimeStatusView['online'] {
    const offlineUrls = this.onlineSources.map((source) => ({ name: source.name, url: new URL(this.options.manifest.archive.path, source.baseUrl).toString() }));
    if (this.offlineUrl && !offlineUrls.some((entry) => entry.url === this.offlineUrl)) offlineUrls.push({ name: '自定义离线地址', url: this.offlineUrl });
    const offline = { offlineUrl: this.offlineUrl ?? offlineUrls[0]?.url ?? null, offlineUrls, offlineFileName: this.options.manifest.archive.path, offlineSizeBytes: this.options.manifest.archive.size };
    if (!this.platformSupported) return { available: false, reason: '当前平台暂不支持自动安装，请继续使用文件导入', sizeBytes: null, fileName: null, urlHost: null, ...offline };
    if (!this.onlineSources.length) return { available: false, reason: '正式下载来源尚未配置；可导入离线运行时包', sizeBytes: null, fileName: null, urlHost: null, ...offline };
    return { available: true, reason: null, sizeBytes: this.options.manifest.archive.size, fileName: this.options.manifest.archive.path, urlHost: this.onlineSources[0]!.baseUrl.hostname, ...offline };
  }

  private installView(): RuntimeInstallView | null {
    if (!this.install) return null;
    const { record, speed } = this.install;
    const phase = parsePhase(record.phase);
    const measured = ['downloading', 'uploading'].includes(phase);
    const percent = measured && record.bytesTotal > 0 ? Math.min(100, Math.floor(record.bytesReceived / record.bytesTotal * 100)) : null;
    return {
      installId: record.installId, kind: record.kind, phase, runtimeId: record.runtimeId,
      bytesReceived: record.bytesReceived, bytesTotal: record.bytesTotal, percent,
      speedBytesPerSecond: measured ? speed : null, startedAt: record.startedAt, updatedAt: record.updatedAt, error: record.error,
    };  }

  private versionViews(activeDir: string | null): RuntimeVersionView[] {
    const rows: RuntimeVersionView[] = [];
    if (this.active?.source === 'legacy' && activeDir) rows.push({ runtimeId: this.active.runtimeId, runtimeVersion: this.active.runtimeVersion, soNovelVersion: this.active.soNovelVersion, platform: `${SUPPORTED_PLATFORM.platform}-${SUPPORTED_PLATFORM.arch}`, source: 'legacy', active: true });
    try {
      for (const name of readdirSync(this.layout.versions)) {
        const dir = join(this.layout.versions, name);
        if (!existsSync(manifestMarker(dir))) continue;
        const manifest = readVersionMarker(dir);
        if (!manifest) continue;
        rows.push({ runtimeId: manifest.runtimeId, runtimeVersion: manifest.runtimeVersion, soNovelVersion: manifest.soNovelVersion, platform: `${manifest.platform}-${manifest.arch}`, source: 'managed', active: dir === activeDir });
      }
    } catch { /* no managed versions yet */ }
    return rows;
  }

  private manifestForActive(): TrustedRuntimeManifest {
    if (this.active?.source === 'managed') {
      const dir = this.activeDir();
      const marker = dir ? readVersionMarker(dir) : undefined;
      if (marker?.archive) { try { return requireTrustedManifest(marker); } catch { /* fall through to pinned */ } }
    }
    return this.options.manifest;
  }

  private activeDir(): string | null {
    if (!this.active) return null;
    try {
      const dir = safeJoin(this.layout.base, this.active.path);
      return existsSync(dir) ? dir : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- engine access

  engine(): NovelEngineLike {
    const dir = this.activeDir() ?? safeJoin(this.layout.base, 'versions/missing');
    return this.makeEngine(dir);
  }

  async acquire(): Promise<{ engine: NovelEngineLike; release: () => void }> {
    while (this.switching) await this.sleep(80);
    if (this.stopped) throw new Error('运行时管理器已停止');
    if (this.health.state !== 'ok') throw new Error(`小说引擎未就绪：${this.health.message ?? '尚未安装'}`);
    const dir = this.activeDir();
    if (!dir) throw new Error('小说引擎目录不存在，需要修复安装');
    this.leases++;
    let released = false;
    return { engine: this.makeEngine(dir), release: () => { if (released) return; released = true; this.leases = Math.max(0, this.leases - 1); } };
  }

  private makeEngine(dir: string): NovelEngineLike {
    if (this.options.engineFactory) return this.options.engineFactory(dir, this.options.workDir, this.options.bridgeClasses);
    return new NovelEngine({ engineDir: dir, workDir: this.options.workDir, bridgeClasses: this.options.bridgeClasses, now: this.now });
  }

  // ---------------------------------------------------------------- install

  installOnline(runtimeId?: unknown): RuntimeInstallView {
    if (this.install && !['ready', 'failed', 'cancelled', 'interrupted'].includes(parsePhase(this.install.record.phase))) return this.installView()!;
    if (!this.platformSupported) throw new Error('当前平台暂不支持自动安装，请继续使用文件导入');
    if (!this.onlineSources.length) throw new Error('正式下载来源尚未配置，请使用离线运行时包导入');
    const target = this.resolveRelease(runtimeId);
    const installId = randomUUID();
    const record: InstallRecord = {
      schema: 1, installId, kind: 'online', phase: 'preparing', runtimeId: target.runtimeId,
      bytesReceived: 0, bytesTotal: target.archive.size, startedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(), error: null,
    };
    const internal: InternalInstall = { record, controller: new AbortController(), speed: null };
    this.install = internal;
    this.lastError = null;
    this.persist(internal);
    internal.promise = this.pipeline(internal, target, null).finally(() => { internal.promise = undefined; });
    return this.installView()!;
  }

  private resolveRelease(runtimeId: unknown): TrustedRuntimeManifest {
    if (runtimeId === undefined || runtimeId === null || runtimeId === this.options.manifest.runtimeId) return this.options.manifest;
    if (typeof runtimeId !== 'string') throw new Error('无效的运行时版本');
    const found = this.releases.find((release) => release.manifest.runtimeId === runtimeId);
    if (!found) throw new Error('该运行时版本不在受信清单中');
    return found.manifest;
  }

  importBegin(input: unknown): { id: string; chunkBytes: number } {
    if (!this.platformSupported) throw new Error('当前平台暂不支持安装运行时');
    if (this.install && !['ready', 'failed', 'cancelled', 'interrupted'].includes(parsePhase(this.install.record.phase))) throw new Error('已有安装正在进行，请先取消或等待完成');
    const value = input as { size?: unknown; filename?: unknown } | undefined;
    const begin = this.uploads.begin(value);
    const installId = randomUUID();
    const record: InstallRecord = {
      schema: 1, installId, kind: 'offline', phase: 'uploading', runtimeId: this.options.manifest.runtimeId,
      bytesReceived: 0, bytesTotal: Number(value?.size ?? 0), startedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(), error: null,
    };
    this.install = { record, controller: new AbortController(), speed: null };
    this.persist(this.install);
    return begin;
  }

  importChunk(id: unknown, offset: unknown, base64: unknown): { offset: number } {
    if (!this.install || this.install.record.kind !== 'offline' || this.install.record.phase !== 'uploading') throw new Error('没有进行中的离线包上传');
    const result = this.uploads.chunk(id, offset, base64);
    const now = this.now();
    const install = this.install;
    install.record.bytesReceived = result.offset;
    install.record.updatedAt = new Date(now).toISOString();
    if (install.lastSample) {
      const elapsed = (now - install.lastSample.at) / 1000;
      if (elapsed >= 0.4) {
        install.speed = Math.max(0, Math.round((result.offset - install.lastSample.bytes) / elapsed));
        install.lastSample = { at: now, bytes: result.offset };
      }
    } else install.lastSample = { at: now, bytes: result.offset };
    this.persist(install);
    return result;
  }

  importFinish(id: unknown): RuntimeInstallView {
    const install = this.install;
    if (!install || install.record.kind !== 'offline' || install.record.phase !== 'uploading') throw new Error('没有进行中的离线包上传');
    const upload = this.uploads.finish(id);
    install.record.bytesReceived = upload.size;
    install.record.archivePath = upload.file;
    install.controller = new AbortController();
    install.promise = this.pipeline(install, this.options.manifest, upload.file).finally(() => { install.promise = undefined; });
    return this.installView()!;
  }

  importCancel(id: unknown): RuntimeInstallView {
    try { this.uploads.cancel(id); } catch { /* already gone */ }
    this.cancel();
    return this.installView() ?? this.status().install ?? (() => { throw new Error('没有进行中的安装'); })();
  }

  private async pipeline(install: InternalInstall, manifest: TrustedRuntimeManifest, existingArchive: string | null): Promise<void> {
    const { record, controller } = install;
    const signal = controller.signal;
    const staging = join(this.layout.staging, record.installId);
    let archivePath = existingArchive;
    try {
      this.transition(install, 'preparing');
      this.checkDisk(manifest);
      removeIfExists(staging);
      mkdirSync(staging, { recursive: true });

      let archiveVerified = false;
      if (!archivePath) {
        archivePath = join(this.layout.downloads, `${manifest.archive.sha256}.part`);
        let lastError: Error | undefined;
        for (const source of this.onlineSources) {
          signal.throwIfAborted();
          removeIfExists(archivePath);
          this.transition(install, 'downloading');
          record.bytesReceived = 0;
          record.bytesTotal = manifest.archive.size;
          install.lastSample = { at: this.now(), bytes: 0 };
          install.speed = null;
          this.persist(install);
          try {
            const url = new URL(manifest.archive.path, source.baseUrl).toString();
            await this.options.download!({
              url, dest: archivePath, maxBytes: MAX_ARCHIVE_BYTES, allowedHosts: source.hosts, signal,
              allowInsecureLoopback: this.options.allowInsecureLoopback,
              onProgress: (received, total) => {
                record.bytesReceived = received; record.bytesTotal = total || manifest.archive.size;
                const now = this.now();
                if (install.lastSample) {
                  const elapsed = (now - install.lastSample.at) / 1000;
                  if (elapsed >= 0.4) { install.speed = Math.round((received - install.lastSample.bytes) / elapsed); install.lastSample = { at: now, bytes: received }; }
                }
                this.persist(install);
              },
            });
            await verifyArchive(archivePath, manifest);
            archiveVerified = true;
            lastError = undefined;
            break;
          } catch (error) {
            if (signal.aborted) throw error;
            lastError = error as Error;
            removeIfExists(archivePath);
          }
        }
        if (!archivePath || !archiveVerified) throw new Error(`所有下载源均失败：${lastError?.message ?? '未知错误'}`);
      }

      this.transition(install, 'verifying');
      if (!archiveVerified) await verifyArchive(archivePath, manifest);
      signal.throwIfAborted();

      this.transition(install, 'extracting');
      const payload = join(staging, 'payload');
      const extracted = await this.options.extract!(archivePath, payload, signal);
      if (!extracted.files.length) throw new Error('运行时包为空');
      await verifyExtractedPayload(payload, manifest);
      signal.throwIfAborted();

      const versionDir = this.reserveVersionDir(manifest);
      let moved = false;
      if (!existsSync(versionDir)) {
        mkdirSync(join(versionDir, '..'), { recursive: true });
        await moveDirectoryWithRetry(payload, versionDir);
        moved = true;
      }

      try {
        this.transition(install, 'probing');
        const health = await this.probeAt(versionDir, manifest, signal);
        if (health.state !== 'ok') throw new Error(health.message ?? '运行时自检失败');
        install.record.health = health;
        writeVersionMarker(versionDir, manifest);
        const target: ActivePointer = {
          schema: 1, runtimeId: manifest.runtimeId, source: 'managed', path: `versions/${versionDir.split(/[\\/]/u).pop()}`,
          manifestDigest: manifest.archive.sha256, runtimeVersion: manifest.runtimeVersion, soNovelVersion: manifest.soNovelVersion,
          activatedAt: new Date(this.now()).toISOString(),
        };

        this.transition(install, 'waiting_idle');
        await this.waitForIdle(signal);
        signal.throwIfAborted();
        // From here a cancel cannot report failure: activation is the commit.
        this.transition(install, 'activating');
        this.activate(target, health, signal, manifest);
      } catch (error) {
        if (moved) removeIfExists(versionDir);
        throw error;
      }

      // A different runtime version may have been released over time; keep the
      // active one and delete only inactive managed builds after success.
      this.cleanupOldVersions(versionDir);
      removeIfExists(staging);
      this.transition(install, 'ready');
      record.error = null;
      this.persist(install);
    } catch (error) {
      const aborted = signal.aborted || (error instanceof Error && error.message === 'cancelled');
      removeIfExists(staging);
      if (archivePath) { try { rmSync(archivePath, { force: true }); } catch { /* best effort */ } }
      if (this.active && this.health.state === 'ok') {
        // Old runtime stays active; nothing else to restore.
      }
      if (aborted) {
        record.phase = this.stopping ? 'interrupted' : 'cancelled';
        record.error = errorView(this.stopping ? 'interrupted' : 'cancelled', this.stopping ? '宿主关闭，安装已中断；原有引擎保持不变' : '安装已取消，原有引擎保持不变', true);
        this.lastError = record.error;
      } else {
        const mapped = mapError(error);
        record.phase = 'failed';
        record.error = mapped;
        this.lastError = mapped;
        record.diagnostic = sanitizeDiagnostic(error);
      }
      record.updatedAt = new Date(this.now()).toISOString();
      this.persist(install);
    }
  }

  private transition(install: InternalInstall, phase: InstallPhase): void {
    install.record.phase = phase;
    install.record.updatedAt = new Date(this.now()).toISOString();
    this.persist(install);
  }

  private persist(install: InternalInstall): void {
    atomicWriteJson(join(this.layout.installs, `${install.record.installId}.json`), install.record);
  }

  private reserveVersionDir(manifest: TrustedRuntimeManifest): string {
    const base = join(this.layout.versions, manifest.runtimeId);
    if (!existsSync(base)) return base;
    const marker = readVersionMarker(base);
    if (marker && payloadManifestMatches(marker, manifest)) {
      const activeIsBase = this.active?.source === 'managed' && this.active.path === `versions/${manifest.runtimeId}` && this.health.state === 'ok';
      if (!activeIsBase) return base;
    }
    return join(this.layout.versions, `${manifest.runtimeId}-${Date.now().toString(36)}`);
  }

  private activate(target: ActivePointer, health: RuntimeHealth, signal: AbortSignal, manifest?: TrustedRuntimeManifest): void {
    if (signal.aborted) throw new Error('cancelled');
    const previous = this.active && this.active.path !== target.path ? this.active : this.previous;
    if (previous) atomicWriteJson(join(this.layout.base, 'previous.json'), previous);
    this.previous = previous ?? null;
    const dir = safeJoin(this.layout.base, target.path);
    const quick = this.quickVerify(dir, manifest);
    if (!quick.ok) throw new Error(quick.message);
    atomicWriteJson(join(this.layout.base, 'active.json'), target);
    this.active = target;
    this.health = health;
    if (this.install) this.install.record.health = health;
    this.note = target.source === 'legacy' ? '已识别旧版引擎；建议升级到受管版本' : null;
  }

  private quickVerify(dir: string, manifestArg?: RuntimeManifest): { ok: boolean; message: string } {
    const manifest = manifestArg ?? this.manifestForActive();
    if (!existsSync(javaBinary(dir))) return { ok: false, message: '缺少运行时 Java' };
    const jar = findFile(manifest, 'app.jar');
    const rules = findFile(manifest, 'rules/main.json');
    if (!jar || !rules) return { ok: false, message: '受信清单缺少关键文件' };
    try {
      if (statSync(join(dir, 'app.jar')).size !== jar.size) return { ok: false, message: '引擎文件大小不符' };
      if (statSync(join(dir, 'rules', 'main.json')).size !== rules.size) return { ok: false, message: '书源规则大小不符' };
    } catch { return { ok: false, message: '运行时文件缺失' }; }
    return { ok: true, message: 'ok' };
  }

  private checkDisk(manifest: TrustedRuntimeManifest): void {
    try {
      const stats = statfsSync(this.layout.base);
      const free = Number(stats.bavail) * Number(stats.bsize);
      const needed = manifest.archive.size + manifest.payloadBytes + MIN_FREE_RESERVE;
      if (Number.isFinite(free) && free < needed) throw new Error(`磁盘空间不足：需要约 ${Math.ceil(needed / 1024 / 1024)} MiB`);
    } catch (error) {
      if ((error as Error).message.includes('磁盘空间不足')) throw error;
      // statfs is advisory on some volumes; the write itself is still checked.
    }
  }

  private async probeAt(dir: string, manifest: RuntimeManifest, signal?: AbortSignal): Promise<RuntimeHealth> {
    const probe = this.options.probe ?? probeRuntime;
    try {
      return await probe(dir, manifest, { bridgeClasses: this.options.bridgeClasses, signal, timeoutMs: 120_000 });
    } catch (error) {
      if (signal?.aborted) return { state: 'failed', checkedAt: new Date().toISOString(), message: '自检已取消' };
      return { state: 'failed', checkedAt: new Date().toISOString(), message: `自检失败：${(error as Error).message.slice(0, 200)}` };
    }
  }

  private waitForIdle(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        if (signal.aborted) return reject(new Error('cancelled'));
        if (this.leases === 0) return resolve();
        if (Date.now() - started > 8 * 60 * 60_000) return reject(new Error('等待在途任务结束超时'));
        setTimeout(tick, 250).unref?.();
      };
      tick();
    });
  }

  // ---------------------------------------------------------------- lifecycle

  cancel(): RuntimeInstallView | null {
    const install = this.install;
    if (!install) return null;
    const phase = parsePhase(install.record.phase);
    if (['ready'].includes(phase)) return this.installView();
    if (['cancelled', 'failed', 'interrupted'].includes(phase)) return this.installView();
    if (phase === 'activating') return this.installView();
    try { this.uploads.cancel(); } catch { /* no upload */ }
    install.controller.abort();
    install.record.phase = 'cancelled';
    install.record.error = errorView('cancelled', '安装已取消，原有引擎保持不变', true);
    install.record.updatedAt = new Date(this.now()).toISOString();
    this.persist(install);
    return this.installView();
  }

  async probe(): Promise<RuntimeProbeResult> {
    const dir = this.activeDir();
    if (!dir) {
      this.health = { state: 'failed', checkedAt: new Date().toISOString(), message: '尚未安装小说引擎' };
      return { ok: false, health: this.health };
    }
    const manifest = this.manifestForActive();
    // Explicit detection re-hashes the whole managed payload, not just key
    // files. The legacy flat directory also contains unrelated upstream files
    // (readme, changelog, logs), so it is verified by pinned pins + probe.
    if (this.active?.source === 'managed') {
      try { await verifyExtractedPayload(dir, manifest); }
      catch (error) {
        this.health = { state: 'failed', checkedAt: new Date().toISOString(), message: `运行时文件校验失败：${(error as Error).message.slice(0, 200)}` };
        return { ok: false, health: this.health };
      }
    }
    this.health = await this.probeAt(dir, manifest);
    if (this.health.state === 'ok' && this.active?.source === 'legacy') this.note = '旧版引擎可用；建议升级到受管版本';
    return { ok: this.health.state === 'ok', health: this.health };
  }

  async checkSource(): Promise<{ ok: boolean; message: string }> {
    const { checkSourceReachability } = await import('./probe.ts');
    const source = await import('../novel-sources.ts');
    const hosts = source.NOVEL_SOURCES.slice(0, 4).map((item) => item.host);
    let last = '没有可检测的书源';
    for (const host of hosts) {
      const result = await checkSourceReachability(host);
      if (result.ok) return { ok: true, message: `${host} · ${result.message}` };
      last = `${host} · ${result.message}`;
    }
    return { ok: false, message: last };
  }

  async downloadInfo(): Promise<RuntimeDownloadInfo> {
    const online = this.onlineState();
    const sources = this.onlineSources.map((source) => ({ name: source.name, url: new URL(this.options.manifest.archive.path, source.baseUrl).toString() }));
    if (this.offlineUrl && !sources.some((entry) => entry.url === this.offlineUrl)) sources.push({ name: '自定义离线地址', url: this.offlineUrl });
    const url = sources[0]?.url ?? null;
    if (!url) return { available: false, url: null, sources: [], fileName: null, sizeBytes: null, reason: online.reason };
    return { available: true, url, sources, fileName: this.options.manifest.archive.path, sizeBytes: this.options.manifest.archive.size, reason: null };
  }

  async checkUpdate(): Promise<RuntimeUpdateInfo> {
    const url = this.options.updateUrl;
    const key = this.options.updatePublicKey;
    if (!url || !key) return { supported: false, reason: '升级清单与签名公钥尚未配置；可导入离线包升级', available: null };
    try {
      const { fetchSignedUpdate } = await import('./update.ts');
      const releases = await fetchSignedUpdate({ url, publicKey: key, allowedHosts: this.allowedHosts });
      this.releases = releases.map((manifest) => ({ manifest }));
      const available = releases.find((manifest) => manifest.runtimeId !== this.active?.runtimeId) ?? null;
      return { supported: true, reason: null, available };
    } catch (error) {
      return { supported: true, reason: `检查更新失败：${(error as Error).message.slice(0, 200)}`, available: null };
    }
  }

  async rollback(): Promise<RuntimeStatusView> {
    const previous = this.previous;
    if (!previous) throw new Error('没有可回退的旧版本');
    const compatible = previous.runtimeVersion && this.options.manifest.extensionApi >= 1;
    if (!compatible) throw new Error('旧版本与当前扩展不兼容，无法回退');
    const dir = safeJoin(this.layout.base, previous.path);
    if (!existsSync(dir)) throw new Error('旧版本目录已不存在');
    const marker = readVersionMarker(dir) ?? this.options.manifest;
    if (marker.platform !== SUPPORTED_PLATFORM.platform || marker.arch !== SUPPORTED_PLATFORM.arch) throw new Error('旧版本平台不兼容');
    if (marker.bridgeProtocol !== this.options.manifest.bridgeProtocol) throw new Error('旧版本的桥接协议不兼容，无法回退');
    const health = await this.probeAt(dir, marker);
    if (health.state !== 'ok') throw new Error(`旧版本自检未通过：${health.message ?? 'unknown'}`);
    await this.waitForIdle(new AbortController().signal);
    this.switching = true;
    try {
      const current = this.active;
      atomicWriteJson(join(this.layout.base, 'previous.json'), current ?? previous);
      atomicWriteJson(join(this.layout.base, 'active.json'), previous);
      this.previous = current && current.path !== previous.path ? current : null;
      this.active = previous;
      this.health = health;
      this.note = '已回退到上一版本运行时';
    } finally { this.switching = false; }
    return this.status();
  }

  async uninstall(): Promise<RuntimeStatusView> {
    if (!this.active) return this.status();
    if (this.active.source === 'legacy') throw new Error('旧版平铺目录不是受管运行时；请先升级到受管版本再卸载');
    await this.waitForIdle(new AbortController().signal);
    this.switching = true;
    try {
      for (const name of ['active.json', 'previous.json']) removeIfExists(join(this.layout.base, name));
      removeIfExists(this.layout.versions);
      removeIfExists(this.layout.staging);
      removeIfExists(this.layout.downloads);
      mkdirSync(this.layout.versions, { recursive: true });
      mkdirSync(this.layout.staging, { recursive: true });
      mkdirSync(this.layout.downloads, { recursive: true });
      this.active = null;
      this.previous = null;
      this.health = { state: 'unknown', checkedAt: null };
      this.lastError = null;
      this.install = null;
      this.note = '运行时已卸载；已加入书架的书籍与阅读进度保持不变';
    } finally { this.switching = false; }
    return this.status();
  }

  async repair(): Promise<RuntimeInstallView> {
    if (!this.baseUrl) throw new Error('正式下载来源尚未配置，请使用离线运行时包修复');
    return this.installOnline(this.active?.runtimeId ?? this.options.manifest.runtimeId);
  }

  private cleanupOldVersions(activeDir: string): void {
    try {
      for (const name of readdirSync(this.layout.versions)) {
        const dir = join(this.layout.versions, name);
        if (dir === activeDir) continue;
        if (this.previous && `versions/${name}` === this.previous.path) continue;
        if (existsSync(manifestMarker(dir))) removeIfExists(dir);
      }
    } catch { /* best effort */ }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopped = true;
    this.uploads.close();
    if (this.install) {
      this.install.controller.abort();
      await Promise.allSettled([this.install.promise].filter(Boolean) as Promise<void>[]);
    }
    // Wait briefly for in-flight leases so a shutdown never deletes files in use.
    for (let attempt = 0; attempt < 40 && this.leases > 0; attempt++) await this.sleep(100);
  }

  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}

/** Keep diagnostics useful without leaking machine paths or environment values. */
function sanitizeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '<path>')
    .slice(0, 400);
}

/** Read only BOOKFISH_* keys from the deployment `.env`, matching host secret handling. */
function readDeploymentEnv(dataDir: string): Record<string, string> {
  try {
    const text = readFileSync(join(dataDir, '..', '.env'), 'utf8');
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/^\s*(BOOKFISH_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/u);
      if (!match) continue;
      values[match[1]!] = match[2]!.replace(/^['"]|['"]$/gu, '');
    }
    return values;
  } catch { return {}; }
}
