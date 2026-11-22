import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WriterLock } from '../src/writer-lock.ts';
import { HistoryStore } from '../src/history.ts';
import { StoryStore } from '../src/story/store.ts';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { buildBook, MAX_BOOK_BYTES, SEGMENT_CHARS, digest } from '../src/books.ts';
let dir: string;
let now: number;
let stores: Library[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-library-')); now = 1000000; stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
function open(dataDir = dir) { const store = new Library({ dataDir, now: () => now }); stores.push(store); store.open(); return store; }
function input(text = '第一章 海风\n\n' + '海'.repeat(1600) + '\n\n第二章 归来\n' + '归'.repeat(1600), title = '测试短篇') {
  return { filename: 'sample.md', title, author: '测试', base64: Buffer.from(text).toString('base64') };
}
function prepare(store: Library, text?: string) { const b = store.import(input(text)).book; store.select(b.key); return b; }
function task(store: Library) { const t = store.readNext(); if (t.complete) throw new Error('expected unread range'); return t; }
function finish(store: Library, t = task(store)) { return store.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '本段描述海边与归途。' }); }

describe('book import and stable segmentation', () => {
  it('preserves all canonical Unicode characters and chapter boundaries in bounded contiguous ranges', () => {
    const text = '# 起点\r\n\r\n' + '🐟海'.repeat(1500) + '\r\n\r\n第二章 归来\r\n结束。';
    const book = buildBook('book.md', '书', '', Buffer.from(text));
    expect(book.segments.map(s => s.text).join('')).toBe(book.text);
    expect(book.totalChars).toBe(Array.from(book.text).length);
    expect(book.segments.some(s => s.chapter === '第二章 归来')).toBe(true);
    let end = 0;
    for (const s of book.segments) { expect(s.start).toBe(end); expect(s.end - s.start).toBe(Array.from(s.text).length); expect(s.end - s.start).toBeLessThanOrEqual(SEGMENT_CHARS); end = s.end; }
    expect(book.segments.some(s => /[\uD800-\uDBFF]$/.test(s.text))).toBe(false);
  });
  it('rejects invalid encoding, binary, empty, oversized files and path-shaped filenames', () => {
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('a\0b'), Buffer.from('  \n '), Buffer.alloc(MAX_BOOK_BYTES + 1, 65)]) {
      expect(() => buildBook('x.txt', '书', '', bytes)).toThrow();
    }
    for (const name of ['../a.txt', 'C:\\a.md', 'a.azw3']) expect(() => buildBook(name, '书', '', Buffer.from('书'))).toThrow();
    // EPUB/PDF are converted to text before import, so the original file names are kept.
    expect(buildBook('a.epub', '书', '', Buffer.from('书')).filename).toBe('a.epub');
    expect(buildBook('a.pdf', '书', '', Buffer.from('书')).filename).toBe('a.pdf');
  });
  it('recognizes chapter names without spaces and fills segments instead of offering headings alone', () => {
    const book = buildBook('chapter.txt', '章', '', Buffer.from('第一章海风\n' + '海'.repeat(2000)));
    expect(book.segments[0].chapter).toBe('第一章海风');
    expect(Array.from(book.segments[0].text).length).toBe(SEGMENT_CHARS);
  });
  it('deduplicates canonical content without losing progress and isolates a changed revision', () => {
    const store = open(); const b = prepare(store); finish(store);
    expect(store.import(input()).duplicate).toBe(true);
    const changed = store.import(input('全新正文')).book;
    expect(changed.id).toBe(b.id); expect(changed.revision).not.toBe(b.revision);
    expect(changed.confirmedChars).toBe(0);
    expect(store.list().find(x => x.key === b.key)!.confirmedSegments).toBe(1);
  });
  it('rejects malformed base64 and cannot import by arbitrary filesystem path', () => {
    const store = open();
    expect(() => store.import({ ...input(), base64: 'not valid***' })).toThrow();
    expect(() => store.import({ path: 'C:\\Windows\\secret.txt' })).toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe('confirmed reading protocol', () => {
  it('fetching reuses a single lease and advances provided text only; identical confirmation is idempotent', () => {
    const store = open(); prepare(store); const first = task(store);
    expect(task(store).taskId).toBe(first.taskId);
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(store.status().providedChars).toBeGreaterThan(0);
    const result = finish(store, first);
    expect(result.duplicate).toBe(false);
    expect(finish(store, first)).toEqual({ duplicate: true, receipt: result.receipt });
    expect(store.status().current!.confirmedSegments).toBe(1);
    expect(() => store.finish({ ...result.receipt, understanding: '不同的提交' })).toThrow();
  });
  it('rejects invented task ids, revision or segment mismatches', () => {
    const store = open(); const b = prepare(store); const t = task(store);
    const valid = { taskId: t.taskId, bookKey: b.key, segmentId: t.segmentId, understanding: '理解' };
    for (const patch of [{ taskId: 'invented' }, { bookKey: 'other' }, { segmentId: 1 }, { understanding: 'x'.repeat(601) }]) expect(() => store.finish({ ...valid, ...patch })).toThrow();
    expect(store.status().current!.confirmedSegments).toBe(0);
  });
  it('accepts an empty understanding as the legal "nothing to note" result', () => {
    const store = open(); prepare(store); const t = task(store);
    const receipt = store.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '' });
    expect(receipt.duplicate).toBe(false);
    expect(receipt.receipt.understanding).toBe('');
    expect(store.timeline().items[0].summary).toBe('');
    expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('rejects expired tasks and offers the same range under a fresh task', () => {
    const store = open(); prepare(store); const t = task(store);
    now = t.expiresAt;
    expect(() => finish(store, t)).toThrow(/expired/);
    const next = task(store); expect(next.taskId).not.toBe(t.taskId); expect(next.segmentId).toBe(0);
    finish(store, next); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('pause and resume invalidate old tasks but preserve committed progress', () => {
    const store = open(); prepare(store); finish(store); const t = task(store);
    store.setPaused(true); expect(() => task(store)).toThrow(/paused/);
    store.setPaused(false); expect(() => finish(store, t)).toThrow();
    expect(task(store).segmentId).toBe(1);
  });
  it('switching books cancels the pending task and switching back resumes confirmed progress', () => {
    const store = open(); const a = prepare(store); finish(store); const old = task(store);
    const b = store.import(input('另一本书', '另一本')).book; store.select(b.key);
    expect(() => finish(store, old)).toThrow(); store.select(a.key);
    expect(task(store).segmentId).toBe(1);
  });
  it('switching to a changed revision rejects the former version task', () => {
    const store = open(); const original = prepare(store); const old = task(store);
    const updated = store.import(input('替换的内容')).book; store.select(updated.key);
    expect(() => finish(store, old)).toThrow();
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(store.list().find(b => b.key === original.key)!.confirmedChars).toBe(0);
  });
  it('rereads confirmed text without advancing and refuses unread text', () => {
    const store = open(); const b = prepare(store);
    expect(() => store.reread(b.key, 0)).toThrow(); finish(store);
    expect(store.reread(b.key, 0).segment.id).toBe(0);
    expect(store.status().current!.confirmedSegments).toBe(1);
    expect(() => store.reread(b.key, 1)).toThrow();
  });
  it('reaches completion only after every contiguous segment has a confirmation', () => {
    const store = open(); prepare(store);
    while (!store.status().current!.complete) finish(store);
    expect(store.status().current!.progress).toBe(1);
    expect(store.status().current!.confirmedChars).toBe(store.status().current!.totalChars);
    expect(store.readNext().complete).toBe(true);
  });
});

describe('persistence, recovery and failure', () => {
  it('restart resumes the last confirmation, cancels pending work and preserves committed retry receipts', () => {
    const store = open(); const b = prepare(store); const committed = task(store); finish(store, committed); const pending = task(store);
    store.close(); const restored = open();
    expect(restored.status().current!.key).toBe(b.key);
    expect(() => finish(restored, pending)).toThrow();
    expect(finish(restored, committed).duplicate).toBe(true);
    expect(task(restored).segmentId).toBe(1);
  });
  it('a stop blocks confirmation until remount and remount invalidates the task', () => {
    const store = open(); prepare(store); const t = task(store); store.close();
    expect(() => finish(store, t)).toThrow(/not mounted/); store.open();
    expect(() => finish(store, t)).toThrow();
  });
  it('rejects a second writer without interfering with the first writer', () => {
    const store = open(); prepare(store);
    const second = new Library({ dataDir: dir }); stores.push(second);
    expect(() => second.open()).toThrow(/already open/);
    finish(store); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('failed writes leave both in-memory progress and previous disk state unchanged', () => {
    let fail = false;
    const store = new Library({ dataDir: dir, now: () => now, write: (file, state) => {
      if (fail) throw new Error('disk full'); writeFileSync(file, JSON.stringify(state));
    } }); stores.push(store); store.open(); prepare(store); const t = task(store);
    const before = readFileSync(store.file, 'utf8'); fail = true;
    expect(() => finish(store, t)).toThrow('disk full');
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    fail = false; finish(store, t); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('corrupt persisted state is kept intact and the writer lock is released', () => {
    const store = open(); prepare(store); store.close(); writeFileSync(store.file, '{broken');
    const next = new Library({ dataDir: dir }); stores.push(next);
    expect(() => next.open()).toThrow();
    expect(readFileSync(store.file, 'utf8')).toBe('{broken');
    expect(existsSync(join(store.dir, 'writer.lock'))).toBe(false);
  });
  it('ignores an interrupted temporary write and recovers the last committed file', () => {
    const store = open(); prepare(store); finish(store); const pending = task(store); store.close();
    writeFileSync(`${store.file}.interrupted.tmp`, '{partial');
    const recovered = open();
    expect(recovered.status().current!.confirmedSegments).toBe(1);
    expect(() => finish(recovered, pending)).toThrow();
    expect(task(recovered).segmentId).toBe(1);
  });
  it('rejects a damaged body index even when a backup checksum has been recomputed', () => {
    const store = open(); prepare(store); const backup = JSON.parse(store.export());
    const state = JSON.parse(backup.payload); state.books[0].book.segments[0].text = '替换的文本';
    const payload = JSON.stringify(state);
    const target = open(join(dir, 'index-target'));
    expect(() => target.restore(JSON.stringify({ ...backup, payload, checksum: digest(payload) }))).toThrow(/inconsistent/);
    expect(target.list()).toEqual([]);
  });
  it('exports and restores exact confirmed content into an empty library while cancelling pending tasks', () => {
    const store = open(); const b = prepare(store); finish(store); const pending = task(store); const backup = store.export();
    const recovered = open(join(dir, 'restored'));
    expect(recovered.restore(backup).restoredBooks).toBe(1);
    expect(recovered.status().current!.confirmedSegments).toBe(1);
    expect(recovered.reread(b.key, 0).segment.text).toBe(store.reread(b.key, 0).segment.text);
    expect(() => finish(recovered, pending)).toThrow();
    expect(() => recovered.restore(backup)).toThrow(/empty library/);
  });
  it('rejects checksum damage, inconsistent indexes and forged progress without changing live state', () => {
    const store = open(); prepare(store); const backup = JSON.parse(store.export());
    const target = open(join(dir, 'target'));
    expect(() => target.restore(JSON.stringify({ ...backup, checksum: 'bad' }))).toThrow();
    const content = JSON.parse(backup.payload); content.books[0].frontier = 1;
    const payload = JSON.stringify(content);
    expect(() => target.restore(JSON.stringify({ ...backup, payload, checksum: digest(payload) }))).toThrow(/continuous/);
    expect(target.list()).toEqual([]);
  });
  it('removal and bulk clearing invalidate tasks and cannot remove other books accidentally', () => {
    const store = open(); const a = prepare(store); const t = task(store);
    const b = store.import(input('另一本', '另一书')).book;
    store.remove(a.key); expect(() => finish(store, t)).toThrow();
    expect(store.list().map(x => x.key)).toEqual([b.key]);
    expect(store.status().current).toBe(null);
    store.clear(); expect(store.list()).toEqual([]);
    store.close(); store.open(); expect(store.list()).toEqual([]);
  });
});

// Real OS processes and independent SQLite connections; no PID inspector mocks in these cases.
describe('writer lock across processes', () => {
  const children: ChildProcess[] = [];
  const evidence: unknown[] = [];
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }));
  });
  afterAll(() => {
    if (process.env.BOOKFISH_LOCK_EVIDENCE) writeFileSync(process.env.BOOKFISH_LOCK_EVIDENCE, JSON.stringify({ platform: process.platform, node: process.version, evidence }, null, 2));
  });
  function message(child: ChildProcess, type: string | string[]) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}; pid=${child.pid}`)); }, 18000);
      const receive = (value: any) => { if ((Array.isArray(type) ? type : [type]).includes(value.type)) { cleanup(); evidence.push(value); resolve(value); } };
      const ended = () => { cleanup(); reject(new Error('Child exited before result')); };
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', ended); };
      child.on('message', receive); child.on('exit', ended);
    });
  }
  async function child(mode = 'library') {
    const worker = fork(fileURLToPath(new URL('./fixtures/writer-lock-child.ts', import.meta.url)), [dir, mode], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(worker); await message(worker, 'ready'); return worker;
  }
  async function acquire(worker: ChildProcess) { const result = message(worker, ['acquired', 'denied']); worker.send('acquire'); return result; }
  async function close(worker: ChildProcess) { const exited = once(worker, 'exit'); const result = message(worker, 'closed'); worker.send('close'); await result; await exited; }
  it('excludes a second process and permits acquisition after normal close', async () => {
    const first = await child(), second = await child();
    expect((await acquire(first)).type).toBe('acquired');
    expect(await acquire(second)).toMatchObject({ type: 'denied', error: expect.stringContaining('另一个书库写入者') });
    await close(first); expect((await acquire(second)).type).toBe('acquired'); await close(second);
  });
  it('recovers automatically after forcibly terminating a real lock owner', async () => {
    const first = await child(); const held = await acquire(first); expect(held.type).toBe('acquired');
    const exited = once(first, 'exit'); first.kill('SIGKILL'); const termination = await exited;
    evidence.push({ scenario: 'forced-termination', ownerPid: first.pid, termination });
    expect(existsSync(join(dir, 'bookfish', 'writer.lock'))).toBe(true);
    const second = await child(); expect((await acquire(second)).type).toBe('acquired'); await close(second);
  });
  it('recovers a legacy lock whose PID now identifies a later unrelated real process', async () => {
    const owner = await child('legacy'); expect((await acquire(owner)).type).toBe('acquired');
    const file = join(dir, 'bookfish', 'writer.lock'); const old = JSON.parse(readFileSync(file, 'utf8'));
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    // Deterministic reconstruction of OS PID reuse: preserve the old lock but substitute an actual new PID.
    // Moving both timestamps back avoids the conservative 2-second filesystem precision boundary.
    const unrelated = await child('idle'); const identity = (await acquire(unrelated)).identity;
    writeFileSync(file, JSON.stringify({ ...old, pid: unrelated.pid }));
    const oldTime = new Date(identity.process.startedAtMs - 10000); utimesSync(file, oldTime, oldTime);
    const staleMtime = statSync(file).mtimeMs;
    const contender = await child(); const recovered = await acquire(contender);
    evidence.push({ scenario: 'legacy-pid-reuse-reconstruction', oldOwnerPid: owner.pid, substitutedPid: unrelated.pid, actualIdentity: identity, lockMtime: staleMtime, recovered });
    expect(recovered.type).toBe('acquired'); await close(contender); await close(unrelated);
  });
  it('refuses takeover while a real legacy JSON writer is alive', async () => {
    const legacy = await child('legacy'); expect((await acquire(legacy)).type).toBe('acquired');
    const next = await child(); expect(await acquire(next)).toMatchObject({ type: 'denied', error: expect.stringContaining('禁止接管') });
    await close(legacy); expect((await acquire(next)).type).toBe('acquired'); await close(next);
  });
  it('lets exactly one of two simultaneous processes acquire the library', async () => {
    const workers = await Promise.all([child(), child()]);
    const results = await Promise.all(workers.map(acquire));
    expect(results.map(x => x.type).sort()).toEqual(['acquired', 'denied']);
    await Promise.all(workers.map(close));
  });
});

describe('writer lock migration and cleanup failures', () => {
  function lockDir() { const path = join(dir, 'bookfish'); mkdirSync(path, { recursive: true }); return path; }
  it('uses exact creation identity to recover a reused PID even without trusting file time', () => {
    const path = lockDir(); writeFileSync(join(path, 'writer.lock'), JSON.stringify({ pid: process.pid, token: 'old-token', processIdentity: 'prior-process-identity' }));
    const store = open(); expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(path, 'writer.lock'), 'utf8')).processIdentity).not.toBe('prior-process-identity');
  });
  it('preserves malformed JSON and rejects migration without guessing ownership', () => {
    const path = lockDir(); writeFileSync(join(path, 'writer.lock'), '{invalid');
    expect(() => open()).toThrow(/JSON.*无法确认/); expect(readFileSync(join(path, 'writer.lock'), 'utf8')).toBe('{invalid');
    unlinkSync(join(path, 'writer.lock')); open();
  });
  it('conservatively refuses permission and process-information failures with recovery instructions', () => {
    const path = lockDir(); const file = join(path, 'writer.lock'); writeFileSync(file, JSON.stringify({ pid: 1234, token: 'legacy' }));
    for (const reason of ['当前账户无权查询进程创建时间', '系统进程信息查询失败或超时']) {
      const lock = new WriterLock(path, { inspect: () => ({ kind: 'unknown', reason }) });
      expect(() => lock.acquire()).toThrow(new RegExp(`PID 1234.*锁文件`));
      try { lock.acquire(); } catch (error) { expect(String(error)).toContain(reason); expect(String(error)).toContain('任务管理器'); expect(String(error)).not.toContain('EPERM'); }
      lock.release();
    }
    unlinkSync(file); open();
  });
  it('closes both database stores on an initialization failure and can reopen them', () => {
    const next = new Library({ dataDir: dir, storyMemoryEnabled: true, beforeMetadataCommit: () => { throw new Error('injected init failure'); } }); stores.push(next);
    const history = vi.spyOn(HistoryStore.prototype, 'close'); const story = vi.spyOn(StoryStore.prototype, 'close');
    try {
      expect(() => next.open()).toThrow('injected init failure'); expect(history).toHaveBeenCalled(); expect(story).toHaveBeenCalled();
      expect(existsSync(join(next.dir, 'writer.lock'))).toBe(false);
      const restored = new Library({ dataDir: dir, storyMemoryEnabled: true }); stores.push(restored); restored.open(); expect(restored.list()).toEqual([]);
    } finally { history.mockRestore(); story.mockRestore(); }
  });
  it('keeps exclusion through business closes and removes marker before rollback and connection close', () => {
    const store = new Library({ dataDir: dir, storyMemoryEnabled: true }); stores.push(store); store.open();
    const order: string[] = []; const originalHistory = HistoryStore.prototype.close, originalStory = StoryStore.prototype.close;
    const attempt = () => { const other = new WriterLock(store.dir); expect(() => other.acquire()).toThrow(/already open/); };
    const history = vi.spyOn(HistoryStore.prototype, 'close').mockImplementation(function(this: HistoryStore) { attempt(); expect(existsSync(join(store.dir, 'writer.lock'))).toBe(true); order.push('history'); originalHistory.call(this); });
    const story = vi.spyOn(StoryStore.prototype, 'close').mockImplementation(function(this: StoryStore) { attempt(); order.push('story'); originalStory.call(this); });
    const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql === 'ROLLBACK') { expect(order).toEqual(['history', 'story']); expect(existsSync(join(store.dir, 'writer.lock'))).toBe(false); attempt(); order.push('rollback'); }
      return originalExec.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: InstanceType<typeof DatabaseSync>) { if (order.at(-1) === 'rollback') order.push('lock-close'); return originalClose.call(this); });
    try { store.close(); expect(order).toEqual(['history', 'story', 'rollback', 'lock-close']); }
    finally { history.mockRestore(); story.mockRestore(); exec.mockRestore(); close.mockRestore(); }
    store.close(); open();
  });
  it('attempts every business close and retains the writer lock until failed closes are retried', () => {
    const store = new Library({ dataDir: dir, storyMemoryEnabled: true }); stores.push(store); store.open();
    const history = vi.spyOn(HistoryStore.prototype, 'close').mockImplementationOnce(() => { throw new Error('busy history'); });
    const story = vi.spyOn(StoryStore.prototype, 'close');
    try { expect(() => store.close()).toThrow(/写锁仍保留/); expect(story).toHaveBeenCalled(); expect(() => open()).toThrow(/already open/); }
    finally { history.mockRestore(); story.mockRestore(); }
    store.close(); store.close(); open();
  });
  it('does not delete a replacement compatibility marker and still releases SQLite after business cleanup', () => {
    const store = open(); const file = join(store.dir, 'writer.lock');
    const marker = JSON.parse(readFileSync(file, 'utf8')); marker.token = 'replacement'; writeFileSync(file, JSON.stringify(marker));
    expect(() => store.close()).toThrow(/兼容标记/); expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('replacement');
    open();
  });
  it('closes SQLite even if rollback fails and allows a clean reacquisition', () => {
    const store = open(); const original = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: InstanceType<typeof DatabaseSync>, sql: string) { if (sql === 'ROLLBACK') throw new Error('injected rollback failure'); return original.call(this, sql); });
    try { expect(() => store.close()).toThrow(/回滚失败/); } finally { exec.mockRestore(); }
    store.close(); open();
  });
});

import { inspectProcess } from '../src/process-identity.ts';
describe('OS process identity failures', () => {
  it('converts EPERM, missing creation data and query failure into conservative identity results', () => {
    if (process.platform !== 'win32') return;
    const query = vi.fn();
    try {
      query.mockImplementationOnce(() => { throw Object.assign(new Error('raw EPERM details'), { code: 'EPERM' }); });
      expect(inspectProcess(1234, query)).toEqual({ kind: 'unknown', reason: '当前账户无权查询进程创建时间' });
      query.mockImplementationOnce(() => 'unparseable');
      expect(inspectProcess(1234, query)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('未返回') });
      query.mockImplementationOnce(() => { throw new Error('CIM unavailable'); });
      expect(inspectProcess(1234, query)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('查询失败') });
      query.mockImplementationOnce(() => 'absent');
      expect(inspectProcess(1234, query)).toEqual({ kind: 'absent' });
    } finally { query.mockReset(); }
  });
});
import { BookfishWorld } from '../src/world.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { FakeHost } from './helpers/fake-host.ts';

describe('World writer lifetime', () => {
  function world() { return new BookfishWorld({ cfg: { ...BOOKFISH_DEFAULTS, automaticReading: false, realRoutineEnabled: false }, timezone: 'Asia/Shanghai', dataDir: dir }); }
  it('serializes overlapping start/stop and makes repeated stop safe after another instance takes over', async () => {
    const first = world(), second = world();
    await Promise.all([first.start(new FakeHost()), first.stop()]);
    await second.start(new FakeHost());
    const snapshot = readFileSync(join(dir, 'bookfish', 'serial-jobs.json'), 'utf8');
    await Promise.all([first.stop(), first.stop()]);
    expect(readFileSync(join(dir, 'bookfish', 'serial-jobs.json'), 'utf8')).toBe(snapshot);
    await second.stop();
  });
  it('closes the library on startup event failure and can mount a different instance', async () => {
    const first = world(), host = new FakeHost(); host.pushEvent = async () => { throw new Error('event storage failed'); };
    await expect(first.start(host)).rejects.toThrow('event storage failed');
    const second = world(); await second.start(new FakeHost()); await first.stop(); await second.stop();
  });
  it('continues stopping resources after a failure and retains exclusion until retry completes', async () => {
    const first = world(); await first.start(new FakeHost());
    const internal = first as unknown as { transfers: { shutdown(): Promise<void> }; runtime: { stop(): Promise<void> } };
    const runtime = vi.spyOn(internal.runtime, 'stop').mockRejectedValueOnce(new Error('runtime busy'));
    const transfers = vi.spyOn(internal.transfers, 'shutdown');
    try {
      await expect(first.stop()).rejects.toThrow(/写锁仍保留/); expect(transfers).toHaveBeenCalled();
      await expect(first.start(new FakeHost())).rejects.toThrow(/上次停止尚未完成/);
      expect(() => open()).toThrow(/already open/);
    } finally { runtime.mockRestore(); transfers.mockRestore(); await first.stop(); }
    const second = world(); await second.start(new FakeHost()); await second.stop();
  });
});


it('releases temporary SQLite connections when acquisition or self-identification fails', () => {
  const path = join(dir, 'bookfish'); mkdirSync(path, { recursive: true });
  const first = new WriterLock(path); first.acquire();
  const close = vi.spyOn(DatabaseSync.prototype, 'close');
  try {
    const contender = new WriterLock(path); expect(() => contender.acquire()).toThrow(/already open/);
    expect(close).toHaveBeenCalledTimes(1); contender.release();
  } finally { close.mockRestore(); first.release(); }
  const failed = new WriterLock(path, { self: () => { throw new Error('injected query crash'); } });
  expect(() => failed.acquire()).toThrow(/创建或迁移兼容标记失败/); failed.release();
  const unavailable = new WriterLock(path, { self: () => ({ kind: 'unknown', reason: '进程查询失败' }) });
  unavailable.acquire(); expect(() => new WriterLock(path).acquire()).toThrow(/already open/); unavailable.release();
  const recovered = new WriterLock(path); recovered.acquire(); recovered.release();
});

it('rejects ambiguous old timestamps even if the current process might be an unrelated reused PID', () => {
  const path = join(dir, 'bookfish'); mkdirSync(path, { recursive: true }); const file = join(path, 'writer.lock');
  writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'legacy' })); const time = statSync(file).mtimeMs;
  const lock = new WriterLock(path, { inspect: () => ({ kind: 'running', process: { identity: 'new-process', startedAtMs: time + 1000 } }) });
  expect(() => lock.acquire()).toThrow(/时间误差范围/); expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('legacy');
});
