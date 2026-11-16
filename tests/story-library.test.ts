import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Library } from '../src/library.ts';
import { StoryStore } from '../src/story/store.ts';

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-story-lib-'));
  dirs.push(dir);
  return dir;
}
function change(summary: string, segmentId: number) {
  return { kind: 'event', summary, evidenceSegmentIds: [segmentId], sourceKind: 'model_interpretation' };
}
function storeChange(summary: string, segmentId: number) {
  return { kind: 'event', summary, evidence: [{ segmentId }], sourceKind: 'model_interpretation' };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Library story sidecar lifecycle', () => {
  it('captures through the book revision and survives close/open', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    const imported = lib.importBytes({ filename: 'a.txt', title: '故事测试' }, Buffer.from('第一章\n' + '正文。'.repeat(200))) as { book: { key: string } };
    lib.select(imported.book.key);
    const task = lib.readNext();
    lib.finish({ ...task, understanding: '' });
    const first = lib.captureStory({ bookKey: imported.book.key, requestId: 'capture-1', changes: [change('事件一', 0)] });
    expect(first.records).toHaveLength(1);
    expect(first.records[0].bookRevision).toBe(lib.list().find(book => book.key === imported.book.key)!.revision);
    expect(lib.storyStatus()).toMatchObject({ enabled: true, records: 1 });

    const duplicate = lib.captureStory({ bookKey: imported.book.key, requestId: 'capture-1', changes: [change('事件一', 0)] });
    expect(duplicate.duplicate).toBe(true);
    expect(lib.storyStatus().records).toBe(1);
    lib.close();

    const reopened = new Library({ dataDir: dir, storyMemoryEnabled: true });
    reopened.open();
    expect(reopened.storyStatus()).toMatchObject({ enabled: true, records: 1 });
    reopened.close();
  });

  it('deletes only the removed book story records', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    const a = lib.importBytes({ filename: 'a.txt', title: '甲书' }, Buffer.from('第一章\n' + '正文。'.repeat(50))) as { book: { key: string } };
    const b = lib.importBytes({ filename: 'b.txt', title: '乙书' }, Buffer.from('第一章\n' + '正文。'.repeat(50))) as { book: { key: string } };
    lib.select(a.book.key); let task = lib.readNext(); lib.finish({ ...task, understanding: '' });
    lib.captureStory({ bookKey: a.book.key, requestId: 'a-1', changes: [change('甲事件', 0)] });
    lib.select(b.book.key); task = lib.readNext(); lib.finish({ ...task, understanding: '' });
    lib.captureStory({ bookKey: b.book.key, requestId: 'b-1', changes: [change('乙事件', 0)] });
    expect(lib.storyStatus().records).toBe(2);
    lib.remove(a.book.key);
    expect(lib.storyStatus().records).toBe(1);
    lib.close();
  });

  it('is disabled by default and does not create the sidecar', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir });
    lib.open();
    expect(lib.storyStatus()).toEqual({ enabled: false, error: null });
    expect(() => lib.captureStory({ bookKey: 'x', requestId: 'r', changes: [] })).toThrow(/disabled/);
    lib.close();
  });

  it('writes and restores BOOKFISH5 with story memory', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    const imported = lib.importBytes({ filename: 'a.txt', title: '备份故事' }, Buffer.from('第一章\n' + '正文。'.repeat(50))) as { book: { key: string } };
    lib.select(imported.book.key);
    const task = lib.readNext();
    lib.finish({ ...task, understanding: '' });
    const captured = lib.captureStory({ bookKey: imported.book.key, requestId: 'backup-1', changes: [change('备份事件', 0)] });
    lib.putStoryPack({ id: 'arc-backup', bookKey: imported.book.key, level: 'book', summary: '备份弧', eventIds: [captured.records[0].id], relationIds: [], coveredRanges: [{ from: 0, to: 1 }] });
    lib.publishStoryPack('arc-backup');
    const archive = join(dir, 'story.bfbak');
    lib.writeArchive(archive);
    expect(readFileSync(archive).subarray(0, 10).toString()).toBe('BOOKFISH5\n');
    lib.close();

    const restored = new Library({ dataDir: join(dir, 'restored'), storyMemoryEnabled: true });
    restored.open();
    restored.restoreArchive(archive);
    expect(restored.storyStatus()).toMatchObject({ enabled: true, records: 1 });
    expect(restored.listStoryPacks(imported.book.key).map(pack => pack.summary)).toEqual(['备份弧']);
    const records = restored.captureStory({ bookKey: imported.book.key, requestId: 'backup-1', changes: [change('备份事件', 0)] });
    expect(records.duplicate).toBe(true);
    restored.close();
  });

  it('clears stale story records when restoring an older BOOKFISH3 archive', () => {
    const dir = tempDir();
    const old = new Library({ dataDir: join(dir, 'old') });
    old.open();
    const imported = old.importBytes({ filename: 'a.txt', title: '旧备份' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    old.select(imported.book.key);
    const task = old.readNext();
    old.finish({ ...task, understanding: '' });
    const archive = join(dir, 'old.bfbak');
    old.writeArchive(archive);
    expect(readFileSync(archive).subarray(0, 10).toString()).toBe('BOOKFISH3\n');
    old.close();

    const target = new Library({ dataDir: join(dir, 'target'), storyMemoryEnabled: true });
    target.open();
    target.close();
    const sidecar = new StoryStore(join(target.dir, 'story.sqlite'));
    sidecar.open();
    sidecar.capture({ bookKey: 'orphan:book', bookRevision: 'rev', contentVersion: null, frontier: 1, requestId: 'orphan-1', changes: [storeChange('孤立事件', 0)] });
    sidecar.close();
    target.open();
    expect(target.storyStatus()).toMatchObject({ enabled: true, records: 1 });
    target.restoreArchive(archive);
    expect(target.storyStatus()).toMatchObject({ enabled: true, records: 0 });
    target.close();
  });

  it('rolls back to an empty library when a restore stage is injected to fail', () => {
    const dir = tempDir();
    const source = new Library({ dataDir: join(dir, 'source'), storyMemoryEnabled: true });
    source.open();
    const imported = source.importBytes({ filename: 'a.txt', title: '故障注入' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    source.select(imported.book.key);
    const task = source.readNext();
    source.finish({ ...task, understanding: '' });
    source.captureStory({ bookKey: imported.book.key, requestId: 'fault-1', changes: [change('故障事件', 0)] });
    const archive = join(dir, 'fault.bfbak');
    source.writeArchive(archive);
    source.close();

    for (const stage of ['before-books', 'after-books', 'before-history', 'after-history', 'before-story', 'after-story', 'before-commit'] as const) {
      const target = new Library({ dataDir: join(dir, `target-${stage}`), storyMemoryEnabled: true });
      target.open();
      expect(() => target.restoreArchive(archive, { onStage: value => { if (value === stage) throw new Error(`inject:${stage}`); } })).toThrow(new RegExp(`inject:${stage}`));
      expect(target.list()).toHaveLength(0);
      expect(target.storyStatus()).toMatchObject({ enabled: true, records: 0 });
      target.close();
    }

    const badHistory = new Library({ dataDir: join(dir, 'bad-history'), storyMemoryEnabled: true });
    badHistory.open();
    expect(() => badHistory.restoreArchive(archive, { validateHistory: () => { throw new Error('inject:history-preflight'); } })).toThrow(/history-preflight/);
    expect(badHistory.list()).toHaveLength(0);
    badHistory.close();

    const badStory = new Library({ dataDir: join(dir, 'bad-story'), storyMemoryEnabled: true });
    badStory.open();
    expect(() => badStory.restoreArchive(archive, { validateStory: () => { throw new Error('inject:story-preflight'); } })).toThrow(/story-preflight/);
    expect(badStory.list()).toHaveLength(0);
    badStory.close();

    const afterCommit = new Library({ dataDir: join(dir, 'after-commit'), storyMemoryEnabled: true });
    afterCommit.open();
    afterCommit.restoreArchive(archive, { onStage: value => { if (value === 'after-commit') throw new Error('after-commit must be observational'); } });
    expect(afterCommit.list()).toHaveLength(1);
    expect(afterCommit.storyStatus()).toMatchObject({ enabled: true, records: 1 });
    afterCommit.close();
  });

  it('cleans story records for a removed book even when the sidecar is disabled', () => {
    const dir = tempDir();
    const first = new Library({ dataDir: dir, storyMemoryEnabled: true });
    first.open();
    const imported = first.importBytes({ filename: 'a.txt', title: '关闭后清理' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    first.select(imported.book.key);
    const task = first.readNext();
    first.finish({ ...task, understanding: '' });
    first.captureStory({ bookKey: imported.book.key, requestId: 'disabled-1', changes: [change('需清理', 0)] });
    first.close();

    const disabled = new Library({ dataDir: dir });
    disabled.open();
    disabled.remove(imported.book.key);
    disabled.close();

    const sidecar = new StoryStore(join(dir, 'bookfish', 'story.sqlite'));
    sidecar.open();
    expect(sidecar.list(imported.book.key)).toHaveLength(0);
    sidecar.close();
  });

  it('writes a persistent cleanup tombstone when the sidecar cannot be opened and retries after recovery', () => {
    const dir = tempDir();
    const first = new Library({ dataDir: dir, storyMemoryEnabled: true });
    first.open();
    const imported = first.importBytes({ filename: 'a.txt', title: '清理重试' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    first.select(imported.book.key);
    const task = first.readNext();
    first.finish({ ...task, understanding: '' });
    first.captureStory({ bookKey: imported.book.key, requestId: 'retry-1', changes: [change('待重试', 0)] });
    first.close();

    const storyPath = join(dir, 'bookfish', 'story.sqlite');
    const backupPath = join(dir, 'bookfish', 'story.sqlite.bak');
    renameSync(storyPath, backupPath);
    mkdirSync(storyPath);

    const disabled = new Library({ dataDir: dir });
    disabled.open();
    const removed = disabled.remove(imported.book.key) as { removed: boolean; storyCleanupError?: string };
    expect(removed.removed).toBe(true);
    expect(removed.storyCleanupError).toBeTruthy();
    expect(existsSync(join(dir, 'bookfish', 'story-cleanup.json'))).toBe(true);
    rmSync(storyPath, { recursive: true, force: true });
    renameSync(backupPath, storyPath);
    const retried = disabled.retryStoryCleanups();
    expect(retried.pending).toBe(0);
    disabled.close();

    const sidecar = new StoryStore(storyPath);
    sidecar.open();
    expect(sidecar.list(imported.book.key)).toHaveLength(0);
    sidecar.close();
  });

  it('fails closed on a corrupt cleanup tombstone instead of treating it as empty', () => {
    const dir = tempDir();
    const cleanup = join(dir, 'bookfish', 'story-cleanup.json');
    mkdirSync(join(dir, 'bookfish'), { recursive: true });
    writeFileSync(cleanup, '{not-json');
    const lib = new Library({ dataDir: dir });
    lib.open();
    expect(lib.storyStatus().pendingCleanups).toBeGreaterThanOrEqual(1);
    const result = lib.retryStoryCleanups() as { error?: string; pending: number };
    expect(result.error).toContain('corrupt');
    expect(result.pending).toBeGreaterThanOrEqual(1);
    expect(existsSync(cleanup)).toBe(true);
    lib.close();
  });

  it('cleans orphan story records left by an interrupted restore on startup', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bookfish'), { recursive: true });
    const sidecar = new StoryStore(join(dir, 'bookfish', 'story.sqlite'));
    sidecar.open();
    sidecar.capture({ bookKey: 'orphan:book', bookRevision: 'rev', contentVersion: null, frontier: 1, requestId: 'orphan-startup', changes: [storeChange('孤立', 0)] });
    sidecar.close();
    writeFileSync(join(dir, 'bookfish', 'restore-in-progress.json'), '{}');
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    expect(lib.storyStatus().records).toBe(0);
    expect(existsSync(join(dir, 'bookfish', 'restore-in-progress.json'))).toBe(false);
    lib.close();
  });

  it('keeps valid committed data when a real child process dies after commit with the marker present', () => {
    const dir = tempDir();
    const source = new Library({ dataDir: join(dir, 'source'), storyMemoryEnabled: true });
    source.open();
    const imported = source.importBytes({ filename: 'a.txt', title: '子进程终止' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    source.select(imported.book.key);
    const task = source.readNext();
    source.finish({ ...task, understanding: '' });
    source.captureStory({ bookKey: imported.book.key, requestId: 'kill-1', changes: [change('已提交事件', 0)] });
    const archive = join(dir, 'kill.bfbak');
    source.writeArchive(archive);
    source.close();

    const targetDir = join(dir, 'target');
    const child = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'kill-restore.ts'), targetDir, archive], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(23);
    expect(existsSync(join(targetDir, 'bookfish', 'restore-in-progress.json'))).toBe(true);

    const reopened = new Library({ dataDir: targetDir, storyMemoryEnabled: true });
    reopened.open();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.storyStatus()).toMatchObject({ enabled: true, records: 1 });
    reopened.close();
    reopened.open();
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
    expect(existsSync(join(targetDir, 'bookfish', 'restore-in-progress.json'))).toBe(false);
  });

  it('keeps committed data across a forced SIGKILL after commit', () => {
    const dir = tempDir();
    const source = new Library({ dataDir: join(dir, 'source'), storyMemoryEnabled: true });
    source.open();
    const imported = source.importBytes({ filename: 'a.txt', title: '强制终止' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    source.select(imported.book.key);
    const task = source.readNext();
    source.finish({ ...task, understanding: '' });
    source.captureStory({ bookKey: imported.book.key, requestId: 'sigkill-1', changes: [change('已提交事件', 0)] });
    const archive = join(dir, 'sigkill.bfbak');
    source.writeArchive(archive);
    source.close();
    const targetDir = join(dir, 'target');
    const child = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'kill-restore.ts'), targetDir, archive], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, KILL_STAGE: 'after-commit', KILL_MODE: 'signal' },
    });
    expect(child.status, child.stderr).not.toBe(0);
    const reopened = new Library({ dataDir: targetDir, storyMemoryEnabled: true });
    reopened.open();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.storyStatus().records).toBe(1);
    reopened.close();
  });

  it('does not expose a partial restore after a forced SIGKILL before history commit', () => {
    const dir = tempDir();
    const source = new Library({ dataDir: join(dir, 'source'), storyMemoryEnabled: true });
    source.open();
    const imported = source.importBytes({ filename: 'a.txt', title: '提交前终止' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    source.select(imported.book.key);
    const task = source.readNext();
    source.finish({ ...task, understanding: '' });
    source.captureStory({ bookKey: imported.book.key, requestId: 'sigkill-before', changes: [change('未提交事件', 0)] });
    const archive = join(dir, 'before.bfbak');
    source.writeArchive(archive);
    source.close();
    const targetDir = join(dir, 'target');
    const child = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'kill-restore.ts'), targetDir, archive], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, KILL_STAGE: 'after-books', KILL_MODE: 'signal' },
    });
    expect(child.status, child.stderr).not.toBe(0);
    const reopened = new Library({ dataDir: targetDir, storyMemoryEnabled: true });
    reopened.open();
    expect(reopened.list()).toHaveLength(0);
    expect(reopened.storyStatus().records).toBe(0);
    reopened.close();
  });

  it('keeps committed data with a corrupt restore marker and only removes the marker', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    const imported = lib.importBytes({ filename: 'a.txt', title: '损坏标记' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    lib.select(imported.book.key);
    const task = lib.readNext();
    lib.finish({ ...task, understanding: '' });
    lib.captureStory({ bookKey: imported.book.key, requestId: 'corrupt-marker', changes: [change('保留事件', 0)] });
    lib.close();
    writeFileSync(join(dir, 'bookfish', 'restore-in-progress.json'), '{bad');
    const reopened = new Library({ dataDir: dir, storyMemoryEnabled: true });
    reopened.open();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.storyStatus().records).toBe(1);
    expect(existsSync(join(dir, 'bookfish', 'restore-in-progress.json'))).toBe(false);
    reopened.close();
  });

  it('blocks all story mutations while an archive snapshot is in progress and tracks changeSeq', () => {
    const dir = tempDir();
    let lib!: Library;
    const gateErrors: string[] = [];
    lib = new Library({ dataDir: dir, storyMemoryEnabled: true, onArchiveSnapshot: () => {
      for (const action of [
        () => lib.captureStory({ bookKey: 'any', requestId: 'gate', changes: [] }),
        () => lib.putStoryPack({ bookKey: 'any', level: 'arc', summary: 'x', eventIds: ['e'], coveredRanges: [{ from: 0, to: 1 }] }),
        () => lib.invalidateStoryPacks('any'),
      ]) {
        try { action(); } catch (error) { gateErrors.push(String(error)); }
      }
    } });
    lib.open();
    const imported = lib.importBytes({ filename: 'a.txt', title: '归档闸门' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    lib.select(imported.book.key);
    const task = lib.readNext();
    lib.finish({ ...task, understanding: '' });
    const captured = lib.captureStory({ bookKey: imported.book.key, requestId: 'gate-1', changes: [change('事件', 0)] });
    const before = lib.storyStatus().changeSeq;
    lib.putStoryPack({ id: 'gate-pack', bookKey: imported.book.key, level: 'arc', summary: '弧', eventIds: [captured.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    expect(lib.storyStatus().changeSeq).toBeGreaterThan(before!);
    lib.writeArchive(join(dir, 'gate.bfbak'));
    expect(gateErrors).toHaveLength(3);
    expect(gateErrors.every(error => /archived/.test(error))).toBe(true);
    lib.close();
  });

  it('exposes frontier-scoped overview/evidence and validates the persisted pack tree', () => {
    const dir = tempDir();
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    lib.open();
    const imported = lib.importBytes({ filename: 'a.txt', title: '检索' }, Buffer.from('第一章\n' + '正文。'.repeat(30))) as { book: { key: string } };
    lib.select(imported.book.key);
    const task = lib.readNext();
    lib.finish({ ...task, understanding: '' });
    const captured = lib.captureStory({ bookKey: imported.book.key, requestId: 'view-1', changes: [{ ...change('事件', 0), names: ['林'] }] });
    expect(lib.storyEntityCandidates(imported.book.key, '林').status).toBe('resolved');
    lib.putStoryPack({ id: 'arc-view', bookKey: imported.book.key, level: 'arc', parentId: 'book-view', summary: '弧', eventIds: [captured.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    expect(lib.validateStoryPacks(imported.book.key).ok).toBe(false);
    lib.putStoryPack({ id: 'book-view', bookKey: imported.book.key, level: 'book', summary: '全书骨架', childIds: ['arc-view'], eventIds: [captured.records[0].id], coveredRanges: [{ from: 0, to: 1 }] });
    lib.publishStoryPack('book-view');
    expect(lib.validateStoryPacks(imported.book.key).ok).toBe(true);

    const before = lib.storyOverview(imported.book.key, 0);
    expect(before.packs).toHaveLength(0);
    expect(before.hasFuturePacks).toBe(true);
    expect(lib.storyEvidence(imported.book.key, [captured.records[0].id], 0).events[0]).toMatchObject({ omitted: true, reason: 'unread-at-frontier' });
    const visible = lib.storyOverview(imported.book.key, 1);
    expect(visible.packs.map(pack => pack.id).sort()).toEqual(['arc-view', 'book-view']);
    const page = lib.storyOverview(imported.book.key, 1, 1);
    expect(page).toMatchObject({ total: 2, returned: 1, truncated: true });
    expect(page.nextCursor).toBeTruthy();
    expect(lib.storyOverview(imported.book.key, 1, 1, page.nextCursor!).returned).toBe(1);
    expect(() => lib.storyOverview(imported.book.key, 1, 1, '1')).toThrow(/cursor/);
    expect(lib.storyEvidence(imported.book.key, Array(9).fill(captured.records[0].id), 1)).toMatchObject({ requested: 9, returned: 8, truncated: true });
    expect(lib.storyEvidence(imported.book.key, [captured.records[0].id], 1).events[0]).toMatchObject({ summary: '事件' });
    const staleCursor = page.nextCursor!;
    lib.invalidateStoryPacks(imported.book.key);
    expect(() => lib.storyOverview(imported.book.key, 1, 1, staleCursor)).toThrow(/snapshot/);
    lib.close();
  });
});
