/**
 * Native EPUB 2/3 import.
 *
 * Deterministic, local-only conversion: read the ZIP container, follow
 * META-INF/container.xml to the OPF package, walk the spine, and turn each
 * XHTML chapter into Markdown with `# chapter title` headings so the existing
 * text importer indexes it exactly like a hand-written Markdown novel.
 *
 * Deliberately no new runtime dependency: a bounded, read-only ZIP reader
 * (stored + deflate) is implemented here because the host install only ships
 * the package's production dependencies.
 */
import { inflateRawSync } from 'node:zlib';
import { load } from 'cheerio';

const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RATIO = 500;

interface ZipRecord { name: string; method: number; flags: number; compressedSize: number; size: number; dataOffset: number }
export interface EpubBook { title: string; author: string; chapters: number; markdown: string; bytes: number }

function findEndOfCentralDirectory(data: Buffer): number {
  const stop = Math.max(0, data.length - 22 - 65535);
  for (let at = data.length - 22; at >= stop; at--) if (data.readUInt32LE(at) === 0x06054b50) return at;
  throw new Error('Not a ZIP/EPUB file');
}

/** Read-only central-directory parser. ZIP64 and encrypted entries are rejected. */
export function readZip(data: Buffer): Map<string, ZipRecord> {
  const eocd = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 EPUB is not supported');
  if (count > MAX_ENTRIES) throw new Error('EPUB has too many entries');
  if (directoryOffset + directorySize > data.length) throw new Error('Corrupt ZIP directory');
  const records = new Map<string, ZipRecord>();
  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localOffset = data.readUInt32LE(at + 42);
    if (flags & 1) throw new Error('Encrypted EPUB entries are not supported');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 EPUB is not supported');
    if (size > MAX_ENTRY_BYTES) throw new Error('EPUB entry is too large');
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('EPUB expands beyond the supported size');
    const name = data.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    const local = localOffset;
    if (data.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    records.set(name, { name, method, flags, compressedSize, size, dataOffset: local + 30 + localName + localExtra });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

export function readZipEntry(data: Buffer, record: ZipRecord): Buffer {
  const raw = data.subarray(record.dataOffset, record.dataOffset + record.compressedSize);
  if (record.method === 0) return raw;
  if (record.method !== 8) throw new Error(`Unsupported EPUB compression method ${record.method}`);
  if (record.size > 0 && record.compressedSize > 0 && record.size / record.compressedSize > MAX_RATIO) throw new Error('EPUB entry is a compression bomb');
  const out = inflateRawSync(raw);
  if (out.length !== record.size) throw new Error('EPUB entry size mismatch');
  return out;
}

function decodeXml(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
  return text.replace(/^\uFEFF/u, '');
}

function textOf(html: string): string {
  return load(`<x>${html}</x>`, { xmlMode: false })('x').text().replace(/\s+/gu, ' ').trim();
}

function resolvePath(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);
  const parts = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

interface Chapter { title: string; text: string }

function blockText(html: string): string {
  const $ = load(html, { xmlMode: false });
  $('script,style,head,title').remove();
  $('br').replaceWith('\n');
  $('p,h1,h2,h3,h4,h5,h6,div,li,blockquote,tr,section,article,pre').each((_, element) => { $(element).append('\n'); });
  const root = $('body').length ? $('body') : $('html');
  const lines = root.text()
    .replace(/\u00a0/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .filter((line) => line.length > 0);
  const paragraphs: string[] = [];
  for (const line of lines) {
    if (paragraphs.length && paragraphs[paragraphs.length - 1] === line) continue;
    paragraphs.push(line);
  }
  return paragraphs.join('\n\n');
}

/** Convert one EPUB buffer into a single Markdown novel. Throws on DRM/corruption. */
export function parseEpub(data: Buffer): EpubBook {
  if (!data.length) throw new Error('EPUB file is empty');
  const records = readZip(data);
  const encryption = records.get('META-INF/encryption.xml');
  if (encryption) {
    const xml = readZipEntry(data, encryption).toString('utf8');
    const protectedContent = [...xml.matchAll(/<(?:CipherReference|CipherReference)[^>]*URI="([^"]+)"/giu)]
      .map((match) => match[1] ?? '')
      .some((uri) => /\.(?:x?html?|opf|ncx)$/iu.test(uri));
    if (protectedContent || /EncryptionMethod[^>]*Algorithm="[^"]*AES/iu.test(xml)) throw new Error('EPUB is DRM-protected and cannot be imported');
  }
  const container = records.get('META-INF/container.xml');
  if (!container) throw new Error('EPUB is missing META-INF/container.xml');
  const containerXml = decodeXml(readZipEntry(data, container));
  const rootPath = containerXml.match(/<rootfile[^>]*full-path="([^"]+)"/iu)?.[1];
  if (!rootPath) throw new Error('EPUB is missing its OPF package');
  const opfPath = decodeURIComponent(rootPath);
  const opfRecord = records.get(opfPath);
  if (!opfRecord) throw new Error('EPUB OPF package is missing');
  const opf = decodeXml(readZipEntry(data, opfRecord));
  const title = textOf(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/iu)?.[1] ?? '');
  const author = textOf(opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/iu)?.[1] ?? '');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const $opf = load(opf, { xmlMode: true });
  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  $opf('manifest item').each((_, element) => {
    const id = $opf(element).attr('id');
    const href = $opf(element).attr('href');
    if (!id || !href) return;
    manifest.set(id, { href, type: $opf(element).attr('media-type') ?? '', properties: $opf(element).attr('properties') ?? '' });
  });
  const spine: string[] = [];
  $opf('spine itemref').each((_, element) => {
    const idref = $opf(element).attr('idref');
    if (!idref || $opf(element).attr('linear') === 'no') return;
    spine.push(idref);
  });
  if (!spine.length) throw new Error('EPUB spine is empty');

  // Chapter titles come from the NCX (EPUB2) or the navigation document (EPUB3).
  const navTitles = new Map<string, string>();
  const tocId = $opf('spine').attr('toc');
  const navEntry = (tocId ? manifest.get(tocId) : undefined)
    ?? [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')
    ?? [...manifest.values()].find((item) => item.properties.split(/\s+/u).includes('nav'));
  if (navEntry) {
    const navPath = resolvePath(baseDir, navEntry.href);
    const navRecord = records.get(navPath);
    if (navRecord) {
      const navXml = decodeXml(readZipEntry(data, navRecord));
      const $nav = load(navXml, { xmlMode: true });
      $nav('navPoint').each((_, element) => {
        const label = $nav(element).find('navLabel text').first().text().replace(/\s+/gu, ' ').trim();
        const src = $nav(element).find('content').attr('src');
        if (label && src) navTitles.set(resolvePath(baseDir, src), label);
      });
      $nav('nav[epub\\:type="toc"] a, nav[role="doc-toc"] a, nav a').each((_, element) => {
        const label = $nav(element).text().replace(/\s+/gu, ' ').trim();
        const href = $nav(element).attr('href');
        if (label && href) navTitles.set(resolvePath(baseDir, href), label);
      });
    }
  }

  const chapters: Chapter[] = [];
  let totalChars = 0;
  for (const [index, idref] of spine.entries()) {
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.properties.split(/\s+/u).includes('nav')) continue;
    if (!/xhtml|html/iu.test(item.type) && !/\.x?html?$/iu.test(item.href)) continue;
    const path = resolvePath(baseDir, item.href);
    const record = records.get(path);
    if (!record) continue;
    const html = decodeXml(readZipEntry(data, record));
    const text = blockText(html);
    if (text.length < 2) continue;
    // Table-of-contents / navigation pages are spine items too. They are link
    // lists, not story text: skip them instead of importing a fake chapter.
    const anchors = (html.match(/<a\s/giu) ?? []).length;
    if (/返回主目录|返回目录|回到目录|table of contents/iu.test(text)) continue;
    if (anchors >= 5 && text.length < 1500) continue;
    const heading = load(html)('h1,h2,h3').first().text().replace(/\s+/gu, ' ').trim();
    let chapterTitle = navTitles.get(path) ?? heading ?? `第${index + 1}节`;
    chapterTitle = chapterTitle.replace(/\s+/gu, ' ').trim();
    if (/^(?:主?目录|目\s*录|contents|table of contents|封面)$/iu.test(chapterTitle)) continue;
    let body = text;
    const firstLine = body.split('\n')[0]?.trim() ?? '';
    if (firstLine && firstLine === chapterTitle) body = body.slice(firstLine.length).trim();
    if (!body) continue;
    chapters.push({ title: chapterTitle, text: body });
    totalChars += body.length;
  }
  if (!chapters.length) throw new Error('EPUB has no readable chapters');
  const markdown = chapters.map((chapter) => `# ${chapter.title}\n\n${chapter.text}`).join('\n\n') + '\n';
  return { title, author, chapters: chapters.length, markdown, bytes: Buffer.byteLength(markdown) };
}
