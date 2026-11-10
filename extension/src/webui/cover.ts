/**
 * Local, deterministic book-cover design.
 *
 * The shelf must look like a shelf for every book, including TXT imports that
 * have no cover image. This module only decides the text, source label and
 * palette; the WebUI turns it into DOM. It never fetches an image, reads the
 * novel or changes library state.
 */
export interface CoverBook {
  key: string;
  title: string;
  author: string;
  source?: { bookUrl?: string } | null;
}

export interface CoverDesign {
  /** Index into the eight CSS palettes. */
  palette: number;
  title: string;
  author: string;
  /** Host name without a leading "www.", or null when no URL is available. */
  sourceHost: string | null;
  /** True when the book came from a remote source, even if its URL is invalid. */
  hasSource: boolean;
  /** One-character watermark; decorative and hidden from assistive text. */
  mark: string;
}

const PALETTES = 8;

function hash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

export function coverDesign(book: CoverBook): CoverDesign {
  const title = book.title.trim();
  const author = book.author.trim();
  const hasSource = book.source != null;
  const first = Array.from(title)[0] ?? '书';
  return {
    palette: hash(`${title}\u0000${author}`) % PALETTES,
    title,
    author,
    sourceHost: hostOf(book.source?.bookUrl),
    hasSource,
    mark: first.toUpperCase(),
  };
}
