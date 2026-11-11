import { createHash } from 'node:crypto';
import type { RemoteSource } from './source-types.ts';

export const MAX_BOOK_BYTES = 100 * 1024 * 1024;
export const SEGMENT_CHARS = 1200;
export const PARSER_VERSION = 1;
export interface Segment { id: number; chapter: string; start: number; end: number; text: string }
export interface Book {
  key: string; id: string; revision: string; title: string; author: string;
  filename: string; text: string; sourceHash: string; totalChars: number; parserVersion: 1; segments: Segment[];
  remote?: RemoteSource;
}
export function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function requiredText(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}: invalid text`);
  return value.trim();
}
export function buildBook(filenameValue: unknown, titleValue: unknown, authorValue: unknown, bytes: Uint8Array | string): Book {
  const filename = requiredText(filenameValue, 'filename');
  if (/[\\/\x00-\x1f]/.test(filename) || !/\.(txt|md)$/i.test(filename)) throw new Error('Only local .txt or .md files are supported');
  if (!bytes.length || (typeof bytes==='string'?Buffer.byteLength(bytes):bytes.length) > MAX_BOOK_BYTES) throw new Error('Book must be between 1 byte and 100 MiB');
  let text: string;
  try { text = typeof bytes==='string'?bytes:new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Book must use UTF-8 encoding'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Binary or control characters are not supported');
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Book has no readable text');
  const title = requiredText(titleValue, 'title');
  const author = typeof authorValue === 'string' && authorValue.length <= 100 ? authorValue.trim() : '';
  if (authorValue !== undefined && typeof authorValue !== 'string') throw new Error('author: invalid text');
  if (typeof authorValue === 'string' && authorValue.length > 100) throw new Error('author: too long');
  const id = digest(`${title.normalize('NFC')}\n${author.normalize('NFC')}`);
  const revision = createHash('sha256').update(`${PARSER_VERSION}\n`).update(text).digest('hex');
  const segments: Segment[] = [];
  let chapter = '正文';
  let offset = 0;
  // Keep every canonical character, including separators, in exactly one range.
  const blocks = text.matchAll(/[^\n]+(?:\n+|$)|\n+/g);
  for (const match of blocks) {
    const block=match[0];
    const line = block.trim();
    if (/^#{1,6}\s+\S/.test(line) || (line.length <= 200 && /^第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇]/u.test(line))) {
      chapter = line.replace(/^#{1,6}\s+/, '').slice(0, 200);
    }
    const charsLength = block.length;
    let from = 0;
    while (from < charsLength) {
      const previous = segments[segments.length - 1];
      const canAppend = previous && previous.chapter === chapter && previous.end - previous.start < SEGMENT_CHARS;
      const length = Math.min(canAppend ? SEGMENT_CHARS - (previous.end - previous.start) : SEGMENT_CHARS, Number.MAX_SAFE_INTEGER);
      let until=from,count=0;while(until<block.length&&count<length){const cp=block.codePointAt(until)!;until+=cp>0xffff?2:1;count++;}const piece=block.slice(from,until);
      if (canAppend) {
        previous.text += piece; previous.end += count;
      } else segments.push({ id: segments.length, chapter, start: offset, end: offset + count, text: piece });
      if(segments.length>200000)throw new Error('Book has too many chapter ranges (maximum 200000)');
      offset += count; from = until;
    }
  }
  return { key: `${id}:${revision}`, id, revision, title, author, filename, text, sourceHash: digest(text),
    totalChars: offset, parserVersion: PARSER_VERSION, segments };
}
export function decodeFile(input: unknown): Book {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid import request');
  const value = input as Record<string, unknown>;
  if (typeof value.base64 !== 'string' || value.base64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4 ||
    Buffer.from(value.base64, 'base64').toString('base64') !== value.base64) throw new Error('Invalid or oversized file data');
  return buildBook(value.filename, value.title, value.author, Buffer.from(value.base64, 'base64'));
}
