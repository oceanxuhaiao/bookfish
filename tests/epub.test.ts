import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { parseEpub } from '../src/epub.ts';
import { importFileBlob } from '../src/stream-import.ts';
import { loadPagedBook, PageCache } from '../src/paged-book.ts';

function zip(files: Array<{ name: string; body: string | Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipFile();
    for (const file of files) archive.addBuffer(Buffer.from(file.body), file.name, { mtime: new Date(0) });
    const chunks: Buffer[] = [];
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on('error', reject);
    archive.end();
  });
}

const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>海边的信</dc:title><dc:creator>小鱼</dc:creator></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
const ncx = `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1"><navLabel><text>第一章 来信</text></navLabel><content src="ch1.xhtml"/></navPoint>
<navPoint id="n2"><navLabel><text>第二章 回信</text></navLabel><content src="ch2.xhtml"/></navPoint>
</navMap></ncx>`;
const ch1 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章 来信</h1><p>海风吹过码头，小鱼从邮筒里取出一封信。</p><p>信封上的字迹很熟悉。</p></body></html>`;
const ch2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章 回信</h1><p>她坐在石阶上读完了第一行，然后把信折好。</p></body></html>`;

async function sample(): Promise<Buffer> {
  return zip([
    { name: 'mimetype', body: 'application/epub+zip' },
    { name: 'META-INF/container.xml', body: container },
    { name: 'OEBPS/content.opf', body: opf },
    { name: 'OEBPS/toc.ncx', body: ncx },
    { name: 'OEBPS/ch1.xhtml', body: ch1 },
    { name: 'OEBPS/ch2.xhtml', body: ch2 },
  ]);
}

describe('EPUB import', () => {
  it('reads metadata, chapter titles and text from an EPUB 2 book', async () => {
    const book = parseEpub(await sample());
    expect(book.title).toBe('海边的信');
    expect(book.author).toBe('小鱼');
    expect(book.chapters).toBe(2);
    expect(book.markdown).toContain('# 第一章 来信');
    expect(book.markdown).toContain('海风吹过码头');
    expect(book.markdown).not.toContain('<p>');
  });

  it('indexes the converted Markdown by chapter through the normal import pipeline', async () => {
    const book = parseEpub(await sample());
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-epub-'));
    try {
      const source = join(dir, 'source.md');
      writeFileSync(source, book.markdown, 'utf8');
      const id = importFileBlob(dir, source, { filename: '海边的信.epub', title: book.title, author: book.author });
      const loaded = loadPagedBook(join(dir, `${id}.json.gz`), id, new PageCache());
      const chapters = [...new Set(loaded.segments.map((segment) => segment.chapter))];
      expect(chapters).toEqual(['第一章 来信', '第二章 回信']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects DRM-protected EPUB files', async () => {
    const encrypted = await zip([
      { name: 'mimetype', body: 'application/epub+zip' },
      { name: 'META-INF/container.xml', body: container },
      { name: 'META-INF/encryption.xml', body: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>' },
      { name: 'OEBPS/content.opf', body: opf },
      { name: 'OEBPS/toc.ncx', body: ncx },
      { name: 'OEBPS/ch1.xhtml', body: ch1 },
    ]);
    expect(() => parseEpub(encrypted)).toThrow(/DRM/);
  });

  it('rejects files that are not ZIP containers', () => {
    expect(() => parseEpub(Buffer.from('not an epub'))).toThrow(/ZIP/);
  });
});
