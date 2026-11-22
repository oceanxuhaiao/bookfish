import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareVersions, type ReleaseRecord } from './help-content.ts';

/**
 * Install-level UI metadata for the help center. It deliberately lives outside
 * library.json, history.sqlite and every reading/journal/Persona store: clearing
 * a shelf or rebuilding an index must never make an old announcement new again.
 */

export interface StoredAnnouncement {
  prompted: boolean;
  viewed: boolean;
  dismissed: boolean;
  promptedAt?: string;
  viewedAt?: string;
  dismissedAt?: string;
}

export interface HelpStateFile {
  schema: 1;
  lastSeenInstalledVersion: string;
  /** Last version whose update page the user opened; drives the small blue dot. */
  lastReadVersion: string;
  announcements: Record<string, StoredAnnouncement>;
  updatedAt: string;
}

export interface AnnouncementView {
  announcementId: string;
  version: string;
  releaseDate: string;
  title: string;
  summary: string;
}

export interface HelpStoreOptions {
  dataDir: string;
  currentVersion: string;
  releases: readonly ReleaseRecord[];
  now?: () => Date;
  file?: string;
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/u.test(value);
}

function defaultAnnouncement(): StoredAnnouncement {
  return { prompted: false, viewed: false, dismissed: false };
}

function atomicWrite(file: string, value: HelpStateFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    try {
      const directory = openSync(dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* directory fsync is best effort on Windows */ }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    if (existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* ignore */ } }
  }
}

export class HelpStore {
  readonly file: string;
  private readonly now: () => Date;
  private state: HelpStateFile | undefined;
  private pending: AnnouncementView | undefined;
  private fresh = false;
  private stateError: string | undefined;

  constructor(private readonly options: HelpStoreOptions) {
    this.file = options.file ?? join(options.dataDir, 'bookfish', 'help-updates.json');
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read or initialize the install-level state. A missing file is treated as a
   * first install, not as an identified upgrade: no historical announcement is
   * shown. A corrupt file is preserved beside the new one and treated the same
   * conservative way.
   */
  open(): void {
    this.pending = undefined;
    this.stateError = undefined;
    mkdirSync(dirname(this.file), { recursive: true });
    let raw: string | undefined;
    try {
      raw = existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined;
    } catch (error) {
      this.fresh = true;
      this.stateError = `Cannot read help state: ${String(error)}`;
      this.state = this.initialState();
      return;
    }
    if (raw === undefined) {
      this.fresh = true;
      this.state = this.initialState();
      this.persist();
      return;
    }
    try {
      this.state = this.parse(raw);
      this.fresh = false;
    } catch (error) {
      this.fresh = true;
      this.stateError = `Help state was invalid: ${String(error)}`;
      try { renameSync(this.file, `${this.file}.corrupt-${this.now().getTime()}`); } catch { /* keep the original readable */ }
      this.state = this.initialState();
      this.persist();
    }
  }

  private initialState(): HelpStateFile {
    return { schema: 1, lastSeenInstalledVersion: this.options.currentVersion, lastReadVersion: this.options.currentVersion, announcements: {}, updatedAt: this.now().toISOString() };
  }

  private parse(raw: string): HelpStateFile {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) throw new Error('unsupported state schema');
    const lastSeenInstalledVersion = validVersion(value.lastSeenInstalledVersion) ? value.lastSeenInstalledVersion : this.options.currentVersion;
    const announcements: Record<string, StoredAnnouncement> = {};
    if (value.announcements !== undefined) {
      if (!value.announcements || typeof value.announcements !== 'object' || Array.isArray(value.announcements)) throw new Error('announcements must be an object');
      for (const [id, entry] of Object.entries(value.announcements as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`announcement ${id} must be an object`);
        const item = entry as Record<string, unknown>;
        announcements[id] = {
          prompted: item.prompted === true,
          viewed: item.viewed === true,
          dismissed: item.dismissed === true,
          ...(typeof item.promptedAt === 'string' ? { promptedAt: item.promptedAt } : {}),
          ...(typeof item.viewedAt === 'string' ? { viewedAt: item.viewedAt } : {}),
          ...(typeof item.dismissedAt === 'string' ? { dismissedAt: item.dismissedAt } : {}),
        };
      }
    }
    const lastReadVersion = validVersion(value.lastReadVersion) ? value.lastReadVersion : lastSeenInstalledVersion;
    return { schema: 1, lastSeenInstalledVersion, lastReadVersion, announcements, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : this.now().toISOString() };
  }

  private persist(): boolean {
    if (!this.state) return false;
    this.state.updatedAt = this.now().toISOString();
    try {
      atomicWrite(this.file, this.state);
      return true;
    } catch (error) {
      this.stateError = `Cannot write help state: ${String(error)}`;
      return false;
    }
  }

  /**
   * Decide whether this mount may show one major announcement. `prompted` is
   * persisted before the caller can render anything. If that write fails, no
   * prompt is produced: a possible repeat is worse than a missing one.
   */
  evaluate(): AnnouncementView | undefined {
    this.pending = undefined;
    if (!this.state || this.stateError && this.fresh) return undefined;
    const previous = this.state.lastSeenInstalledVersion;
    const current = this.options.currentVersion;
    if (compareVersions(current, previous) <= 0) return undefined;

    const major = this.options.releases
      .filter((release) => release.majorAnnouncement && release.announcementId && compareVersions(release.version, previous) > 0 && compareVersions(release.version, current) <= 0)
      .sort((left, right) => compareVersions(right.version, left.version))[0];

    this.state.lastSeenInstalledVersion = current;
    if (!major) {
      this.persist();
      return undefined;
    }
    const id = major.announcementId!;
    const item = this.state.announcements[id] ?? defaultAnnouncement();
    this.state.announcements[id] = item;
    if (item.prompted) {
      this.persist();
      return undefined;
    }
    const before = { ...item };
    item.prompted = true;
    item.promptedAt = this.now().toISOString();
    if (!this.persist()) {
      this.state.announcements[id] = before;
      return undefined;
    }
    this.pending = this.view(major);
    return this.pending;
  }

  private view(release: ReleaseRecord): AnnouncementView {
    return { announcementId: release.announcementId!, version: release.version, releaseDate: release.releaseDate, title: release.title, summary: release.summary };
  }

  /** Hand the banner to the page once; a remount in the same process gets no repeat. */
  claim(): AnnouncementView | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  discardPending(): void {
    this.pending = undefined;
  }

  mark(announcementId: string, action: 'viewed' | 'dismissed'): boolean {
    if (!this.state) return false;
    const release = this.options.releases.find((entry) => entry.announcementId === announcementId);
    if (!release) throw new Error(`Unknown announcement: ${announcementId}`);
    const item = this.state.announcements[announcementId] ?? defaultAnnouncement();
    this.state.announcements[announcementId] = item;
    if (action === 'viewed') {
      item.viewed = true; item.viewedAt = this.now().toISOString();
      this.state.lastReadVersion = this.options.currentVersion;
    } else { item.dismissed = true; item.dismissedAt = this.now().toISOString(); }
    return this.persist();
  }

  /** Opening the updates page counts as seeing every announcement that applies here. */
  /** Opening the help tab itself counts as seeing the unread marker. */
  markHelpOpened(): boolean {
    if (!this.state) return false;
    this.state.lastReadVersion = this.options.currentVersion;
    return this.persist();
  }

  markUpdatesViewed(): boolean {
    if (!this.state) return false;
    this.state.lastReadVersion = this.options.currentVersion;
    for (const release of this.options.releases) {
      if (!release.majorAnnouncement || !release.announcementId) continue;
      if (compareVersions(release.version, this.options.currentVersion) > 0) continue;
      const item = this.state.announcements[release.announcementId] ?? defaultAnnouncement();
      this.state.announcements[release.announcementId] = item;
      if (!item.viewed) { item.viewed = true; item.viewedAt = this.now().toISOString(); }
    }
    return this.persist();
  }

  unread(): boolean {
    if (!this.state) return false;
    return compareVersions(this.options.currentVersion, this.state.lastReadVersion) > 0;
  }

  snapshot(): { lastSeenInstalledVersion: string; lastReadVersion: string; announcements: Record<string, StoredAnnouncement>; fresh: boolean; error?: string } {
    return {
      lastSeenInstalledVersion: this.state?.lastSeenInstalledVersion ?? this.options.currentVersion,
      lastReadVersion: this.state?.lastReadVersion ?? this.options.currentVersion,
      announcements: this.state ? structuredClone(this.state.announcements) : {},
      fresh: this.fresh,
      ...(this.stateError ? { error: this.stateError } : {}),
    };
  }
}
