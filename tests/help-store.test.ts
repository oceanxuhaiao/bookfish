import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReleaseRecord } from '../src/help-content.ts';
import { HelpStore } from '../src/help-store.ts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-help-state-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function release(version: string, major = false, announcementId?: string): ReleaseRecord {
  return {
    version,
    releaseDate: '2026-11-21',
    type: major ? 'major' : 'minor',
    majorAnnouncement: major,
    ...(announcementId ? { announcementId } : {}),
    title: major ? '重要更新' : '普通更新',
    summary: '这次更新有一些变化。',
    items: [{ kind: 'note', text: '测试记录' }],
  };
}

function store(dir: string, version: string, releases: ReleaseRecord[], now = () => new Date('2026-11-21T12:00:00Z'), file?: string): HelpStore {
  return new HelpStore({ dataDir: dir, currentVersion: version, releases, now, ...(file ? { file } : {}) });
}

describe('help announcement state', () => {
  it('does not prompt on a first install, even when the current release is marked major', () => {
    const dir = tempDir();
    const first = store(dir, '1.0.0', [release('1.0.0', true, 'major-1.0.0')]);
    first.open();
    expect(first.evaluate()).toBeUndefined();
    expect(first.unread()).toBe(false);
    expect(existsSync(join(dir, 'bookfish', 'help-updates.json'))).toBe(true);
  });

  it('updates the seen version on a normal upgrade without a prompt', () => {
    const dir = tempDir();
    const first = store(dir, '1.0.0', [release('1.0.0')]);
    first.open(); first.evaluate();
    const next = store(dir, '1.1.0', [release('1.0.0'), release('1.1.0')]);
    next.open();
    expect(next.evaluate()).toBeUndefined();
    expect(next.snapshot().lastSeenInstalledVersion).toBe('1.1.0');
  });

  it('persists prompted before handing out a banner, then never prompts again', () => {
    const dir = tempDir();
    const first = store(dir, '1.0.0', [release('1.0.0')]);
    first.open(); first.evaluate();
    const next = store(dir, '1.1.0', [release('1.0.0'), release('1.1.0', true, 'major-1.1.0')]);
    next.open();
    const announcement = next.evaluate();
    expect(announcement).toMatchObject({ announcementId: 'major-1.1.0', version: '1.1.0' });
    expect(next.unread()).toBe(true);
    const persisted = JSON.parse(readFileSync(join(dir, 'bookfish', 'help-updates.json'), 'utf8')) as { announcements: Record<string, { prompted: boolean }> };
    expect(persisted.announcements['major-1.1.0']?.prompted).toBe(true);
    expect(next.claim()).toEqual(announcement);
    expect(next.claim()).toBeUndefined();
    const restarted = store(dir, '1.1.0', [release('1.0.0'), release('1.1.0', true, 'major-1.1.0')]);
    restarted.open();
    expect(restarted.evaluate()).toBeUndefined();
    expect(restarted.snapshot().announcements['major-1.1.0']?.prompted).toBe(true);
  });

  it('keeps an unread dot after dismissal until the user views the update', () => {
    const dir = tempDir();
    const first = store(dir, '1.0.0', [release('1.0.0')]); first.open(); first.evaluate();
    const current = store(dir, '1.1.0', [release('1.0.0'), release('1.1.0', true, 'major-1.1.0')]);
    current.open(); current.evaluate();
    expect(current.mark('major-1.1.0', 'dismissed')).toBe(true);
    expect(current.unread()).toBe(true);
    expect(current.mark('major-1.1.0', 'viewed')).toBe(true);
    expect(current.unread()).toBe(false);
  });

  it('prompts only for the newest applicable major when several versions were skipped', () => {
    const dir = tempDir();
    const first = store(dir, '1.0.0', [release('1.0.0')]); first.open(); first.evaluate();
    const releases = [release('1.0.0'), release('1.1.0', true, 'major-1.1.0'), release('1.2.0', true, 'major-1.2.0'), release('1.3.0')];
    const next = store(dir, '1.3.0', releases); next.open();
    expect(next.evaluate()?.announcementId).toBe('major-1.2.0');
  });

  it('does not prompt again after a downgrade and a later upgrade', () => {
    const dir = tempDir();
    const releases = [release('1.0.0'), release('1.1.0', true, 'major-1.1.0')];
    const first = store(dir, '1.0.0', releases); first.open(); first.evaluate();
    const upgraded = store(dir, '1.1.0', releases); upgraded.open(); expect(upgraded.evaluate()).toBeTruthy();
    const downgraded = store(dir, '1.0.0', releases); downgraded.open(); expect(downgraded.evaluate()).toBeUndefined();
    const again = store(dir, '1.1.0', releases); again.open(); expect(again.evaluate()).toBeUndefined();
  });

  it('preserves a corrupt state file and falls back conservatively', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bookfish'), { recursive: true });
    const file = join(dir, 'bookfish', 'help-updates.json');
    writeFileSync(file, '{not json', 'utf8');
    const current = store(dir, '1.1.0', [release('1.1.0', true, 'major-1.1.0')]);
    current.open();
    expect(current.evaluate()).toBeUndefined();
    expect(current.snapshot().fresh).toBe(true);
    expect(readdirSync(join(dir, 'bookfish')).some((name) => name.startsWith('help-updates.json.corrupt-'))).toBe(true);
  });

  it('does not prompt when the state cannot be written', () => {
    const dir = tempDir();
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked, { recursive: true });
    // Point at a directory: reading and atomic replacement both fail.
    mkdirSync(join(blocked, 'state.json'), { recursive: true });
    const current = store(dir, '1.1.0', [release('1.1.0', true, 'major-1.1.0')], () => new Date('2026-11-21T12:00:00Z'), join(blocked, 'state.json'));
    current.open();
    expect(current.evaluate()).toBeUndefined();
    expect(current.snapshot().error).toBeTruthy();
  });
});
