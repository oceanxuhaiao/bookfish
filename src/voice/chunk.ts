/**
 * Split book text into bounded synthesis blocks without losing a single code
 * point. Boundaries prefer Chinese sentence punctuation and newlines; a
 * sentence longer than `max` is cut by code points (never by UTF-16 units), so
 * surrogate pairs and supplementary-plane characters stay intact.
 *
 * Invariant: `splitChunks(text, max).join('') === text` for every string.
 */

const BOUNDARY = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', ']', '》', '›', '»', '…']);

export const DEFAULT_CHUNK_CHARS = 120;
export const MAX_CHUNK_CHARS = 400;

export function splitChunks(text: string, max: number = DEFAULT_CHUNK_CHARS): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (!Number.isSafeInteger(max) || max < 8 || max > MAX_CHUNK_CHARS) throw new Error('Invalid voice chunk size');
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  // Exclusive ends of preferred boundaries (after punctuation and optional closers).
  const boundaries: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (!BOUNDARY.has(chars[index]!)) continue;
    let end = index + 1;
    while (end < chars.length && CLOSERS.has(chars[end]!)) end += 1;
    boundaries.push(end);
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const limit = start + max;
    if (limit >= chars.length) {
      chunks.push(chars.slice(start).join(''));
      break;
    }
    let end = -1;
    for (const boundary of boundaries) {
      if (boundary <= start) continue;
      if (boundary > limit) break;
      end = boundary;
    }
    if (end <= start) end = limit;
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}