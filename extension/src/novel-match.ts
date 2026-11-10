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

/** Strip punctuation, whitespace and dynasty parentheses for comparison only. */
export function normalizeIdentity(text: string): string {
  return text
    .replace(/^作者[:：]/u, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[\s《》「」『』"'“”‘’·•,，。.、:：;；!！?？\-—_/\\|]/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Exact title plus a non-ambiguous author. `candidate` may contain an author
 * suffix such as “（明）”; an exact author match or a containment match counts.
 * More than one surviving result is an error, not a coin flip.
 */
export function matchCandidate(results: NovelSearchCandidate[], wanted: { title: string; author: string }): NovelSearchCandidate {
  const title = normalizeIdentity(wanted.title);
  const author = normalizeIdentity(wanted.author);
  if (!title || !author) throw new NovelMatchError('invalid_input', 'Both title and author are required for matching');
  const exact = results.filter((item) => normalizeIdentity(item.title) === title);
  if (!exact.length) throw new NovelMatchError('no_title', `No search result matches title "${wanted.title}"`);
  const byAuthor = exact.filter((item) => {
    const candidate = normalizeIdentity(item.author);
    return candidate === author || candidate.includes(author) || author.includes(candidate);
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
    const key = `${normalizeIdentity(candidate.title)}\n${normalizeIdentity(candidate.author)}`;
    const group = groups.get(key);
    if (group) group.push(candidate); else groups.set(key, [candidate]);
  }
  return [...groups.values()];
}

/** Label a search result against whichever fields the user actually supplied. */
export function labelCandidate(candidate: NovelSearchCandidate, wanted: { title?: string; author?: string }): CandidateMatch {
  const wantedTitle = normalizeIdentity(wanted.title ?? '');
  const wantedAuthor = normalizeIdentity(wanted.author ?? '');
  const title = wantedTitle ? normalizeIdentity(candidate.title) === wantedTitle : false;
  const author = wantedAuthor
    ? (() => { const value = normalizeIdentity(candidate.author); return value === wantedAuthor || value.includes(wantedAuthor) || wantedAuthor.includes(value); })()
    : false;
  if (wantedTitle && wantedAuthor) return title && author ? 'exact' : title ? 'title' : author ? 'author' : 'other';
  if (wantedTitle) return title ? 'exact' : 'other';
  if (wantedAuthor) return author ? 'exact' : 'other';
  return 'other';
}
