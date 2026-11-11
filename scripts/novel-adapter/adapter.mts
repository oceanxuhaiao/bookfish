/**
 * Isolated so-novel adapter.
 *
 * Responsibilities kept on the Bookfish side (never delegated to so-novel):
 * - candidate identity (title / author / source / revision)
 * - one consistent catalog snapshot per task
 * - task lifecycle: queued -> fetching -> validating -> complete | failed | cancelled
 * - independent completeness validation before the existing streaming import
 *
 * This file is deliberately outside `src/index.ts`: it is a proving harness,
 * not yet wired into the World. It never edits the user's live Coopanion data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNovelDownload, composeValidatedText, type CatalogChapter, type DownloadChapterFile, type NovelIntegrityIssue } from '../../src/novel-integrity.ts';
import { matchCandidate, normalizeIdentity, type NovelSearchCandidate } from '../../src/novel-match.ts';
import { Library } from '../../src/library.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');

export type NovelTaskState = 'queued' | 'fetching' | 'validating' | 'complete' | 'failed' | 'cancelled';

export type SearchCandidate = NovelSearchCandidate;
export { matchCandidate, normalizeIdentity };

export interface NovelTaskRecord {
  id: string;
  state: NovelTaskState;
  createdAt: string;
  updatedAt: string;
  candidate: SearchCandidate;
  workDir: string;
  downloadDir: string;
  error?: string;
  issues?: NovelIntegrityIssue[];
  catalogChapters?: number;
  downloadedChapters?: number;
  totalChars?: number;
  import?: { bookKey: string; title: string; author: string; totalChars: number; chapters: number; duplicate: boolean };
}

export interface AdapterConfig {
  /** Directory containing app.jar, config.ini, rules/ and runtime/. */
  runtimeDir: string;
  /** Bundled Java runtime executable. */
  java: string;
  /** Compiled SonovelBridge classes. */
  bridgeClasses: string;
  /** Scratch area for config, logs and downloads. */
  workDir: string;
}

export interface FetchOptions {
  /** Isolated shelf data directory. No production path is ever used implicitly. */
  shelfDir: string;
  /** Rule file used for catalog and download (fixture tests override main.json). */
  rulesFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  minChapterChars?: number;
  /** Re-parse the catalog after download and reject a changed snapshot. Default true. */
  verifyCatalogStable?: boolean;
}

const TRANSITIONS: Record<NovelTaskState, NovelTaskState[]> = {
  queued: ['fetching', 'failed', 'cancelled'],
  fetching: ['validating', 'failed', 'cancelled'],
  validating: ['complete', 'failed', 'cancelled'],
  complete: [],
  failed: [],
  cancelled: [],
};

export class NovelTaskError extends Error {
  task?: NovelTaskRecord;
  constructor(readonly code: 'cancelled' | 'failed' | 'invalid_input' | 'timeout', message: string, readonly issues?: NovelIntegrityIssue[]) {
    super(message);
    this.name = 'NovelTaskError';
  }
}

function defaultResearchRoot(): string {
  return resolve(PACKAGE_ROOT, '../../research/novel-fetch-20261109');
}

export function resolveAdapterConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const research = process.env.SONOVEL_RESEARCH_ROOT ?? defaultResearchRoot();
  const runtimeDir = overrides.runtimeDir ?? process.env.SONOVEL_RUNTIME_DIR ?? join(research, 'sonovel-runtime', 'SoNovel');
  const java = overrides.java ?? process.env.SONOVEL_JAVA ?? join(runtimeDir, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const bridgeClasses = overrides.bridgeClasses ?? join(HERE, 'bridge', 'classes');
  const workDir = overrides.workDir ?? join(PACKAGE_ROOT, 'output', 'novel-adapter');
  for (const [name, file] of [['app.jar', join(runtimeDir, 'app.jar')], ['java', java], ['bridge classes', join(bridgeClasses, 'SonovelBridge.class')]] as const) {
    if (!existsSync(file)) throw new Error(`Missing ${name}: ${file}`);
  }
  return { runtimeDir, java, bridgeClasses, workDir };
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function revisionOf(sourceId: number, url: string, latestChapter: string, lastUpdateTime: string): string {
  return sha(`${sourceId}\n${url}\n${latestChapter}\n${lastUpdateTime}`).slice(0, 16);
}

function writeTask(record: NovelTaskRecord): void {
  mkdirSync(record.workDir, { recursive: true });
  writeFileSync(join(record.workDir, 'task.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function transition(record: NovelTaskRecord, next: NovelTaskState): void {
  if (!TRANSITIONS[record.state].includes(next)) throw new Error(`Invalid novel task transition ${record.state} -> ${next}`);
  record.state = next;
  record.updatedAt = new Date().toISOString();
  writeTask(record);
}

interface RunResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }

function runProcess(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) return reject(new NovelTaskError('cancelled', 'Task cancelled before start'));
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const limit = 8 * 1024 * 1024;
    const onAbort = () => { if (!settled) { timedOut = false; killTree(child); } };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { if (settled) return; settled = true; cleanup(); reject(new NovelTaskError('failed', `Cannot start ${basename(command)}: ${error.message}`)); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted) reject(new NovelTaskError('cancelled', 'Task cancelled'));
      else if (timedOut) reject(new NovelTaskError('timeout', `Timed out after ${options.timeoutMs} ms`));
      else resolvePromise({ stdout, stderr, code, timedOut });
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

export class SonovelAdapter {
  readonly config: AdapterConfig;
  constructor(config: Partial<AdapterConfig> = {}) {
    this.config = resolveAdapterConfig(config);
  }

  private configFile(taskDir: string, rulesFile: string, sourceId: number, downloadDir: string): string {
    const ini = `[global]
auto-update = 0
gh-proxy =
cf-bypass =

[download]
download-path = ${downloadDir.replace(/\\/g, '/')}
extname = txt
txt-encoding = UTF-8
preserve-chapter-cache = 1
enable-progressbar = 0

[source]
language = zh-CN
active-rules = ${rulesFile.replace(/\\/g, '/')}
source-id = ${sourceId}
search-limit = 30
search-filter = 0

[crawl]
concurrency = 1
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
    const file = join(taskDir, 'config.ini');
    writeFileSync(file, ini, 'utf8');
    return file;
  }

  private async bridgeJson(configFile: string, mode: 'search' | 'toc' | 'book', args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
    const result = await runProcess(this.config.java, [
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      `-Dconfig.file=${configFile}`,
      '-cp', `${join(this.config.runtimeDir, 'app.jar')}${process.platform === 'win32' ? ';' : ':'}${this.config.bridgeClasses}`,
      'SonovelBridge', mode, ...args,
    ], { cwd: this.config.runtimeDir, signal, timeoutMs });
    const marker = result.stdout.indexOf('SONOVEL_JSON=');
    if (marker < 0) {
      const detail = (result.stderr || result.stdout).split(/\r?\n/u).filter(Boolean).slice(-4).join(' | ');
      throw new NovelTaskError('failed', `so-novel ${mode} returned no JSON (exit ${result.code}): ${detail.slice(0, 800)}`);
    }
    const raw = result.stdout.slice(marker + 'SONOVEL_JSON='.length).trim();
    try { return JSON.parse(raw); } catch { throw new NovelTaskError('failed', `so-novel ${mode} returned invalid JSON: ${raw.slice(0, 400)}`); }
  }

  /** Search one or more bundled sources and normalize candidate identity. */
  async search(query: string, options: { sourceIds?: number[]; rulesFile?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SearchCandidate[]> {
    const sourceIds = options.sourceIds ?? [8];
    const rulesFile = options.rulesFile ?? join(this.config.runtimeDir, 'rules', 'main.json');
    const scratch = join(this.config.workDir, 'scratch', randomUUID());
    mkdirSync(scratch, { recursive: true });
    const configFile = this.configFile(scratch, rulesFile, sourceIds[0]!, join(scratch, 'unused'));
    const candidates: SearchCandidate[] = [];
    const errors: string[] = [];
    for (const sourceId of sourceIds) {
      try {
        const results = await this.bridgeJson(configFile, 'search', [String(sourceId), query], options.signal, options.timeoutMs ?? 45_000);
        if (!Array.isArray(results)) continue;
        for (const item of results as Array<Record<string, unknown>>) {
          if (typeof item.url !== 'string' || typeof item.bookName !== 'string' || typeof item.author !== 'string') continue;
          const latestChapter = typeof item.latestChapter === 'string' ? item.latestChapter : '';
          const lastUpdateTime = typeof item.lastUpdateTime === 'string' ? item.lastUpdateTime : '';
          candidates.push({
            title: item.bookName, author: item.author, url: item.url,
            source: { id: Number(item.sourceId ?? sourceId), name: String(item.sourceName ?? `source-${sourceId}`) },
            revision: revisionOf(sourceId, item.url, latestChapter, lastUpdateTime),
            latestChapter, lastUpdateTime,
          });
        }
      } catch (error) {
        if ((error as Error).name === 'NovelTaskError' && (error as NovelTaskError).code === 'cancelled') throw error;
        errors.push(`source ${sourceId}: ${(error as Error).message}`);
      }
    }
    if (!candidates.length && errors.length) throw new NovelTaskError('failed', `Search failed on every source: ${errors.join(' || ')}`);
    return candidates;
  }

  /** Read the catalog exactly once for a task and keep its order/title/url list. */
  async toc(bookUrl: string, options: { rulesFile?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CatalogChapter[]> {
    const rulesFile = options.rulesFile ?? join(this.config.runtimeDir, 'rules', 'main.json');
    const scratch = join(this.config.workDir, 'scratch', randomUUID());
    mkdirSync(scratch, { recursive: true });
    const configFile = this.configFile(scratch, rulesFile, 1, join(scratch, 'unused'));
    const raw = await this.bridgeJson(configFile, 'toc', [bookUrl], options.signal, options.timeoutMs ?? 120_000);
    if (!Array.isArray(raw)) throw new NovelTaskError('failed', 'Catalog bridge did not return an array');
    return (raw as Array<Record<string, unknown>>).map((item, index) => ({
      order: Number.isSafeInteger(item.order) ? Number(item.order) : index + 1,
      title: String(item.title ?? '').trim(),
      url: String(item.url ?? ''),
    }));
  }

  /**
   * Run one download task. The task is persisted at every lifecycle step, and
   * the shelf is touched only after the independent gate returns complete.
   */
  async fetch(candidate: SearchCandidate, options: FetchOptions): Promise<NovelTaskRecord> {
    if (!candidate?.url || !/^https?:\/\//u.test(candidate.url)) throw new NovelTaskError('invalid_input', 'Invalid candidate URL');
    if (!options.shelfDir) throw new NovelTaskError('invalid_input', 'An explicit isolated shelfDir is required');
    const id = randomUUID();
    const workDir = join(this.config.workDir, 'tasks', id);
    const downloadDir = join(workDir, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const record: NovelTaskRecord = {
      id, state: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      candidate, workDir, downloadDir,
    };
    writeTask(record);
    const rulesFile = options.rulesFile ?? join(this.config.runtimeDir, 'rules', 'main.json');
    try {
      const catalog = await this.toc(candidate.url, { rulesFile, signal: options.signal, timeoutMs: 120_000 });
      record.catalogChapters = catalog.length;
      if (!catalog.length) throw new NovelTaskError('failed', 'Catalog is empty; download aborted');
      const identity = { title: candidate.title, author: candidate.author, sourceId: candidate.source.id, sourceName: candidate.source.name, bookUrl: candidate.url };
      const preflight = assessNovelDownload({ book: identity, catalog, files: [], catalogOnly: true });
      if (!preflight.complete) {
        record.issues = preflight.issues;
        transition(record, 'failed');
        throw new NovelTaskError('failed', `Catalog gate rejected the edition (${preflight.issues.length} issue${preflight.issues.length === 1 ? '' : 's'}); nothing was downloaded`, preflight.issues);
      }
      transition(record, 'fetching');

      const configFile = this.configFile(workDir, rulesFile, candidate.source.id, downloadDir);
      const stdoutFile = join(workDir, 'engine.stdout.log');
      const stderrFile = join(workDir, 'engine.stderr.log');
      const result = await runProcess(this.config.java, [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-Dmode=cli', `-Dconfig.file=${configFile}`, '-jar', join(this.config.runtimeDir, 'app.jar'),
        '--url', candidate.url, '--ext', 'txt',
      ], { cwd: this.config.runtimeDir, signal: options.signal, timeoutMs: options.timeoutMs ?? 30 * 60_000 });
      writeFileSync(stdoutFile, result.stdout, 'utf8');
      writeFileSync(stderrFile, result.stderr, 'utf8');
      if (result.code !== 0) throw new NovelTaskError('failed', `so-novel exited with code ${result.code}; see engine.stderr.log`);

      transition(record, 'validating');
      const files = readChapterFiles(downloadDir);
      record.downloadedChapters = files.length;
      const catalogAfter = options.verifyCatalogStable === false ? undefined : await this.toc(candidate.url, { rulesFile, signal: options.signal, timeoutMs: 120_000 });
      const verdict = assessNovelDownload({
        book: { title: candidate.title, author: candidate.author, sourceId: candidate.source.id, sourceName: candidate.source.name, bookUrl: candidate.url },
        catalog, files, catalogAfter,
        options: options.minChapterChars ? { minChapterChars: options.minChapterChars } : undefined,
      });
      record.totalChars = verdict.totalChars;
      if (!verdict.complete) {
        record.issues = verdict.issues;
        transition(record, 'failed');
        throw new NovelTaskError('failed', `Integrity gate rejected the download (${verdict.issues.length} issue${verdict.issues.length === 1 ? '' : 's'})`, verdict.issues);
      }

      const text = composeValidatedText({ title: candidate.title, author: candidate.author }, verdict.chapters);
      const validatedFile = join(workDir, 'validated.txt');
      writeFileSync(validatedFile, text, 'utf8');
      const imported = importIntoIsolatedShelf(options.shelfDir, validatedFile, candidate);
      record.import = imported;
      transition(record, 'complete');
      return record;
    } catch (error) {
      const taskError = error instanceof NovelTaskError ? error : new NovelTaskError('failed', (error as Error).message);
      if (taskError.code === 'cancelled') {
        if (record.state === 'queued' || record.state === 'fetching' || record.state === 'validating') transition(record, 'cancelled');
      } else if (record.state === 'queued' || record.state === 'fetching' || record.state === 'validating') {
        record.error = taskError.message.slice(0, 1000);
        if (taskError.issues) record.issues = taskError.issues;
        transition(record, 'failed');
      }
      taskError.task = record;
      throw taskError;
    }
  }
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

function importIntoIsolatedShelf(shelfDir: string, validatedFile: string, candidate: SearchCandidate) {
  const library = new Library({ dataDir: shelfDir });
  library.open();
  try {
    const filename = `so-novel-${candidate.source.id}-${candidate.revision}.txt`;
    const result = library.importFile({ filename, title: candidate.title, author: candidate.author }, validatedFile);
    const view = result.book;
    return { bookKey: view.key, title: view.title, author: view.author, totalChars: view.totalChars, chapters: view.identifiedChapters, duplicate: result.duplicate };
  } finally {
    library.close();
  }
}

/** Remove only a dedicated adapter-owned shelf, with a path guard. */
export function resetIsolatedShelf(shelfDir: string): void {
  const absolute = resolve(shelfDir);
  if (!absolute.includes(`${join('output', 'novel-adapter')}`)) throw new Error(`Refusing to reset non-adapter shelf: ${absolute}`);
  if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
}
