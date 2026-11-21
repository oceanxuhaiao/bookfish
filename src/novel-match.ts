/**
 * Book identity matching, independent of any search engine's ordering.
 *
 * A title-only match is not enough: the earlier live test returned fan fiction,
 * same-title works by other authors, and two different editions of the same
 * public-domain novel. Bookfish therefore requires title equality plus a
 * non-ambiguous author, and never falls back to the first result.
 */

export interface NovelSearchCandidate {
  title: string;
  author: string;
  url: string;
  source: { id: number; name: string };
  revision: string;
  latestChapter: string;
  lastUpdateTime: string;
}

export type NovelMatchErrorCode = 'invalid_input' | 'no_title' | 'wrong_author' | 'ambiguous';

export class NovelMatchError extends Error {
  constructor(readonly code: NovelMatchErrorCode, message: string) {
    super(message);
    this.name = 'NovelMatchError';
  }
}

/** Presentation normalization preserves edition/translator parentheses. */
export function normalizeTitle(text: string): string {
  return text.normalize('NFKC')
    .replace(/^作者[:：]/u, '')
    .replace(/[\s《》「」『』"'“”‘’·•,，。.、:：;；!！?？\-—_/\\|]/gu, '')
    .toLowerCase()
    .trim();
}
/** Only enumerated bibliographic author aliases are accepted; no substring rule. */
const AUTHOR_ALIASES:Readonly<Record<string,string>>={'吴承恩(明)':'吴承恩','曹雪芹(清)':'曹雪芹'};
export function normalizeAuthor(text:string):string{const value=normalizeTitle(text);return AUTHOR_ALIASES[value]??value;}
/** Compatibility export; title call sites must use normalizeTitle explicitly. */
export const normalizeIdentity=normalizeAuthor;

/**
 * Exact title plus a non-ambiguous author. `candidate` may contain an author
 * suffix only through the explicit author-alias table; substring matches never count.
 * More than one surviving result is an error, not a coin flip.
 */
export function matchCandidate(results: NovelSearchCandidate[], wanted: { title: string; author: string }): NovelSearchCandidate {
  const title = normalizeTitle(wanted.title);
  const author = normalizeAuthor(wanted.author);
  if (!title || !author) throw new NovelMatchError('invalid_input', 'Both title and author are required for matching');
  const exact = results.filter((item) => normalizeTitle(item.title) === title);
  if (!exact.length) throw new NovelMatchError('no_title', `No search result matches title "${wanted.title}"`);
  const byAuthor = exact.filter((item) => {
    const candidate = normalizeAuthor(item.author);
    return candidate === author;
  });
  if (!byAuthor.length) throw new NovelMatchError('wrong_author', `Title "${wanted.title}" matched only other authors: ${exact.map((item) => item.author).join(' / ')}`);
  if (byAuthor.length > 1) {
    throw new NovelMatchError('ambiguous', `Ambiguous result for "${wanted.title}" / "${wanted.author}": ${byAuthor.map((item) => `${item.source.name} ${item.url}`).join(' ; ')}`);
  }
  return byAuthor[0]!;
}

export type CandidateMatch = 'exact' | 'title' | 'author' | 'other';

/** Group the same title+author across sources while preserving first-seen order. */
export function groupCandidatesByBook<T extends NovelSearchCandidate>(candidates: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = `${normalizeTitle(candidate.title)}\n${normalizeAuthor(candidate.author)}`;
    const group = groups.get(key);
    if (group) group.push(candidate); else groups.set(key, [candidate]);
  }
  return [...groups.values()];
}

/** Label a search result against whichever fields the user actually supplied. */
export function labelCandidate(candidate: NovelSearchCandidate, wanted: { title?: string; author?: string }): CandidateMatch {
  const wantedTitle = normalizeTitle(wanted.title ?? '');
  const wantedAuthor = normalizeAuthor(wanted.author ?? '');
  const title = wantedTitle ? normalizeTitle(candidate.title) === wantedTitle : false;
  const author = wantedAuthor
    ? normalizeAuthor(candidate.author) === wantedAuthor
    : false;
  if (wantedTitle && wantedAuthor) return title && author ? 'exact' : title ? 'title' : author ? 'author' : 'other';
  if (wantedTitle) return title ? 'title' : 'other';
  if (wantedAuthor) return author ? 'author' : 'other';
  return 'other';
}
