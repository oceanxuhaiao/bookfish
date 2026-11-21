import {
  compareVersions,
  loadHelpCatalog,
  readGuide,
  releaseFor,
  releaseSummaries,
  type FeatureChange,
  type HelpCatalog,
  type HelpCategory,
  type ProgressItem,
  type ReleaseRecord,
} from './help-content.ts';
import { HelpStore, type AnnouncementView } from './help-store.ts';

export type ReleaseSummary = Pick<ReleaseRecord, 'version' | 'releaseDate' | 'type' | 'majorAnnouncement' | 'title' | 'summary'> & { isNew: boolean };

export interface ChangedFeatureView {
  featureId: string;
  summary?: string;
  snippets: string[];
}

export interface HelpIndexView {
  currentVersion: string;
  updatedAt: string;
  features: HelpCategory[];
  latest: ReleaseSummary | null;
  history: ReleaseSummary[];
  progressUpdatedAt: string;
  unread: boolean;
  /** Version the user had read before opening this help session. */
  lastReadVersion: string;
  changedFeatures: ChangedFeatureView[];
  announcement?: AnnouncementView;
  warning?: string;
}

export interface HelpGuideView {
  id: string;
  title: string;
  summary: string;
  markdown: string;
  experimental: boolean;
  changed?: { summary?: string; snippets: string[] };
}

export interface HelpReleaseView extends ReleaseRecord {
  isCurrent: boolean;
  isNew: boolean;
}

export interface HelpProgressView {
  updatedAt: string;
  items: ProgressItem[];
  warning?: string;
}

export interface HelpCenterOptions {
  dataDir: string;
  currentVersion: string;
  root?: string;
  now?: () => Date;
  file?: string;
}

/**
 * Server-side adapter for the help center. It owns only static display content
 * and install-level UI state; it never reaches a model, a tool, the library or
 * Persona Memory.
 */
export class HelpCenter {
  private catalog: HelpCatalog | undefined;
  private store: HelpStore | undefined;
  private contentError: string | undefined;
  private changeBaseline: string | undefined;

  constructor(private readonly options: HelpCenterOptions) {}

  open(): void {
    try {
      this.catalog = loadHelpCatalog({ ...(this.options.root ? { root: this.options.root } : {}) });
      if (this.catalog.currentVersion !== this.options.currentVersion) throw new Error(`Help content is for ${this.catalog.currentVersion}, package is ${this.options.currentVersion}`);
      this.store = new HelpStore({ dataDir: this.options.dataDir, currentVersion: this.options.currentVersion, releases: this.catalog.releases, ...(this.options.file ? { file: this.options.file } : {}), ...(this.options.now ? { now: this.options.now } : {}) });
      this.store.open();
      this.store.evaluate();
    } catch (error) {
      this.catalog = undefined;
      this.store = undefined;
      this.contentError = String(error).replace(/^Error:\s*/u, '');
    }
  }

  private requireCatalog(): HelpCatalog {
    if (!this.catalog) throw new Error(this.contentError ?? '帮助内容暂时无法加载');
    return this.catalog;
  }

  private get currentRelease(): ReleaseRecord {
    return releaseFor(this.requireCatalog(), this.options.currentVersion);
  }

  private baseline(): string {
    if (this.changeBaseline === undefined) this.changeBaseline = this.store?.snapshot().lastReadVersion ?? this.options.currentVersion;
    return this.changeBaseline;
  }

  private changesSince(): FeatureChange[] {
    const catalog = this.requireCatalog();
    const baseline = this.baseline();
    const merged = new Map<string, FeatureChange>();
    for (const release of catalog.releases) {
      if (compareVersions(release.version, baseline) <= 0) continue;
      if (compareVersions(release.version, this.options.currentVersion) > 0) continue;
      for (const change of release.featureChanges ?? []) {
        const previous = merged.get(change.featureId);
        merged.set(change.featureId, {
          featureId: change.featureId,
          ...(change.summary ?? previous?.summary ? { summary: change.summary ?? previous?.summary } : {}),
          snippets: [...(previous?.snippets ?? []), ...change.snippets],
        });
      }
    }
    return [...merged.values()];
  }

  index(claimAnnouncement = false): HelpIndexView {
    let catalog: HelpCatalog;
    try {
      catalog = this.requireCatalog();
    } catch (error) {
      return {
        currentVersion: this.options.currentVersion,
        updatedAt: '',
        features: [],
        latest: null,
        history: [],
        progressUpdatedAt: '',
        unread: false,
        lastReadVersion: this.options.currentVersion,
        changedFeatures: [],
        warning: String(error).replace(/^Error:\s*/u, ''),
      };
    }
    const latest = this.currentRelease;
    const baseline = this.baseline();
    const all = releaseSummaries(catalog).map((entry) => ({ ...entry, isNew: compareVersions(entry.version, baseline) > 0 }));
    const history = all.filter((entry) => entry.version !== latest.version);
    const state = this.store?.snapshot();
    const announcement = claimAnnouncement ? this.store?.claim() : undefined;
    return {
      currentVersion: this.options.currentVersion,
      updatedAt: catalog.updatedAt,
      features: catalog.categories
        .map((category) => ({ ...category, features: category.features.filter((feature) => feature.enabled && (!feature.minVersion || compareVersions(feature.minVersion, this.options.currentVersion) <= 0)) }))
        .filter((category) => category.features.length > 0),
      latest: { version: latest.version, releaseDate: latest.releaseDate, type: latest.type, majorAnnouncement: latest.majorAnnouncement, title: latest.title, summary: latest.summary, isNew: compareVersions(latest.version, baseline) > 0 },
      history,
      progressUpdatedAt: catalog.progress.updatedAt,
      unread: this.store?.unread() ?? false,
      lastReadVersion: baseline,
      changedFeatures: this.changesSince(),
      ...(announcement ? { announcement } : {}),
      ...(state?.error ? { warning: state.error } : {}),
    };
  }

  guide(id: string): HelpGuideView {
    const catalog = this.requireCatalog();
    const guide = readGuide(catalog, id);
    const change = this.changesSince().find((entry) => entry.featureId === id);
    return {
      id: guide.feature.id, title: guide.feature.title, summary: guide.feature.summary, markdown: guide.markdown, experimental: guide.feature.experimental === true,
      ...(change ? { changed: { ...(change.summary ? { summary: change.summary } : {}), snippets: change.snippets } } : {}),
    };
  }

  release(version?: string): HelpReleaseView {
    const catalog = this.requireCatalog();
    const record = releaseFor(catalog, version);
    return { ...record, isCurrent: record.version === this.options.currentVersion, isNew: compareVersions(record.version, this.baseline()) > 0 };
  }

  progress(): HelpProgressView {
    const catalog = this.requireCatalog();
    const state = this.store?.snapshot();
    return { updatedAt: catalog.progress.updatedAt, items: catalog.progress.items, ...(state?.error ? { warning: state.error } : {}) };
  }

  mark(announcementId: string, action: 'viewed' | 'dismissed'): { ok: boolean; unread: boolean; warning?: string } {
    this.requireCatalog();
    let ok = false;
    try {
      ok = this.store?.mark(announcementId, action) ?? false;
    } catch (error) {
      return { ok: false, unread: this.store?.unread() ?? false, warning: String(error) };
    }
    return { ok, unread: this.store?.unread() ?? false, ...(ok ? {} : { warning: this.store?.snapshot().error ?? '更新状态未能保存' }) };
  }

  markHelpOpened(): { ok: boolean; unread: boolean; warning?: string } {
    const ok = this.store?.markHelpOpened() ?? false;
    return { ok, unread: this.store?.unread() ?? false, ...(ok ? {} : { warning: this.store?.snapshot().error ?? '更新状态未能保存' }) };
  }

  markUpdatesViewed(): { ok: boolean; unread: boolean; warning?: string } {
    this.requireCatalog();
    this.store?.discardPending();
    const ok = this.store?.markUpdatesViewed() ?? false;
    return { ok, unread: this.store?.unread() ?? false, ...(ok ? {} : { warning: this.store?.snapshot().error ?? '更新状态未能保存' }) };
  }

  unread(): boolean {
    return this.store?.unread() ?? false;
  }

}
