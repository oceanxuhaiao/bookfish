/**
 * Isolated so-novel process engine.
 *
 * The engine owns only discovery and download artifacts. Identity matching,
 * task lifecycle, page probing, completeness decisions and shelf import stay in
 * Bookfish (see novel-fetch.ts). Upstream so-novel sources are never modified.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNovelDownload, type CatalogChapter, type DownloadChapterFile } from './novel-integrity.ts';
import type { NovelSearchCandidate } from './novel-match.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_BRIDGE = join(HERE, 'novel-bridge', 'classes');
const SOURCE_IDS = [8] as const;

export interface NovelEngineAvailability {
  available: boolean;
  reason?: string;
  engineDir: string;
  version: string | null;
  /** The bridge always comes from the extension package, never from the runtime. */
  bridge: 'package' | 'missing';
}

export interface NovelEngineOptions {
  engineDir: string;
  workDir: string;
  /** Optional alternative rule file (isolated integration tests). */
  rulesFile?: string;
  /** Optional override used by isolated tests. */
  java?: string;
  bridgeClasses?: string;
  now?: () => number;
}

export interface NovelDownloadResult {
  taskDir: string;
  downloadDir: string;
  files: DownloadChapterFile[];
  exitCode: number | null;
  stderrTail: string;
}

function javaName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function revisionOf(sourceId: number, url: string, latestChapter: string, lastUpdateTime: string): string {
  return sha(`${sourceId}\n${url}\n${latestChapter}\n${lastUpdateTime}`).slice(0, 16);
}

export function defaultEngineDir(dataDir: string): string {
  return join(dataDir, 'bookfish', 'novel-engine');
}

export function engineAvailability(engineDir: string, bridgeClasses?: string, rulesFile?: string): NovelEngineAvailability {
  const bridge = existsSync(join(bridgeClasses ?? PACKAGE_BRIDGE, 'SonovelBridge.class')) ? 'package' : 'missing';
  const missing: string[] = [];
  if (!existsSync(join(engineDir, 'app.jar'))) missing.push('app.jar');
  if (!existsSync(join(engineDir, 'runtime', 'bin', javaName()))) missing.push(`runtime/bin/${javaName()}`);
  const rules = rulesFile ?? join(engineDir, 'rules', 'main.json');
  if (!existsSync(rules)) missing.push('rules/main.json');
  if (bridge === 'missing') missing.push('SonovelBridge.class');
  let version: string | null = null;
  try { version = JSON.parse(readFileSync(join(engineDir, 'runtime-manifest.json'), 'utf8')).soNovelVersion ?? null; } catch {
    try { version = JSON.parse(readFileSync(join(engineDir, 'engine.json'), 'utf8')).soNovelVersion ?? null; } catch { /* legacy provenance is optional */ }
  }
  return missing.length ? { available: false, reason: `Missing ${missing.join(', ')} in ${engineDir}`, engineDir, version, bridge }
    : { available: true, engineDir, version, bridge };
}

interface RunResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }

function runProcess(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('cancelled'));
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const limit = 8 * 1024 * 1024;
    const onAbort = () => { if (!settled) killTree(child); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error(`Cannot start ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; cleanup();
      if (options.signal?.aborted) reject(new Error('cancelled'));
      else if (timedOut) reject(new Error(`Timed out after ${options.timeoutMs} ms`));
      else resolve({ stdout, stderr, code, timedOut });
    });
    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best effort */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* best effort */ }
  }
}

function countChapterFiles(downloadDir: string): number {
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^\d+_.*\.txt$/iu.test(entry.name)) count++;
    }
  };
  try { if (existsSync(downloadDir)) walk(downloadDir); } catch { /* file system race while the engine writes */ }
  return count;
}

function readChapterFiles(downloadDir: string): DownloadChapterFile[] {
  const result: DownloadChapterFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
        const match = entry.name.match(/^(\d+)_(.*)\.txt$/u);
        if (!match) continue;
        result.push({ order: Number(match[1]), title: match[2]!, text: readFileSync(file, 'utf8') });
      }
    }
  };
  if (existsSync(downloadDir)) walk(downloadDir);
  return result.sort((a, b) => a.order - b.order);
}

export class NovelEngine {
  readonly engineDir: string;
  readonly workDir: string;
  private readonly java: string;
  private readonly bridgeClasses: string;
  private readonly rulesFile: string;
  private readonly now: () => number;

  constructor(options: NovelEngineOptions) {
    this.engineDir = options.engineDir;
    this.workDir = options.workDir;
    this.java = options.java ?? join(this.engineDir, 'runtime', 'bin', javaName());
    this.bridgeClasses = options.bridgeClasses ?? PACKAGE_BRIDGE;
    this.rulesFile = options.rulesFile ?? join(this.engineDir, 'rules', 'main.json');
    this.now = options.now ?? Date.now;
  }

  availability(): NovelEngineAvailability {
    return engineAvailability(this.engineDir, this.bridgeClasses, this.rulesFile);
  }

  private requireAvailable(): void {
    const status = this.availability();
    if (!status.available) throw new Error(`Novel engine unavailable: ${status.reason}`);
  }

  private configFile(dir: string, downloadDir: string, sourceId: number, concurrency = 1): string {
    const rules = this.rulesFile.replace(/\\/gu, '/');
    const ini = `[global]
auto-update = 0
gh-proxy =
cf-bypass =

[download]
download-path = ${downloadDir.replace(/\\/gu, '/')}
extname = txt
txt-encoding = UTF-8
preserve-chapter-cache = 1
enable-progressbar = 0

[source]
language = zh-CN
active-rules = ${rules}
source-id = ${sourceId}
search-limit = 30
search-filter = 0

[crawl]
concurrency = ${concurrency}
min-interval = 250
max-interval = 350
enable-retry = 1
max-retries = 2
retry-min-interval = 800
retry-max-interval = 1200

[web]
enabled = 0
port = 0

[cookie]
qidian =

[proxy]
enabled = 0
host = 127.0.0.1
port = 0
`;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.ini');
    writeFileSync(file, ini, 'utf8');
    return file;
  }

  private scratch(): string {
    const dir = join(this.workDir, 'scratch', randomUUID());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async bridgeJson(configFile: string, mode: 'search' | 'toc' | 'book' | 'download', args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
    const classpath = `${join(this.engineDir, 'app.jar')}${process.platform === 'win32' ? ';' : ':'}${this.bridgeClasses}`;
    const result = await runProcess(this.java, [
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      `-Dconfig.file=${configFile}`, '-cp', classpath, 'SonovelBridge', mode, ...args,
    ], { cwd: this.engineDir, signal, timeoutMs });
    const marker = result.stdout.indexOf('SONOVEL_JSON=');
    if (marker < 0) {
      const detail = (result.stderr || result.stdout).split(/\r?\n/u).filter(Boolean).slice(-4).join(' | ');
      throw new Error(`so-novel ${mode} returned no JSON (exit ${result.code}): ${detail.slice(0, 600)}`);
    }
    try { return JSON.parse(result.stdout.slice(marker + 'SONOVEL_JSON='.length).trim()); }
    catch { throw new Error(`so-novel ${mode} returned invalid JSON`); }
  }

  /** Search the bundled sources and normalize candidate identity. */
  async search(query: string, options: { sourceIds?: number[]; signal?: AbortSignal; timeoutMs?: number; onProgress?: (done: number, total: number, sourceId: number) => void } = {}): Promise<NovelSearchCandidate[]> {
    this.requireAvailable();
    const sources = options.sourceIds ?? [...SOURCE_IDS];
    const dir = this.scratch();
    try {
      const config = this.configFile(dir, join(dir, 'unused'), sources[0]!);
      const candidates: NovelSearchCandidate[] = [];
      let lastError: Error | undefined;
      let done = 0;
      for (const sourceId of sources) {
        try {
          const results = await this.bridgeJson(config, 'search', [String(sourceId), query], options.signal, options.timeoutMs ?? 45_000);
          if (Array.isArray(results)) {
            for (const item of results as Array<Record<string, unknown>>) {
              if (typeof item.url !== 'string' || typeof item.bookName !== 'string' || typeof item.author !== 'string') continue;
              const latestChapter = typeof item.latestChapter === 'string' ? item.latestChapter : '';
              const lastUpdateTime = typeof item.lastUpdateTime === 'string' ? item.lastUpdateTime : '';
              candidates.push({
                title: item.bookName, author: item.author, url: item.url,
                source: { id: Number(item.sourceId ?? sourceId), name: String(item.sourceName ?? `source-${sourceId}`) },
                revision: revisionOf(sourceId, item.url, latestChapter, lastUpdateTime), latestChapter, lastUpdateTime,
              });
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          lastError = error as Error;
        } finally {
          done++;
          options.onProgress?.(done, sources.length, sourceId);
        }
      }
      if (!candidates.length && lastError) throw lastError;
      return candidates;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async toc(bookUrl: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CatalogChapter[]> {
    this.requireAvailable();
    const dir = this.scratch();
    try {
      const config = this.configFile(dir, join(dir, 'unused'), 1);
      const raw = await this.bridgeJson(config, 'toc', [bookUrl], options.signal, options.timeoutMs ?? 120_000);
      if (!Array.isArray(raw)) throw new Error('Catalog bridge did not return an array');
      return (raw as Array<Record<string, unknown>>).map((item, index) => ({
        order: Number.isSafeInteger(item.order) ? Number(item.order) : index + 1,
        title: String(item.title ?? '').trim(),
        url: String(item.url ?? ''),
      }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  /**
   * Download one catalog snapshot into an isolated work directory. The caller
   * must have verified the catalog and must validate the returned files before
   * importing anything.
   */
  async download(candidate: NovelSearchCandidate, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    catalogChapters?: number;
    onProgress?: (downloaded: number, total: number) => void;
    onDownloadDir?: (downloadDir: string) => void;
  } = {}): Promise<NovelDownloadResult> {
    this.requireAvailable();
    const taskDir = join(this.workDir, 'tasks', randomUUID());
    const downloadDir = join(taskDir, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    options.onDownloadDir?.(downloadDir);
    // Long serials are tens of minutes at concurrency 1. Two workers stay
    // well below the sources' published limits while roughly halving wall time.
    const concurrency = (options.catalogChapters ?? 0) >= 1000 ? 2 : 1;
    const config = this.configFile(taskDir, downloadDir, candidate.source.id, concurrency);
    let lastCount = -1;
    const poll = setInterval(() => {
      const count = countChapterFiles(downloadDir);
      if (count !== lastCount) {
        lastCount = count;
        try { options.onProgress?.(count, options.catalogChapters ?? 0); } catch { /* progress callback is advisory */ }
      }
    }, 700);
    poll.unref?.();
    try {
      const result = await runProcess(this.java, [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-Dmode=cli', `-Dconfig.file=${config}`, '-jar', join(this.engineDir, 'app.jar'),
        '--url', candidate.url, '--ext', 'txt',
      ], { cwd: this.engineDir, signal: options.signal, timeoutMs: options.timeoutMs ?? 30 * 60_000 });
      writeFileSync(join(taskDir, 'engine.stdout.log'), result.stdout, 'utf8');
      writeFileSync(join(taskDir, 'engine.stderr.log'), result.stderr, 'utf8');
      const files = readChapterFiles(downloadDir);
      const stderrTail = result.stderr.split(/\r?\n/u).filter(Boolean).slice(-8).join('\n').slice(0, 1200);
      return { taskDir, downloadDir, files, exitCode: result.code, stderrTail };
    } finally { clearInterval(poll); }
  }

  /**
   * Continue an interrupted download in its existing directory.
   * Only chapters missing from `catalog` are fetched; existing files are kept.
   */
  async resume(candidate: NovelSearchCandidate, options: {
    downloadDir: string;
    catalog: Array<{ order: number; title: string; url: string }>;
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (downloaded: number, total: number) => void;
  }): Promise<NovelDownloadResult> {
    this.requireAvailable();
    const downloadDir = options.downloadDir;
    const taskDir = dirname(downloadDir);
    mkdirSync(downloadDir, { recursive: true });
    // Remove files that no longer belong to this catalog, plus empty/placeholder
    // chapters so a recheck can try to fetch a fresh copy.
    const catalogOrders = new Set(options.catalog.map((chapter) => chapter.order));
    for (const name of readdirSync(downloadDir, { recursive: true, encoding: 'utf8' })) {
      const base = name.split(/[\\/]/u).pop() ?? '';
      const match = base.match(/^(\d+)_.*\.txt$/u);
      if (!match) continue;
      const file = join(downloadDir, name);
      const text = readFileSync(file, 'utf8');
      if (!catalogOrders.has(Number(match[1])) || !text.trim() || /(正在手打中|章节内容加载失败|章节不存在|请稍后再试|请稍候)/u.test(text)) rmSync(file, { force: true });
    }
    const have = new Set(readChapterFiles(downloadDir).map((file) => file.order));
    const missing = options.catalog.filter((chapter) => !have.has(chapter.order));
    if (!missing.length) {
      return { taskDir, downloadDir, files: readChapterFiles(downloadDir), exitCode: 0, stderrTail: '' };
    }
    const ordersFile = join(taskDir, `missing-${randomUUID()}.txt`);
    writeFileSync(ordersFile, `${missing.map((chapter) => chapter.order).join('\n')}\n`, 'utf8');
    const config = this.configFile(taskDir, downloadDir, candidate.source.id, 1);
    const total = options.catalog.length;
    const poll = setInterval(() => {
      try { options.onProgress?.(readChapterFiles(downloadDir).length, total); } catch { /* advisory */ }
    }, 700);
    poll.unref?.();
    try {
      await this.bridgeJson(config, 'download', [candidate.url, ordersFile], options.signal, options.timeoutMs ?? 30 * 60_000);
      const files = readChapterFiles(downloadDir);
      return { taskDir, downloadDir, files, exitCode: 0, stderrTail: '' };
    } finally { clearInterval(poll); }
  }

  /** Pre-download gate shared with the caller's record so a mixed edition never downloads. */
  preflight(identity: { title: string; author: string; sourceId: number; sourceName: string; bookUrl: string }, catalog: CatalogChapter[]) {
    return assessNovelDownload({ book: identity, catalog, files: [], catalogOnly: true });
  }

  /** Fingerprint used to prove that the post-download catalog is the same snapshot. */
  catalogIdentity(catalog: CatalogChapter[]): string {
    return sha(JSON.stringify(catalog.map((chapter) => [chapter.order, chapter.title, chapter.url])));
  }

  taskSize(taskDir: string): number {
    try { return statSync(join(taskDir, 'engine.stdout.log')).size; } catch { return 0; }
  }
}
