/**
 * Native PDF text import.
 *
 * Text-layer PDFs are extracted page by page with unpdf (bundled PDF.js),
 * wrapped lines are re-joined, page-number-only lines dropped, and explicit
 * chapter headings become Markdown `# headings` for the existing importer.
 * Scanned/image-only PDFs have no text layer and are rejected with a clear
 * message instead of importing an empty book.
 */
import { extractText, getDocumentProxy } from 'unpdf';

const CHAPTER_HEADING = /^(?:第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章回节卷部篇]|序章|序言|楔子|引子|尾声|后记|终章|大结局|番外)/u;
const PAGE_NUMBER = /^(?:[-—–\s]*\d{1,4}[-—–\s]*|第\s*\d+\s*页(?:\s*\/\s*共?\s*\d+\s*页)?)$/u;
const SENTENCE_END = /[。！？!?…；;：:“”‘’」』）)\]]$/u;
const TITLE_TAIL = /\.(?:html?|xhtml|pdf|docx?|txt|md)$/iu;

export interface PdfBook { title: string; author: string; pages: number; chapters: number; markdown: string; bytes: number }

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function joinLine(paragraph: string, line: string): string {
  if (!paragraph) return line;
  if (/[A-Za-z0-9]$/u.test(paragraph) && /^[A-Za-z0-9]/u.test(line)) return `${paragraph} ${line}`;
  return paragraph + line;
}

/** Convert one text-layer PDF into a single Markdown novel. */
export async function parsePdf(data: Uint8Array): Promise<PdfBook> {
  if (!data.length) throw new Error('PDF file is empty');
  const pdf = await getDocumentProxy(data);
  const info = (await pdf.getMetadata().catch(() => null))?.info as Record<string, unknown> | null;
  const rawTitle = clean(info?.Title, 200);
  const title = TITLE_TAIL.test(rawTitle) || /^(?:untitled|无标题)$/iu.test(rawTitle) ? '' : rawTitle;
  const author = clean(info?.Author, 100);
  const extracted = await extractText(pdf, { mergePages: false });
  const pages = extracted.text;
  const lines: string[] = [];
  for (const page of pages) {
    for (const raw of page.split('\n')) {
      const line = raw.replace(/[\u00a0\u3000]/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (!line || PAGE_NUMBER.test(line)) continue;
      lines.push(line);
    }
  }
  if (lines.join('').length < 50) throw new Error('PDF has no extractable text layer (scanned PDFs need OCR)');

  const chapters: Array<{ title: string; paragraphs: string[] }> = [];
  let chapter = { title: '正文', paragraphs: [] as string[] };
  let paragraph = '';
  let sawHeading = false;
  const flushParagraph = () => { if (paragraph) { chapter.paragraphs.push(paragraph); paragraph = ''; } };
  const flushChapter = () => {
    flushParagraph();
    if (chapter.paragraphs.length) chapters.push(chapter);
  };
  for (const line of lines) {
    if (CHAPTER_HEADING.test(line)) {
      flushChapter();
      chapter = { title: line, paragraphs: [] };
      sawHeading = true;
      continue;
    }
    paragraph = joinLine(paragraph, line);
    if (SENTENCE_END.test(line)) flushParagraph();
    // A very short standalone line that looks like a title page is kept as its
    // own paragraph, not merged into the next chapter.
  }
  flushChapter();
  // Drop a leading title/author stub: PDFs often start with the book name and
  // byline before the first chapter heading, which is not story text.
  if (chapters.length > 1 && chapters[0]!.title === '正文') {
    const stub = chapters[0]!.paragraphs.join('');
    if (stub.length < 200 && !/[。！？!?]/u.test(stub)) chapters.shift();
  }
  if (!chapters.length) throw new Error('PDF has no readable chapters');

  const markdown = chapters.map((entry) => `# ${entry.title}\n\n${entry.paragraphs.join('\n\n')}`).join('\n\n') + '\n';
  return { title, author, pages: pages.length, chapters: chapters.length, markdown, bytes: Buffer.byteLength(markdown) };
}
