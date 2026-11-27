import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_CHARS, splitChunks } from '../src/voice/chunk.ts';

const codePoints = (value: string) => Array.from(value).length;

describe('voice text chunking', () => {
  it('keeps every code point and the exact order', () => {
    const text = '第一句。第二句！第三句？还有；分号、逗号，以及\n换行。';
    const chunks = splitChunks(text, 8);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(codePoints(chunk)).toBeLessThanOrEqual(8);
  });

  it('prefers Chinese sentence boundaries', () => {
    const chunks = splitChunks('甲甲甲。乙乙乙。丙丙丙。', 8);
    expect(chunks.join('')).toBe('甲甲甲。乙乙乙。丙丙丙。');
    expect(chunks[0]).toBe('甲甲甲。乙乙乙。');
  });

  it('hard-splits an overlong sentence by code points', () => {
    const text = '海'.repeat(301);
    const chunks = splitChunks(text, 120);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => codePoints(chunk) <= 120)).toBe(true);
    expect(chunks.map(chunk => chunk.length)).toEqual([120, 120, 61]);
  });

  it('does not split surrogate pairs or supplementary-plane characters', () => {
    const text = '🐟'.repeat(200) + '𠀀'.repeat(100);
    const chunks = splitChunks(text, 50);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
  });

  it('preserves newlines and whitespace exactly', () => {
    const text = '甲甲甲。\n\n乙乙乙。\n';
    const chunks = splitChunks(text, 8);
    expect(chunks.join('')).toBe(text);
    expect(chunks.some(chunk => chunk.includes('\n'))).toBe(true);
  });

  it('returns no chunks for empty text and rejects invalid limits', () => {
    expect(splitChunks('')).toEqual([]);
    expect(() => splitChunks('abc', 0)).toThrow();
    expect(() => splitChunks('abc', 999)).toThrow();
    expect(DEFAULT_CHUNK_CHARS).toBe(120);
  });
});