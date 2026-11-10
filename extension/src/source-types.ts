import type { SerialRecord } from './serial-types.ts';
export type SourceErrorCode = 'unsupported' | 'needs_login' | 'restricted' | 'missing' | 'temporary' | 'invalid_content' | 'limit' | 'cancelled';
export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) { super(message); this.name = 'SourceError'; }
}
/** `id`/`revision` are present only when a source actually exposes them; a URL is identity only when the adapter verified it is canonical. */
export interface ChapterLink { title: string; url: string; id?: string; revision?: string }
export interface SourceCatalog {
  adapter: string; bookUrl: string; title: string; author: string;
  declaredTotal: number; chapters: ChapterLink[]; fetchedAt: string; hash: string;
  publicationStatus: 'finished' | 'ongoing' | 'unknown';
  /** A serial catalog must say whether every source page was fetched. Legacy snapshots omit it. */
  complete?: boolean; pageCount?: number;
}
export interface CachedChapter {
  index: number; text: string; hash: string; fetchedAt: string;
  pages: Array<{ url: string; hash: string }>;
}
export interface RemoteSource {
  catalog: SourceCatalog; cache: CachedChapter[];
  /** Present only for a serial book; its stable key is independent of catalog growth. */
  serial?: SerialRecord;
  lastError?: { code: SourceErrorCode; message: string; at: string; chapterIndex: number };
}
export interface HtmlPage { url: string; html: string }
export type HtmlFetcher = (url: string, signal?: AbortSignal) => Promise<HtmlPage>;
