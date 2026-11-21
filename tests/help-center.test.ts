import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpCenter } from '../src/help-center.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-help-center-'));
  dirs.push(dir);
  return dir;
}

describe('help center data plane', () => {
  it('serves the packaged catalog and guide without touching a model', () => {
    const dir = tempDir();
    const center = new HelpCenter({ dataDir: dir, currentVersion: '0.65.1', now: () => new Date('2026-11-21T12:00:00Z') });
    center.open();
    const index = center.index(false);
    expect(index.currentVersion).toBe('0.65.1');
    expect(index.features).toHaveLength(7);
    expect(index.latest?.version).toBe('0.65.1');
    expect(index.history.length).toBeGreaterThan(2);
    expect(index.announcement).toBeUndefined();
    expect(index.warning).toBeUndefined();
    expect(JSON.stringify(index)).not.toContain('怎么使用');
    const guide = center.guide('autonomous-reading');
    expect(guide.title).toBe('自主阅读');
    expect(guide.markdown).toContain('怎么使用');
    expect(center.release('0.63.1').title).toBe('书库写锁修复');
    expect(center.progress().items.some((item) => item.id === 'help-update-center')).toBe(true);
  });

  it('shows one persisted major announcement only when the version moved forward', () => {
    const dir = tempDir();
    const root = tempDir();
    mkdirSync(join(root, 'guides'), { recursive: true });
    writeFileSync(join(root, 'features.json'), JSON.stringify({
      schema: 1, updatedAt: '2026-11-21',
      categories: [{ id: 'start', title: '开始', summary: '开始使用', icon: '📖', features: [{ id: 'first', title: '第一项', summary: '一项', icon: '·', contentPath: 'guides/first.md', minVersion: null, enabled: true }] }],
    }), 'utf8');
    writeFileSync(join(root, 'progress.json'), JSON.stringify({ schema: 1, updatedAt: '2026-11-21', items: [] }), 'utf8');
    writeFileSync(join(root, 'guides', 'first.md'), '# 第一项\n\n内容。\n', 'utf8');
    writeFileSync(join(root, 'releases.json'), JSON.stringify({
      schema: 1, updatedAt: '2026-11-21', currentVersion: '1.1.0',
      releases: [
        { version: '1.0.0', releaseDate: '2026-11-20', type: 'minor', majorAnnouncement: false, title: '上一版', summary: '说明', items: [{ kind: 'note', text: '记录' }] },
        { version: '1.1.0', releaseDate: '2026-11-21', type: 'major', majorAnnouncement: true, announcementId: 'major-1.1.0', title: '重要更新', summary: '值得看看', items: [{ kind: 'feature', text: '新功能' }] },
      ],
    }), 'utf8');
    mkdirSync(join(dir, 'bookfish'), { recursive: true });
    writeFileSync(join(dir, 'bookfish', 'help-updates.json'), JSON.stringify({ schema: 1, lastSeenInstalledVersion: '1.0.0', announcements: {}, updatedAt: '2026-11-20T12:00:00Z' }), 'utf8');
    const first = new HelpCenter({ dataDir: dir, currentVersion: '1.1.0', root, now: () => new Date('2026-11-21T12:00:00Z') });
    first.open();
    const index = first.index(true);
    expect(index.announcement).toMatchObject({ announcementId: 'major-1.1.0', title: '重要更新' });
    expect(index.unread).toBe(true);
    const restarted = new HelpCenter({ dataDir: dir, currentVersion: '1.1.0', root, now: () => new Date('2026-11-21T12:01:00Z') });
    restarted.open();
    expect(restarted.index(true).announcement).toBeUndefined();
    expect(restarted.index(false).unread).toBe(true);
    expect(restarted.mark('major-1.1.0', 'viewed').unread).toBe(false);
  });

  it('points at changed features and new release items since the last read version', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bookfish'), { recursive: true });
    writeFileSync(join(dir, 'bookfish', 'help-updates.json'), JSON.stringify({
      schema: 1, lastSeenInstalledVersion: '0.65.1', lastReadVersion: '0.64.3', announcements: {}, updatedAt: '2026-11-21T12:00:00Z',
    }), 'utf8');
    const center = new HelpCenter({ dataDir: dir, currentVersion: '0.65.1', now: () => new Date('2026-11-21T12:00:00Z') });
    center.open();
    const index = center.index(false);
    expect(index.latest?.isNew).toBe(true);
    expect(index.changedFeatures).toContainEqual(expect.objectContaining({ featureId: 'settings' }));
    const guide = center.guide('settings');
    expect(guide.changed?.snippets).toContain('配置项旁的「?」会直接打开对应说明，不会触发阅读、下载或保存。');
    expect(center.release().isNew).toBe(true);
    expect(center.markHelpOpened().ok).toBe(true);
    const refreshed = center.index(false);
    expect(refreshed.changedFeatures).toEqual([]);
    expect(refreshed.latest?.isNew).toBe(false);
  });

  it('returns a friendly fallback when the content package is missing', () => {
    const dir = tempDir();
    const center = new HelpCenter({ dataDir: dir, currentVersion: '0.65.1', root: join(dir, 'missing') });
    center.open();
    const index = center.index(false);
    expect(index.features).toEqual([]);
    expect(index.warning).toBeTruthy();
    expect(() => center.guide('autonomous-reading')).toThrow();
  });
});
