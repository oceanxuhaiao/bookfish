import type { ReadingEpisode } from './journal.ts';
import type { BookEntry } from './library.ts';

/** Page sizes the footprint browser offers. The server rejects anything else. */
export const BROWSE_LIMITS = [5, 10, 20, 50] as const;
export type BrowseOrder = 'asc' | 'desc';
export type BrowseLimit = (typeof BROWSE_LIMITS)[number];
export type BrowseEdge = 'before' | 'after';

export interface BrowseCursor { edge: BrowseEdge; sequence: number }
export interface BrowseQuery {
  bookKey: string | null; order: BrowseOrder; limit: BrowseLimit;
  cursor: BrowseCursor | null; anchor: number | null; terms: string[];
}
export interface BrowseItem {
  id: string; sequence: number; recordedAt: string; kind: ReadingEpisode['kind']; revises: string | null;
  trigger: string; interpretation: string; mood: ReadingEpisode['content']['mood'];
  chapters: string[]; segmentIds: number[];
  bookKey: string; bookTitle: string; bookAuthor: string; bookRevision: string;
}
export interface BrowsePage {
  scope: { bookKey: string | null };
  order: BrowseOrder; limit: BrowseLimit;
  query: string[];
  total: number;
  position: { start: number; end: number };
  page: { count: number; firstSequence: number | null; lastSequence: number | null };
  headSequence: number | null; tailSequence: number | null;
  hasPrev: boolean; hasNext: boolean;
  prevCursor: BrowseCursor | null; nextCursor: BrowseCursor | null;
  items: BrowseItem[];
}
export interface BrowseBooks {
  total: number;
  books: Array<{ bookKey: string; id: string; revision: string; title: string; author: string; count: number; lastSequence: number }>;
}
export interface BrowseProbe { total: number; headSequence: number | null; tailSequence: number | null; count: number }
export interface BrowseNew { count: number; maxSequence: number | null; items: BrowseItem[]; truncated: boolean }

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return record(value, field);
}
function sequence(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${field} must be an integer of at least ${minimum}`);
  return value as number;
}
function scopeOf(value: unknown): string | null {
  if (value === undefined || value === null || value === 'all') return null;
  if (typeof value === 'string') {
    if (value === 'all') return null;
    throw new Error('scope must be "all" or {bookKey}');
  }
  const scope = record(value, 'scope');
  const bookKey = scope.bookKey;
  if (typeof bookKey !== 'string' || !bookKey || bookKey.length > 150) throw new Error('scope.bookKey must be a non-empty book key');
  return bookKey;
}
function limitOf(value: unknown): BrowseLimit {
  if (value === undefined) return 10;
  if (!BROWSE_LIMITS.includes(value as BrowseLimit)) throw new Error(`limit must be one of ${BROWSE_LIMITS.join(', ')}`);
  return value as BrowseLimit;
}
function orderOf(value: unknown): BrowseOrder {
  if (value === undefined) return 'desc';
  if (value !== 'desc' && value !== 'asc') throw new Error('order must be "desc" or "asc"');
  return value;
}
/** Keyword terms for the footprint filter: NFKC, whitespace separated, at most 8 words of 40 chars. */
export function queryTerms(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') throw new Error('query must be a string');
  const text = value.trim();
  if (!text) return [];
  if (Array.from(text).length > 200) throw new Error('query must be at most 200 characters');
  const terms = text.normalize('NFKC').split(/\s+/u).filter(Boolean);
  if (terms.length > 8) throw new Error('Use at most eight search keywords');
  for (const term of terms) if (Array.from(term).length > 40) throw new Error('Each search keyword must be at most 40 characters');
  return terms;
}
/** The author-visible footprint text that the keyword filter searches. Evidence quotes are excluded. */
export function footprintText(episode: ReadingEpisode): string {
  const content = episode.content;
  return [
    content.trigger, content.interpretation, content.priorJudgment ?? '', content.reason ?? '',
    content.mood?.label ?? '', ...content.characters.map((character) => [character.name, ...character.aliases].join(' ')),
    ...content.questions,
  ].join('\n');
}
export function footprintMatches(episode: ReadingEpisode, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const haystack = footprintText(episode).normalize('NFKC').toLocaleLowerCase('en-US');
  return terms.every((term) => haystack.includes(term.toLocaleLowerCase('en-US')));
}

export function parseBrowseQuery(raw: unknown): BrowseQuery {
  const input = raw === undefined || raw === null ? {} : record(raw, 'journal browse');
  const bookKey = scopeOf(input.scope);
  const cursorInput = optionalObject(input.cursor, 'cursor');
  const anchorInput = input.anchorSequence;
  if (cursorInput && anchorInput !== undefined && anchorInput !== null) throw new Error('cursor and anchorSequence are mutually exclusive');
  let cursor: BrowseCursor | null = null;
  if (cursorInput) {
    const edge = cursorInput.edge;
    if (edge !== 'before' && edge !== 'after') throw new Error('cursor.edge must be "before" or "after"');
    cursor = { edge, sequence: sequence(cursorInput.sequence, 'cursor.sequence', 1) };
  }
  const anchor = anchorInput === undefined || anchorInput === null ? null : sequence(anchorInput, 'anchorSequence', 1);
  return { bookKey, order: orderOf(input.order), limit: limitOf(input.limit), cursor, anchor, terms: queryTerms(input.query) };
}

/** Filter and SQL direction for one page. The cursor edge is independent of display order.
 *  An `anchorSequence` is normally resolved by Library into an aligned `upTo`/`downTo` window;
 *  the anchor branch here is only the fallback when that record's page cannot be aligned. */
export function browseWindow(query: BrowseQuery): {
  filter: { bookKey?: string; before?: number; after?: number; upTo?: number; downTo?: number };
  queryOrder: BrowseOrder;
} {
  const filter: { bookKey?: string; before?: number; after?: number; upTo?: number; downTo?: number } = {};
  if (query.bookKey) filter.bookKey = query.bookKey;
  if (query.cursor) {
    filter[query.cursor.edge] = query.cursor.sequence;
    return { filter, queryOrder: query.cursor.edge === 'before' ? 'desc' : 'asc' };
  }
  if (query.anchor !== null) {
    if (query.order === 'desc') filter.upTo = query.anchor; else filter.downTo = query.anchor;
    return { filter, queryOrder: query.order };
  }
  return { filter, queryOrder: query.order };
}

export function browseItem(episode: ReadingEpisode, entry: BookEntry): BrowseItem {
  const chapters: string[] = [];
  const segmentIds: number[] = [];
  for (const evidence of episode.content.evidence) {
    const segment = entry.book.segments[evidence.segmentId];
    if (!segment) continue;
    if (!chapters.includes(segment.chapter)) chapters.push(segment.chapter);
    if (!segmentIds.includes(evidence.segmentId)) segmentIds.push(evidence.segmentId);
  }
  return {
    id: episode.id, sequence: episode.sequence, recordedAt: episode.recordedAt, kind: episode.kind,
    revises: episode.revises ?? null, trigger: episode.content.trigger, interpretation: episode.content.interpretation,
    mood: episode.content.mood, chapters, segmentIds,
    bookKey: episode.bookKey, bookTitle: entry.book.title, bookAuthor: entry.book.author, bookRevision: entry.book.revision,
  };
}

export function parseProbeQuery(raw: unknown): { bookKey: string | null; since: number | null } {
  const input = raw === undefined || raw === null ? {} : record(raw, 'journal probe');
  const since = input.since === undefined || input.since === null ? null : sequence(input.since, 'since', 0);
  return { bookKey: scopeOf(input.scope), since };
}

export function parseNewQuery(raw: unknown): { bookKey: string | null; since: number; order: BrowseOrder; limit: BrowseLimit } {
  const input = record(raw, 'journal new');
  if (input.since === undefined || input.since === null) throw new Error('since is required');
  return { bookKey: scopeOf(input.scope), since: sequence(input.since, 'since', 0), order: orderOf(input.order), limit: limitOf(input.limit) };
}
