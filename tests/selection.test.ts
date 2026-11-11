import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { NovelFetches, type NovelEngineLike } from '../src/novel-fetch.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { SelectionCoordinator } from '../src/selection.ts';
import { BOOKFISH_DEFAULTS, type BookfishConfigSection } from '../src/config.ts';
import { digest } from '../src/books.ts';
import { serialCatalogHash, type SerialRecord } from '../src/serial-types.ts';
import type { CachedChapter, ChapterLink, SourceCatalog } from '../src/source-types.ts';
import { randomUUID } from 'node:crypto';
import { assessNovelDownload, type CatalogChapter, type DownloadChapterFile, type NovelIntegrityIssue } from '../src/novel-integrity.ts';
import type { NovelDownloadResult, NovelEngineAvailability } from '../src/novel-engine.ts';
import type { NovelSearchCandidate } from '../src/novel-match.ts';
import { FakeHost } from './helpers/fake-host.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const candidate = (title: string, author = '小鱼', sourceId = 8): NovelSearchCandidate => {
  const id = Array.from(title).reduce((n, ch) => n + ch.codePointAt(0)!, 17);
  return { title, author,
    url: sourceId === 5 ? `https://www.xbiquwk.com/${id}_1/` : `https://www.biquge365.net/book/${id}/`,
    source: { id: sourceId, name: sourceId === 5 ? '笔尖中文' : '笔趣阁365' },
    revision: 'abcdef1234567890', latestChapter: '第3章', lastUpdateTime: '11-10' };
};

function catalog(): CatalogChapter[] {
  return [1, 2, 3].map((order) => ({ order, title: `第${order}章 海风`, url: `https://www.biquge365.net/chapter/1/${order}.html` }));
}
function files(): DownloadChapterFile[] {
  return catalog().map((chapter) => ({ order: chapter.order, title: chapter.title,
    text: `${chapter.title}\n\n　　${'海风吹过码头，小鱼取出一封信。'.repeat(8)}\n` }));
}

class Engine implements NovelEngineLike {
  failNetwork = false;
  failIntegrity = false;
  noResult = new Set<string>();
  multiSource = false;
  rejectSources = new Set<number>();
  constructor(private readonly taskDir: string) {}
  availability(): NovelEngineAvailability { return { available: true, engineDir: '/engine', version: '1.12.0', bridge: 'package' }; }
  async search(query: string) {
    if (this.noResult.has(query)) return [];
    return this.multiSource ? [candidate(query, '小鱼', 8), candidate(query, '小鱼', 5)] : [candidate(query)];
  }
  async toc() { return catalog(); }
  async download(): Promise<NovelDownloadResult> {
    if (this.failNetwork) throw new Error('network offline');
    const list = this.failIntegrity ? files().slice(0, 2) : files();
    return { taskDir: this.taskDir, downloadDir: join(this.taskDir, 'downloads'), files: list, exitCode: 0, stderrTail: '' };
  }
  preflight(identity: { title: string; author: string; sourceId: number; sourceName: string; bookUrl: string }, list: CatalogChapter[]) {
    if (this.rejectSources.has(identity.sourceId)) { const issues: NovelIntegrityIssue[] = [{ code: 'catalog_duplicate_number', message: 'controlled catalog rejection' }]; return { complete: false, issues }; }
    return assessNovelDownload({ book: identity, catalog: list, files: [], catalogOnly: true });
  }
}

function setup(options: { cfg?: Partial<BookfishConfigSection>; engine?: Engine } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bookfish-selection-')); dirs.push(dataDir);
  const taskDir = mkdtempSync(join(tmpdir(), 'bookfish-selection-task-')); dirs.push(taskDir);
  const cfg: BookfishConfigSection = { ...BOOKFISH_DEFAULTS, allowNetwork: true, autonomousAcquisition: true,
    autonomousAcquisitionMode: 'auto', realRoutineEnabled: false, ...options.cfg };
  const lib = new Library({ dataDir }); lib.open();
  const engine = options.engine ?? new Engine(taskDir);
  let coordinator!: SelectionCoordinator;
  const scheduler = new ReadingScheduler(lib, cfg, 'UTC', undefined, undefined, { autoAdvance: () => coordinator.autoAdvance() });
  const fetches = new NovelFetches(engine, (file, metadata) => lib.importFile(metadata, file), {
    workDir: join(dataDir, 'novel-fetch'), pageProbe: null,
    onSearchDone: (job) => coordinator?.onSearchDone(job),
    onTaskTerminal: (task) => coordinator?.onTaskTerminal(task),
  });
  coordinator = new SelectionCoordinator({ library: lib, novelFetches: fetches, scheduler,
    cfg: () => cfg, timezone: 'UTC' });
  const host = new FakeHost();
  coordinator.start(host);
  return { dataDir, taskDir, cfg, lib, engine, fetches, coordinator, scheduler, host };
}

async function waitFor(check: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for selection state');
}

function close(ctx: ReturnType<typeof setup>) {
  return (async () => { await ctx.coordinator.stop(); await ctx.fetches.stop(); ctx.lib.close(); })();
}

describe('autonomous selection state machine', () => {
  it('fails over to different works, rejects source/edition retries, stops after three, and pauses globally', async () => {
    const ctx = setup();
    try {
      ctx.engine.noResult.add('不存在的书');
      const first = ctx.coordinator.startSearch({ title: '不存在的书', author: '无人', reason: '想看看' });
      expect(first.allowed).toBe(true);
      await waitFor(() => ctx.coordinator.summary().intent?.status === 'failed');
      expect(ctx.coordinator.summary().intent?.failure?.code).toBe('no_result');

      // Same work cannot re-enter through another source or version.
      const repeated = ctx.coordinator.startSearch({ title: '不存在的书', author: '无人', reason: '换源再试' });
      expect(repeated.allowed).toBe(false);
      expect((repeated.gate as { code: string }).code).toBe('duplicate_work');

      ctx.engine.failIntegrity = true;
      const second = ctx.coordinator.startSearch({ title: '第二本', author: '小鱼', reason: '换一本' });
      expect(second.allowed).toBe(true);
      await waitFor(() => ctx.coordinator.summary().intent?.status === 'failed');
      expect(ctx.coordinator.summary().intent?.failure?.code).toBe('integrity_failed');

      const third = ctx.coordinator.startSearch({ title: '第三本', author: '小鱼', reason: '再换一本' });
      expect(third.allowed).toBe(true);
      await waitFor(() => ctx.coordinator.summary().intent?.status === 'failed');
      const exhausted = ctx.coordinator.gate();
      expect(exhausted.allowed).toBe(false);
      expect(exhausted.code).toBe('cooldown');
      const fourth = ctx.coordinator.startSearch({ title: '第四本', author: '小鱼', reason: '继续' });
      expect(fourth.allowed).toBe(false);
      expect((fourth.gate as { code: string }).code).toBe('cooldown');

      // A global fault is a pause, not another attempt.
      const fresh = setup();
      try {
        fresh.engine.failNetwork = true;
        const started = fresh.coordinator.startSearch({ title: '断网书', author: '小鱼', reason: '试试' });
        expect(started.allowed).toBe(true);
        await waitFor(() => ['deferred', 'failed'].includes(fresh.coordinator.summary().intent?.status ?? ''));
        expect(fresh.coordinator.summary().intent?.status).toBe('deferred');
        expect(fresh.coordinator.gate().code).toBe('round_paused');
      } finally { await close(fresh); }
    } finally { await close(ctx); }
  });

  it('preflights exact candidates and skips a source whose catalog is rejected', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'bookfish-selection-preflight-task-')); dirs.push(taskDir);
    const engine = new Engine(taskDir); engine.multiSource = true; engine.rejectSources.add(8);
    const ctx = setup({ engine });
    try {
      const started = ctx.coordinator.startSearch({ title: '双源书', author: '小鱼', reason: '找一本来源可靠的书。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => ctx.lib.list().length === 1 && ctx.coordinator.summary().intent?.status === 'reading');
      const tasks = ctx.fetches.status().tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.source.id).toBe(5);
      expect(ctx.lib.selection().intents[0]!.status).toBe('reading');
    } finally { await close(ctx); }
  });

  it('treats a pet-selected book as an unfinished commitment through pause, switch and restart, and only full confirmation releases it', async () => {
    const ctx = setup();
    try {
      const started = ctx.coordinator.startSearch({ title: '海边的信', author: '小鱼', reason: '最近想读一本短篇。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => ctx.lib.list().length === 1 && ctx.coordinator.summary().intent?.status === 'reading');
      expect(ctx.lib.list()[0]?.title).toBe('海边的信');
      const intent = ctx.coordinator.summary().intent!;
      expect(intent.bookKey).toBeTruthy();
      expect(ctx.coordinator.summary().queue).toHaveLength(1);
      expect(ctx.coordinator.gate().code).toBe('self_selected_unfinished');
      expect(ctx.coordinator.autoAdvance()).toBe(true);
      expect(ctx.lib.status().current?.key).toBe(intent.bookKey);
      expect(ctx.lib.selection().queue[0]!.status).toBe('active');

      const blocked = ctx.coordinator.startSearch({ title: '另一本', author: '小鱼', reason: '再找一本' });
      expect(blocked.allowed).toBe(false);
      expect((blocked.gate as { code: string }).code).toBe('self_selected_unfinished');

      ctx.lib.setPaused(true);
      expect(['self_selected_unfinished', 'reading_paused']).toContain(ctx.coordinator.gate().code);
      ctx.lib.setPaused(false);
      expect(ctx.coordinator.gate().code).toBe('self_selected_unfinished');
      // Switching to a user-imported book does not release the pet's own commitment.
      const local = ctx.lib.importBytes({ filename: '本地.txt', title: '本地书', author: '用户' }, Buffer.from('海风。'.repeat(200)));
      ctx.lib.select(local.book.key);
      expect(ctx.coordinator.gate().code).toBe('self_selected_unfinished');

      await close(ctx);
      const reopened = new Library({ dataDir: ctx.dataDir }); reopened.open();
      let coordinator!: SelectionCoordinator;
      const scheduler = new ReadingScheduler(reopened, ctx.cfg, 'UTC', undefined, undefined, { autoAdvance: () => coordinator.autoAdvance() });
      const fetches = new NovelFetches(new Engine(ctx.taskDir), (file, metadata) => reopened.importFile(metadata, file), {
        workDir: join(ctx.dataDir, 'novel-fetch'), pageProbe: null,
        onSearchDone: (job) => coordinator?.onSearchDone(job),
        onTaskTerminal: (task) => coordinator?.onTaskTerminal(task),
      });
      coordinator = new SelectionCoordinator({ library: reopened, novelFetches: fetches, scheduler,
        cfg: () => ctx.cfg, timezone: 'UTC' });
      coordinator.start(new FakeHost());
      try {
        expect(coordinator.gate().code).toBe('self_selected_unfinished');
        const key = intent.bookKey!;
        reopened.select(key);
        const total = reopened.status().current!.totalSegments;
        for (let i = 0; i < total; i++) {
          const task = reopened.readNext();
          if (task.complete) break;
          reopened.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: `第${i}段测试确认` });
        }
        expect(coordinator.gate().code).toBe('round_exhausted');
        expect(coordinator.summary().intent?.status).toBe('completed');
      } finally { await coordinator.stop(); await fetches.stop(); reopened.close(); }
    } finally { if (ctx.lib.status().mounted) await close(ctx); }
  });

  it('recovers the queue after an import receipt and deduplicates repeated terminal callbacks', async () => {
    const ctx = setup();
    try {
      const started = ctx.coordinator.startSearch({ title: '海边的信', author: '小鱼', reason: '想读。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => ctx.lib.list().length === 1 && ctx.coordinator.summary().intent?.status === 'reading');
      const intent = ctx.coordinator.summary().intent!;
      const bookKey = intent.bookKey!;
      // Simulate a crash between import and queue persistence, then revive.
      ctx.lib.updateSelection((draft) => { draft.queue = []; });
      expect(ctx.lib.selection().queue).toHaveLength(0);
      const task = ctx.fetches.get(ctx.lib.selection().intents[0]!.acquisitionTaskId!);
      ctx.coordinator.onTaskTerminal(task);
      ctx.coordinator.onTaskTerminal(task);
      expect(ctx.lib.selection().queue).toHaveLength(1);
      expect(ctx.lib.selection().queue[0]!.bookKey).toBe(bookKey);

      // Crash again, with an import receipt but no queue row. Restart must add one queue row only.
      ctx.lib.updateSelection((draft) => { draft.queue = []; });
      await close(ctx);
      const reopened = new Library({ dataDir: ctx.dataDir }); reopened.open();
      let coordinator!: SelectionCoordinator;
      const scheduler = new ReadingScheduler(reopened, ctx.cfg, 'UTC', undefined, undefined, { autoAdvance: () => coordinator.autoAdvance() });
      const fetches = new NovelFetches(new Engine(ctx.taskDir), (file, metadata) => reopened.importFile(metadata, file), {
        workDir: join(ctx.dataDir, 'novel-fetch'), pageProbe: null,
        onSearchDone: (job) => coordinator?.onSearchDone(job), onTaskTerminal: (item) => coordinator?.onTaskTerminal(item),
      });
      coordinator = new SelectionCoordinator({ library: reopened, novelFetches: fetches, scheduler, cfg: () => ctx.cfg, timezone: 'UTC' });
      coordinator.start(new FakeHost());
      try {
        expect(reopened.list()).toHaveLength(1);
        expect(reopened.selection().queue).toHaveLength(1);
        expect(reopened.selection().queue[0]!.bookKey).toBe(bookKey);
      } finally { await coordinator.stop(); await fetches.stop(); reopened.close(); }
    } finally { if (ctx.lib.status().mounted) await close(ctx); }
  });

  it('rejects unknown or expired candidate ids, respects the source allowlist, and pauses on user cancellation', async () => {
    const notify = setup({ cfg: { autonomousAcquisitionMode: 'notify', autonomousSourceIds: '8' } });
    try {
      const started = notify.coordinator.startSearch({ title: '候选书', author: '小鱼', reason: '先看看版本。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => notify.coordinator.summary().intent?.status === 'awaiting_choice');
      const candidateId = notify.coordinator.candidates(started.intentId as string)[0]!.candidateId as string;
      expect(() => notify.coordinator.acquireCandidate('bogus')).toThrow(/Unknown server candidate/);
      notify.lib.updateSelection((draft) => {
        const candidate = draft.intents[0]!.candidates[0]!; candidate.expiresAt = 0;
      });
      expect(() => notify.coordinator.acquireCandidate(candidateId)).toThrow(/expired/);
      notify.coordinator.cancel(started.intentId);
      expect(notify.coordinator.summary().intent?.status).toBe('cancelled');
      expect(notify.coordinator.gate().code).toBe('round_paused');
    } finally { await close(notify); }

    const restricted = setup({ cfg: { autonomousSourceIds: '5' } });
    try {
      const blocked = restricted.coordinator.startSearch({ title: '来源不允许', author: '小鱼', reason: '试试' });
      expect(blocked.allowed).toBe(true);
      await waitFor(() => restricted.coordinator.summary().intent?.status === 'failed');
      expect(restricted.coordinator.summary().intent?.failure?.code).toBe('no_result');
      expect(restricted.lib.list()).toHaveLength(0);
    } finally { await close(restricted); }
  });

  it('pauses an uncommitted autonomous chain when the feature is switched off', async () => {
    const ctx = setup({ cfg: { autonomousAcquisitionMode: 'notify' } });
    try {
      const started = ctx.coordinator.startSearch({ title: '未完成的选书', author: '小鱼', reason: '先看看。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => ctx.coordinator.summary().intent?.status === 'awaiting_choice');
      ctx.cfg.autonomousAcquisition = false;
      ctx.coordinator.onConfigChanged();
      expect(ctx.coordinator.summary().intent?.status).toBe('deferred');
      expect(ctx.coordinator.gate().code).toBe('autonomous_disabled');
    } finally { await close(ctx); }
  });

  it('reports a completed import after cancellation without undoing the book or queuing it', async () => {
    const ctx = setup();
    try {
      const started = ctx.coordinator.startSearch({ title: '海边的信', author: '小鱼', reason: '想读。' });
      expect(started.allowed).toBe(true);
      await waitFor(() => ctx.lib.list().length === 1 && ctx.coordinator.summary().intent?.status === 'reading');
      const intent = ctx.coordinator.summary().intent!;
      const task = ctx.fetches.get(ctx.lib.selection().intents[0]!.acquisitionTaskId!);
      ctx.lib.updateSelection((draft) => {
        const target = draft.intents[0]!;
        target.status = 'cancelled'; delete target.bookKey;
        draft.queue = [];
      });
      ctx.coordinator.onTaskTerminal(task);
      const after = ctx.lib.selection();
      expect(after.intents[0]!.status).toBe('cancelled');
      expect(after.intents[0]!.bookKey).toBe(intent.bookKey);
      expect(after.intents[0]!.failure?.message).toContain('已入架，已取消后续排队');
      expect(after.queue).toHaveLength(0);
      expect(ctx.lib.list()).toHaveLength(1);
    } finally { await close(ctx); }
  });

  it('does not release the self-selected gate when an ongoing serial is merely caught up', async () => {
    const ctx = setup();
    try {
      const bookUrl = 'https://serial.test/book/1/';
      const links: ChapterLink[] = [1, 2].map((order) => ({ id: `c${order}`, title: `第${order}章`, url: `${bookUrl}${order}/` }));
      const catalogValue: SourceCatalog = { adapter: 'controlled-serial-v1', bookUrl, title: '受控连载', author: '测试作者',
        declaredTotal: links.length, chapters: links, publicationStatus: 'ongoing', fetchedAt: new Date().toISOString(), hash: '', complete: true, pageCount: 1 };
      catalogValue.hash = serialCatalogHash(catalogValue);
      const serial: SerialRecord = { serialId: randomUUID(), editionEpoch: 1, contentVersion: 1, subscriptionRevision: 1,
        sourceId: 'controlled-serial-v1', sourceBookId: 'book/1', bookUrl,
        capabilities: { catalog: true, chapterContent: true, stableChapterId: true, chapterRevision: false, publicationStatus: true, cancellation: true, conditionalRequest: false, rateLimit: 'observed' },
        authorization: 'unknown', authorizationNote: '受控原创源', publicationEvidence: { status: 'ongoing', source: 'fixture', observedAt: new Date().toISOString(), note: '' },
        subscription: { enabled: true, intervalMinutes: 60, nextCheckAt: null, lastAttemptAt: null, lastSuccessfulCheckAt: null, failures: 0, backoffUntil: null },
        receipts: [], layout: [], lastCheck: null };
      const body = (index: number): CachedChapter => { const text = '海风把灯吹灭。'.repeat(1500); return { index, text, hash: digest(text),
        fetchedAt: new Date().toISOString(), pages: [{ url: `${bookUrl}${index + 1}/`, hash: digest('page-' + index) }] }; };
      const created = ctx.lib.createSerial({ catalog: catalogValue, serial, chapters: [body(0), body(1)] }, ctx.lib.generation());
      const key = created.book.key; ctx.lib.select(key);
      const total = ctx.lib.status().current!.totalSegments;
      for (let i = 0; i < total; i++) {
        const task = ctx.lib.readNext();
        if (task.complete) break;
        ctx.lib.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: '连载样本确认' });
      }
      const current = ctx.lib.status().current!;
      expect(current.readiness).toBe('caught_up');
      expect(current.complete).toBe(false);
      const now = Date.now();
      ctx.lib.updateSelection((draft) => {
        draft.intents = [{ id: randomUUID(), createdAt: now, updatedAt: now, title: '受控连载', author: '测试作者',
          reason: '读到追平', status: 'reading', origin: 'autonomous', candidates: [], bookKey: key, queueOnImport: true }];
        draft.queue = [{ id: randomUUID(), intentId: draft.intents[0]!.id, bookKey: key, title: '受控连载', source: 'pet',
          status: 'active', addedAt: now, updatedAt: now }];
      });
      expect(ctx.coordinator.gate().code).toBe('self_selected_unfinished');
      expect(ctx.coordinator.summary().commitment?.readiness).toBe('caught_up');
      expect(ctx.coordinator.summary().commitment?.complete).toBe(false);
    } finally { await close(ctx); }
  });
});
