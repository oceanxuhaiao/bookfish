import type { ReadingScheduler } from './scheduler.ts';
import type { Library } from './library.ts';
import type { ReadingSharing } from './sharing.ts';
import type { NovelFetches } from './novel-fetch.ts';
import type { SerialSync } from './serial-sync.ts';
import type { SelectionCoordinator } from './selection.ts';
export interface BookfishStatus {
  lifecycle: 'stopped' | 'running';
  stage: 'full-book-review';
  readingAvailable: boolean;
  automaticReadingAvailable: boolean;
  scheduler: ReturnType<ReadingScheduler['status']>;
  cognition: 'not-mounted' | 'available' | 'unavailable';
  selectedMode: 'unavailable' | 'background' | 'main';
  output: 'persona-mediated';
  sharing: ReturnType<ReadingSharing['status']>;
  reviewError: string | null;
  networkEnabled: boolean;
  library: ReturnType<Library['status']>;
  novelFetch: ReturnType<NovelFetches['status']>;
  serial: ReturnType<SerialSync['status']>;
  selection: ReturnType<SelectionCoordinator['compact']>;
  /** Compact projection: the model never needs the whole ordered plan. */
  plan: PlanSummary;
  txtAcquisition: ReturnType<import('./txt-acquisition/index.ts').TxtAcquisition['summary']>;
}
export interface PlanSummary { enabled: boolean; revision: number; total: number; completed: number;
  current: { position: number; title: string; complete: boolean } | null;
  next: { position: number; title: string } | null;
  seriesCount: number;
  /** Books waiting with a deferral still in the future. */
  deferred: number;
  /** Plan entries whose revision is gone from the shelf; they never advance. */
  missing: number;
}
export interface LibraryPanelState { discussions: ReturnType<import('./discussions.ts').Discussions['list']>; config: import('./config.ts').BookfishConfigSection; status: BookfishStatus; books: ReturnType<Library['list']>; journal: ReturnType<Library['journal']> | null; reviews: ReturnType<Library['reviews']> | null; novel: ReturnType<NovelFetches['status']>; serial: ReturnType<SerialSync['status']>; selection: ReturnType<SelectionCoordinator['view']>; plan: ReturnType<Library['planView']> | null; importBatches: ReturnType<Library['importBatches']> }
