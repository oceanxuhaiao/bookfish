import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parsePdf } from '../src/pdf.ts';
import { importFileBlob } from '../src/stream-import.ts';
import { loadPagedBook, PageCache } from '../src/paged-book.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));

describe('PDF import', () => {
  it('extracts text, re-joins wrapped lines and keeps chapter headings', async () => {
    const book = await parsePdf(fixture('sample.pdf'));
    expect(book.chapters).toBe(3);
    expect(book.markdown).toContain('# 第一章 海边的信');
    expect(book.markdown).toContain('她坐在石阶上读完了第一行。');
    expect(book.markdown).not.toMatch(/^\s*1\s*$/m);
    expect(book.markdown).toContain('# 第三章 远方');
  });

  it('indexes the converted Markdown by chapter through the normal import pipeline', async () => {
    const book = await parsePdf(fixture('sample.pdf'));
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-pdf-'));
    try {
      const source = join(dir, 'source.md');
      writeFileSync(source, book.markdown, 'utf8');
      const id = importFileBlob(dir, source, { filename: '样本.pdf', title: '测试小说', author: '' });
      const loaded = loadPagedBook(join(dir, `${id}.json.gz`), id, new PageCache());
      const chapters = [...new Set(loaded.segments.map((segment) => segment.chapter))];
      expect(chapters).toEqual(['第一章 海边的信', '第二章 回信', '第三章 远方']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects PDFs without a text layer so scanned books never import empty', async () => {
    await expect(parsePdf(fixture('blank.pdf'))).rejects.toThrow(/text layer|OCR/);
  });

  it('rejects files that are not PDF documents', async () => {
    await expect(parsePdf(new Uint8Array(Buffer.from('not a pdf')))).rejects.toThrow();
  });
});
