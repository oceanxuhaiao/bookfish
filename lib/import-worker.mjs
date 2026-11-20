// src/import-metadata.ts
function detectImportMetadata(filename, prefix = "") {
  const clean2 = (s, n) => Array.from(s.replace(/[\x00-\x1f\x7f]/g, " ").trim()).slice(0, n).join("");
  const stem = filename.replace(/\.(txt|md|epub|pdf)$/i, "").trim();
  const named = stem.match(/^《([^》]+)》(?:[ _-]*(?:作者[：:]?\s*)?(.+))?$/u);
  let title = clean2(named?.[1] ?? stem, 200) || "\u672A\u547D\u540D\u5C0F\u8BF4", author = clean2(named?.[2] ?? "", 100);
  const lines = prefix.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 60);
  for (const line of lines) {
    const text2 = line.trim();
    const t = text2.match(/^(?:书名|Title)\s*[：:]\s*(.{1,200})$/iu);
    if (t) {
      title = clean2(t[1].replace(/^《(.+)》$/u, "$1"), 200);
      break;
    }
  }
  for (const line of lines) {
    const a = line.trim().match(/^(?:作者|Author)\s*[：:]\s*(.{1,100})$/iu);
    if (a) {
      author = clean2(a[1], 100);
      break;
    }
  }
  if (!lines.some((l) => /^(?:书名|Title)\s*[：:]/iu.test(l.trim()))) {
    const t = lines.slice(0, 8).map((l) => l.trim()).find((l) => /^《[^》]{1,200}》$/.test(l));
    if (t) title = clean2(t.slice(1, -1), 200);
  }
  return { title, author };
}

// src/epub.ts
import { inflateRawSync } from "node:zlib";
import { load } from "cheerio";
var MAX_ENTRIES = 5e3;
var MAX_ENTRY_BYTES = 128 * 1024 * 1024;
var MAX_TOTAL_BYTES = 256 * 1024 * 1024;
var MAX_RATIO = 500;
function findEndOfCentralDirectory(data) {
  const stop = Math.max(0, data.length - 22 - 65535);
  for (let at = data.length - 22; at >= stop; at--) if (data.readUInt32LE(at) === 101010256) return at;
  throw new Error("Not a ZIP/EPUB file");
}
function readZip(data) {
  const eocd = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (count === 65535 || directoryOffset === 4294967295) throw new Error("ZIP64 EPUB is not supported");
  if (count > MAX_ENTRIES) throw new Error("EPUB has too many entries");
  if (directoryOffset + directorySize > data.length) throw new Error("Corrupt ZIP directory");
  const records = /* @__PURE__ */ new Map();
  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 33639248) throw new Error("Corrupt ZIP directory");
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localOffset = data.readUInt32LE(at + 42);
    if (flags & 1) throw new Error("Encrypted EPUB entries are not supported");
    if (compressedSize === 4294967295 || size === 4294967295 || localOffset === 4294967295) throw new Error("ZIP64 EPUB is not supported");
    if (size > MAX_ENTRY_BYTES) throw new Error("EPUB entry is too large");
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error("EPUB expands beyond the supported size");
    const name = data.subarray(at + 46, at + 46 + nameLength).toString(flags & 2048 ? "utf8" : "latin1");
    const local = localOffset;
    if (data.readUInt32LE(local) !== 67324752) throw new Error("Corrupt ZIP entry");
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    records.set(name, { name, method, flags, compressedSize, size, dataOffset: local + 30 + localName + localExtra });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}
function readZipEntry(data, record) {
  const raw = data.subarray(record.dataOffset, record.dataOffset + record.compressedSize);
  if (record.method === 0) return raw;
  if (record.method !== 8) throw new Error(`Unsupported EPUB compression method ${record.method}`);
  if (record.size > 0 && record.compressedSize > 0 && record.size / record.compressedSize > MAX_RATIO) throw new Error("EPUB entry is a compression bomb");
  const out = inflateRawSync(raw);
  if (out.length !== record.size) throw new Error("EPUB entry size mismatch");
  return out;
}
function decodeXml(bytes) {
  let text2;
  try {
    text2 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text2 = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  }
  return text2.replace(/^\uFEFF/u, "");
}
function textOf(html) {
  return load(`<x>${html}</x>`, { xmlMode: false })("x").text().replace(/\s+/gu, " ").trim();
}
function resolvePath(baseDir, href) {
  const clean2 = decodeURIComponent(href.split("#")[0].split("?")[0]);
  const parts = (baseDir ? baseDir.split("/") : []).concat(clean2.split("/"));
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
function blockText(html) {
  const $ = load(html, { xmlMode: false });
  $("script,style,head,title").remove();
  $("br").replaceWith("\n");
  $("p,h1,h2,h3,h4,h5,h6,div,li,blockquote,tr,section,article,pre").each((_, element) => {
    $(element).append("\n");
  });
  const root = $("body").length ? $("body") : $("html");
  const lines = root.text().replace(/\u00a0/gu, " ").replace(/\r\n?/gu, "\n").split("\n").map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter((line) => line.length > 0);
  const paragraphs = [];
  for (const line of lines) {
    if (paragraphs.length && paragraphs[paragraphs.length - 1] === line) continue;
    paragraphs.push(line);
  }
  return paragraphs.join("\n\n");
}
function parseEpub(data) {
  if (!data.length) throw new Error("EPUB file is empty");
  const records = readZip(data);
  const encryption = records.get("META-INF/encryption.xml");
  if (encryption) {
    const xml = readZipEntry(data, encryption).toString("utf8");
    const protectedContent = [...xml.matchAll(/<(?:CipherReference|CipherReference)[^>]*URI="([^"]+)"/giu)].map((match) => match[1] ?? "").some((uri) => /\.(?:x?html?|opf|ncx)$/iu.test(uri));
    if (protectedContent || /EncryptionMethod[^>]*Algorithm="[^"]*AES/iu.test(xml)) throw new Error("EPUB is DRM-protected and cannot be imported");
  }
  const container = records.get("META-INF/container.xml");
  if (!container) throw new Error("EPUB is missing META-INF/container.xml");
  const containerXml = decodeXml(readZipEntry(data, container));
  const rootPath = containerXml.match(/<rootfile[^>]*full-path="([^"]+)"/iu)?.[1];
  if (!rootPath) throw new Error("EPUB is missing its OPF package");
  const opfPath = decodeURIComponent(rootPath);
  const opfRecord = records.get(opfPath);
  if (!opfRecord) throw new Error("EPUB OPF package is missing");
  const opf = decodeXml(readZipEntry(data, opfRecord));
  const title = textOf(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/iu)?.[1] ?? "");
  const author = textOf(opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/iu)?.[1] ?? "");
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
  const $opf = load(opf, { xmlMode: true });
  const manifest = /* @__PURE__ */ new Map();
  $opf("manifest item").each((_, element) => {
    const id = $opf(element).attr("id");
    const href = $opf(element).attr("href");
    if (!id || !href) return;
    manifest.set(id, { href, type: $opf(element).attr("media-type") ?? "", properties: $opf(element).attr("properties") ?? "" });
  });
  const spine = [];
  $opf("spine itemref").each((_, element) => {
    const idref = $opf(element).attr("idref");
    if (!idref || $opf(element).attr("linear") === "no") return;
    spine.push(idref);
  });
  if (!spine.length) throw new Error("EPUB spine is empty");
  const navTitles = /* @__PURE__ */ new Map();
  const tocId = $opf("spine").attr("toc");
  const navEntry = (tocId ? manifest.get(tocId) : void 0) ?? [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml") ?? [...manifest.values()].find((item) => item.properties.split(/\s+/u).includes("nav"));
  if (navEntry) {
    const navPath = resolvePath(baseDir, navEntry.href);
    const navRecord = records.get(navPath);
    if (navRecord) {
      const navXml = decodeXml(readZipEntry(data, navRecord));
      const $nav = load(navXml, { xmlMode: true });
      $nav("navPoint").each((_, element) => {
        const label = $nav(element).find("navLabel text").first().text().replace(/\s+/gu, " ").trim();
        const src = $nav(element).find("content").attr("src");
        if (label && src) navTitles.set(resolvePath(baseDir, src), label);
      });
      $nav('nav[epub\\:type="toc"] a, nav[role="doc-toc"] a, nav a').each((_, element) => {
        const label = $nav(element).text().replace(/\s+/gu, " ").trim();
        const href = $nav(element).attr("href");
        if (label && href) navTitles.set(resolvePath(baseDir, href), label);
      });
    }
  }
  const chapters = [];
  let totalChars = 0;
  for (const [index, idref] of spine.entries()) {
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.properties.split(/\s+/u).includes("nav")) continue;
    if (!/xhtml|html/iu.test(item.type) && !/\.x?html?$/iu.test(item.href)) continue;
    const path = resolvePath(baseDir, item.href);
    const record = records.get(path);
    if (!record) continue;
    const html = decodeXml(readZipEntry(data, record));
    const text2 = blockText(html);
    if (text2.length < 2) continue;
    const anchors = (html.match(/<a\s/giu) ?? []).length;
    if (/返回主目录|返回目录|回到目录|table of contents/iu.test(text2)) continue;
    if (anchors >= 5 && text2.length < 1500) continue;
    const heading = load(html)("h1,h2,h3").first().text().replace(/\s+/gu, " ").trim();
    let chapterTitle = navTitles.get(path) ?? heading ?? `\u7B2C${index + 1}\u8282`;
    chapterTitle = chapterTitle.replace(/\s+/gu, " ").trim();
    if (/^(?:主?目录|目\s*录|contents|table of contents|封面)$/iu.test(chapterTitle)) continue;
    let body = text2;
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    if (firstLine && firstLine === chapterTitle) body = body.slice(firstLine.length).trim();
    if (!body) continue;
    chapters.push({ title: chapterTitle, text: body });
    totalChars += body.length;
  }
  if (!chapters.length) throw new Error("EPUB has no readable chapters");
  const markdown = chapters.map((chapter) => `# ${chapter.title}

${chapter.text}`).join("\n\n") + "\n";
  return { title, author, chapters: chapters.length, markdown, bytes: Buffer.byteLength(markdown) };
}

// src/pdf.ts
import { extractText, getDocumentProxy } from "unpdf";
var CHAPTER_HEADING = /^(?:第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章回节卷部篇]|序章|序言|楔子|引子|尾声|后记|终章|大结局|番外)/u;
var PAGE_NUMBER = /^(?:[-—–\s]*\d{1,4}[-—–\s]*|第\s*\d+\s*页(?:\s*\/\s*共?\s*\d+\s*页)?)$/u;
var SENTENCE_END = /[。！？!?…；;：:“”‘’」』）)\]]$/u;
var TITLE_TAIL = /\.(?:html?|xhtml|pdf|docx?|txt|md)$/iu;
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}
function joinLine(paragraph, line) {
  if (!paragraph) return line;
  if (/[A-Za-z0-9]$/u.test(paragraph) && /^[A-Za-z0-9]/u.test(line)) return `${paragraph} ${line}`;
  return paragraph + line;
}
async function parsePdf(data) {
  if (!data.length) throw new Error("PDF file is empty");
  const pdf = await getDocumentProxy(data);
  const info = (await pdf.getMetadata().catch(() => null))?.info;
  const rawTitle = clean(info?.Title, 200);
  const title = TITLE_TAIL.test(rawTitle) || /^(?:untitled|无标题)$/iu.test(rawTitle) ? "" : rawTitle;
  const author = clean(info?.Author, 100);
  const extracted = await extractText(pdf, { mergePages: false });
  const pages = extracted.text;
  const lines = [];
  for (const page of pages) {
    for (const raw of page.split("\n")) {
      const line = raw.replace(/[\u00a0\u3000]/gu, " ").replace(/\s+/gu, " ").trim();
      if (!line || PAGE_NUMBER.test(line)) continue;
      lines.push(line);
    }
  }
  if (lines.join("").length < 50) throw new Error("PDF has no extractable text layer (scanned PDFs need OCR)");
  const chapters = [];
  let chapter = { title: "\u6B63\u6587", paragraphs: [] };
  let paragraph = "";
  let sawHeading = false;
  const flushParagraph = () => {
    if (paragraph) {
      chapter.paragraphs.push(paragraph);
      paragraph = "";
    }
  };
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
  }
  flushChapter();
  if (chapters.length > 1 && chapters[0].title === "\u6B63\u6587") {
    const stub = chapters[0].paragraphs.join("");
    if (stub.length < 200 && !/[。！？!?]/u.test(stub)) chapters.shift();
  }
  if (!chapters.length) throw new Error("PDF has no readable chapters");
  const markdown = chapters.map((entry) => `# ${entry.title}

${entry.paragraphs.join("\n\n")}`).join("\n\n") + "\n";
  return { title, author, pages: pages.length, chapters: chapters.length, markdown, bytes: Buffer.byteLength(markdown) };
}

// src/import-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { statSync as statSync3, openSync as openSync3, readSync as readSync3, closeSync as closeSync3, readFileSync, writeFileSync as writeFileSync2, unlinkSync as unlinkSync3, existsSync as existsSync3 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import { join as join2 } from "node:path";

// src/stream-import.ts
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import { TextDecoder as TextDecoder2 } from "node:util";
import { openSync as openSync2, closeSync as closeSync2, readSync as readSync2, writeSync as writeSync2, ftruncateSync, fsyncSync as fsyncSync2, statSync as statSync2, unlinkSync as unlinkSync2, existsSync as existsSync2, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/books.ts
import { createHash } from "node:crypto";
var MAX_BOOK_BYTES = 100 * 1024 * 1024;
var SEGMENT_CHARS = 1200;
var PARSER_VERSION = 1;
function digest(text2) {
  return createHash("sha256").update(text2).digest("hex");
}
function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name}: invalid text`);
  return value.trim();
}
function buildBook(filenameValue, titleValue, authorValue, bytes) {
  const filename = requiredText(filenameValue, "filename");
  if (/[\\/\x00-\x1f]/.test(filename) || !/\.(txt|md|epub|pdf)$/i.test(filename)) throw new Error("Only local .txt, .md, .epub or .pdf files are supported");
  if (!bytes.length || (typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length) > MAX_BOOK_BYTES) throw new Error("Book must be between 1 byte and 100 MiB");
  let text2;
  try {
    text2 = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Book must use UTF-8 encoding");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text2)) throw new Error("Binary or control characters are not supported");
  text2 = text2.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text2) throw new Error("Book has no readable text");
  const title = requiredText(titleValue, "title");
  const author = typeof authorValue === "string" && authorValue.length <= 100 ? authorValue.trim() : "";
  if (authorValue !== void 0 && typeof authorValue !== "string") throw new Error("author: invalid text");
  if (typeof authorValue === "string" && authorValue.length > 100) throw new Error("author: too long");
  const id = digest(`${title.normalize("NFC")}
${author.normalize("NFC")}`);
  const revision = createHash("sha256").update(`${PARSER_VERSION}
`).update(text2).digest("hex");
  const segments = [];
  let chapter = "\u6B63\u6587";
  let offset = 0;
  const blocks = text2.matchAll(/[^\n]+(?:\n+|$)|\n+/g);
  for (const match of blocks) {
    const block = match[0];
    const line = block.trim();
    if (/^#{1,6}\s+\S/.test(line) || line.length <= 200 && /^第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇]/u.test(line)) {
      chapter = line.replace(/^#{1,6}\s+/, "").slice(0, 200);
    }
    const charsLength = block.length;
    let from = 0;
    while (from < charsLength) {
      const previous = segments[segments.length - 1];
      const canAppend = previous && previous.chapter === chapter && previous.end - previous.start < SEGMENT_CHARS;
      const length = Math.min(canAppend ? SEGMENT_CHARS - (previous.end - previous.start) : SEGMENT_CHARS, Number.MAX_SAFE_INTEGER);
      let until = from, count = 0;
      while (until < block.length && count < length) {
        const cp = block.codePointAt(until);
        until += cp > 65535 ? 2 : 1;
        count++;
      }
      const piece = block.slice(from, until);
      if (canAppend) {
        previous.text += piece;
        previous.end += count;
      } else segments.push({ id: segments.length, chapter, start: offset, end: offset + count, text: piece });
      if (segments.length > 2e5) throw new Error("Book has too many chapter ranges (maximum 200000)");
      offset += count;
      from = until;
    }
  }
  return {
    key: `${id}:${revision}`,
    id,
    revision,
    title,
    author,
    filename,
    text: text2,
    sourceHash: digest(text2),
    totalChars: offset,
    parserVersion: PARSER_VERSION,
    segments
  };
}

// src/stream-index.ts
function* streamIndex(chunks) {
  function* blocks() {
    let start = 0, offset2 = 0, units = 0, first = -1, last2 = 0, head = "", body = "", bodyUnits = 0, bodyLast = 0;
    let hashes = 0, mode = 0, markdown = false, newlines = false, chapter = "\u6B63\u6587";
    const reset = () => {
      units = 0;
      first = -1;
      last2 = 0;
      head = "";
      body = "";
      bodyUnits = 0;
      bodyLast = 0;
      hashes = 0;
      mode = 0;
      markdown = false;
    };
    const classify = () => {
      const length = first < 0 ? 0 : last2 - first, line = head.slice(0, Math.min(length, 200));
      if (markdown) {
        chapter = body.slice(0, Math.min(bodyLast, 200));
      } else if (length <= 200 && /^第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇]/u.test(line)) {
        chapter = line;
      }
    };
    for (const chunk of chunks()) for (const c of chunk) {
      if (c === "\n") {
        if (!newlines) classify();
        newlines = true;
        offset2++;
        continue;
      }
      if (newlines) {
        yield { start, end: offset2, chapter };
        start = offset2;
        reset();
        newlines = false;
      }
      const space = /\s/u.test(c);
      if (!space && first < 0) first = units;
      if (first >= 0 && head.length < 201) head += c;
      if (!space) last2 = units + c.length;
      if (mode === 0) {
        if (!space) {
          if (c === "#") {
            hashes = 1;
            mode = 1;
          } else mode = 4;
        }
      } else if (mode === 1) {
        if (c === "#" && hashes < 6) hashes++;
        else if (space) mode = 2;
        else mode = 4;
      } else if (mode === 2 && !space) {
        markdown = true;
        mode = 3;
      }
      if (mode === 3) {
        if (body.length < 201) body += c;
        bodyUnits += c.length;
        if (!space) bodyLast = bodyUnits;
      }
      units += c.length;
      offset2++;
    }
    if (offset2 > start) {
      if (!newlines) classify();
      yield { start, end: offset2, chapter };
    }
  }
  const input = chunks()[Symbol.iterator]();
  let chars = [], at = 0;
  const take = (n) => {
    let text2 = "";
    while (n) {
      if (at === chars.length) {
        const next = input.next();
        if (next.done) throw Error("Truncated canonical source");
        chars = Array.from(next.value);
        at = 0;
        if (!chars.length) continue;
      }
      const count = Math.min(n, chars.length - at);
      text2 += chars.slice(at, at + count).join("");
      at += count;
      n -= count;
    }
    return text2;
  };
  let pending, index = 0, offset = 0;
  try {
    for (const block of blocks()) {
      let left = block.end - block.start;
      while (left) {
        if (pending && (pending.chapter !== block.chapter || pending.end - pending.start === 1200)) {
          yield pending;
          pending = void 0;
        }
        const count = Math.min(left, pending ? 1200 - (pending.end - pending.start) : 1200), text2 = take(count);
        if (pending) {
          pending.text += text2;
          pending.end += count;
        } else pending = { id: index++, chapter: block.chapter, start: offset, end: offset + count, text: text2 };
        offset += count;
        left -= count;
      }
    }
    if (pending) yield pending;
  } finally {
    input.return?.();
  }
}

// src/paged-book.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { openSync, closeSync, readSync, writeSync, fsyncSync, renameSync, unlinkSync, existsSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

// src/biquge.ts
import { load as load2 } from "cheerio";

// src/source-http.ts
import ipaddr from "ipaddr.js";

// src/source-types.ts
var SourceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SourceError";
  }
  code;
};

// src/source-http.ts
var SOURCE_HOST = "www.02345.cc";
function sourceUrl(value, hosts = [SOURCE_HOST]) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError("unsupported", "Invalid source URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || !hosts.includes(url.hostname) || url.search || url.hash) throw new SourceError("unsupported", `Only public book URLs on ${hosts.join(", ")} are supported`);
  return url;
}

// src/biquge.ts
function catalogUrl(input) {
  const url = sourceUrl(input);
  url.protocol = "https:";
  const match = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/(?:index_\d+\.html|\d+(?:_\d+)?\/)?$/);
  if (!match) throw new SourceError("unsupported", "Provide a novel directory or chapter URL, not the site home or search page");
  url.pathname = `/${match[1]}/`;
  return url.href;
}
function catalogHash(catalog) {
  return digest(JSON.stringify([catalog.bookUrl, catalog.title, catalog.author, catalog.publicationStatus, catalog.chapters]));
}

// src/serial-types.ts
var SERIAL_INTERVALS = [30, 60, 180, 360];
var ISO = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
var int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
var text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
function chapterId(chapter) {
  return chapter.id ?? chapter.url;
}
function serialCatalogHash(catalog) {
  return digest(JSON.stringify([
    catalog.adapter,
    catalog.bookUrl,
    catalog.title,
    catalog.author,
    catalog.publicationStatus,
    catalog.chapters.map((c) => [chapterId(c), c.title, c.url, c.revision ?? null])
  ]));
}
function stableSerialIdentity(serialId, editionEpoch) {
  const id = digest(`serial
${serialId}`);
  const revision = digest(`serial-edition
${serialId}
${editionEpoch}`);
  return { id, revision, key: `${id}:${revision}` };
}
function validateSerialCatalog(catalog, expected) {
  if (!catalog || typeof catalog.adapter !== "string" || !catalog.adapter || catalog.adapter.length > 80 || typeof catalog.bookUrl !== "string" || typeof catalog.title !== "string" || !catalog.title.trim() || catalog.title.length > 200 || typeof catalog.author !== "string" || catalog.author.length > 100 || !int(catalog.declaredTotal, 1, 2e4) || !Array.isArray(catalog.chapters) || catalog.chapters.length !== catalog.declaredTotal || !["finished", "ongoing", "unknown"].includes(catalog.publicationStatus) || !ISO(catalog.fetchedAt) || catalog.complete === false || catalog.pageCount !== void 0 && !int(catalog.pageCount, 1, 100)) {
    throw new SourceError("invalid_content", "Invalid serial catalog snapshot");
  }
  if (expected?.bookUrl !== void 0 && catalog.bookUrl !== expected.bookUrl) throw new SourceError("invalid_content", "Catalog book URL changed");
  if (expected?.title !== void 0 && catalog.title !== expected.title) throw new SourceError("invalid_content", "Catalog book title changed");
  if (expected?.author !== void 0 && catalog.author !== expected.author) throw new SourceError("invalid_content", "Catalog author changed");
  const ids = /* @__PURE__ */ new Set(), urls = /* @__PURE__ */ new Set();
  for (const chapter of catalog.chapters) {
    if (!chapter || !text(chapter.title, 200) || !text(chapter.url, 2e3) || chapter.id !== void 0 && !text(chapter.id, 500) || chapter.revision !== void 0 && !text(chapter.revision, 200)) throw new SourceError("invalid_content", "Invalid serial chapter identity");
    const id = chapterId(chapter);
    if (ids.has(id) || urls.has(chapter.url)) throw new SourceError("invalid_content", "Catalog contains duplicate chapter identity");
    ids.add(id);
    urls.add(chapter.url);
  }
  if (catalog.hash !== serialCatalogHash(catalog)) throw new SourceError("invalid_content", "Catalog hash does not match its contents");
}
function validateSerialRecord(record, cacheLength, totalSegments) {
  if (!record || !/^[a-f0-9-]{36}$/.test(record.serialId) || !int(record.editionEpoch, 1, 1e3) || !int(record.contentVersion, 1, Number.MAX_SAFE_INTEGER) || !int(record.subscriptionRevision, 1, Number.MAX_SAFE_INTEGER) || !text(record.sourceId, 100) || !text(record.sourceBookId, 500) || !text(record.bookUrl, 2e3) || !record.capabilities || typeof record.capabilities !== "object" || !["allowed", "unknown", "blocked"].includes(record.authorization) || typeof record.authorizationNote !== "string" || record.authorizationNote.length > 500) {
    throw new Error("Invalid serial subscription record");
  }
  const c = record.capabilities;
  for (const key of ["catalog", "chapterContent", "stableChapterId", "chapterRevision", "publicationStatus", "cancellation", "conditionalRequest"]) if (typeof c[key] !== "boolean") throw new Error("Invalid serial capability declaration");
  if (!["declared", "observed", "unknown"].includes(c.rateLimit)) throw new Error("Invalid serial rate-limit declaration");
  const e = record.publicationEvidence;
  if (!e || !["ongoing", "finished", "unknown"].includes(e.status) || !text(e.source, 200) || !ISO(e.observedAt) || typeof e.note !== "string" || e.note.length > 500) throw new Error("Invalid serial publication evidence");
  const s = record.subscription;
  if (!s || typeof s.enabled !== "boolean" || !SERIAL_INTERVALS.includes(s.intervalMinutes) || s.nextCheckAt !== null && !ISO(s.nextCheckAt) || s.lastAttemptAt !== null && !ISO(s.lastAttemptAt) || s.lastSuccessfulCheckAt !== null && !ISO(s.lastSuccessfulCheckAt) || !int(s.failures, 0, 1e6) || s.backoffUntil !== null && !ISO(s.backoffUntil)) throw new Error("Invalid serial schedule record");
  if (!Array.isArray(record.receipts) || record.receipts.length > 100 || !Array.isArray(record.layout) || record.layout.length !== cacheLength) throw new Error("Invalid serial receipts or layout");
  for (const r of record.receipts) {
    if (!r || !/^[a-f0-9-]{36}$/.test(r.jobId) || !ISO(r.at) || !["succeeded", "no_change", "failed", "cancelled", "conflict"].includes(r.status) || !int(r.expectedVersion, 0, Number.MAX_SAFE_INTEGER) || !int(r.committedVersion, 0, Number.MAX_SAFE_INTEGER) || typeof r.baseCatalogHash !== "string" || !/^[a-f0-9]{64}$/.test(r.baseCatalogHash) || typeof r.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(r.catalogHash) || !int(r.addedCount, 0, 1e3) || !Array.isArray(r.addedChapterIds) || r.addedChapterIds.length !== r.addedCount || r.addedChapterIds.some((id) => typeof id !== "string" || !id || id.length > 500) || r.error !== null && (typeof r.error !== "string" || r.error.length > 500)) throw new Error("Invalid serial receipt");
  }
  let last2 = 0;
  for (const end of record.layout) {
    if (!int(end, last2 + 1, 1e6)) throw new Error("Invalid serial layout");
    last2 = end;
  }
  if (cacheLength && last2 !== totalSegments) throw new Error("Serial layout does not cover cached text");
  if (!cacheLength && last2 !== 0) throw new Error("Empty serial cache has a layout");
  if (record.lastCheck && (!ISO(record.lastCheck.at) || !["succeeded", "no_change", "failed", "cancelled", "conflict"].includes(record.lastCheck.status) || typeof record.lastCheck.message !== "string" || record.lastCheck.message.length > 500)) throw new Error("Invalid serial last-check record");
}
var SERIAL_BATCH_BYTES = 5 * 1024 * 1024;

// src/remote-books.ts
function serialContentHash(hashes) {
  let hash = digest("serial-content-v1");
  for (const chapterHash of hashes) hash = digest(`${hash}
${chapterHash}`);
  return hash;
}
function chapterSegments(chapter, entry, firstId, offset) {
  const chapterText = `# ${chapter.title}
${entry.text}

`;
  const chars = Array.from(chapterText);
  const segments = [];
  for (let from = 0; from < chars.length; from += SEGMENT_CHARS) {
    const part = chars.slice(from, from + SEGMENT_CHARS).join("");
    const length = Math.min(SEGMENT_CHARS, chars.length - from);
    segments.push({ id: firstId + segments.length, chapter: chapter.title, start: offset, end: offset + length, text: part });
    offset += length;
  }
  return segments;
}
function validateCachedChapter(entry, index, catalogLen) {
  if (entry.index !== index || typeof entry.text !== "string" || entry.text.length < 30 || Buffer.byteLength(entry.text) > 256 * 1024 || entry.hash !== digest(entry.text) || typeof entry.fetchedAt !== "string" || !Number.isFinite(Date.parse(entry.fetchedAt)) || !Array.isArray(entry.pages) || !entry.pages.length || entry.pages.length > 12 || index >= catalogLen) {
    throw new SourceError("invalid_content", "Serial cache is not a contiguous, valid chapter prefix");
  }
  const urls = /* @__PURE__ */ new Set();
  for (const page of entry.pages) {
    if (!page || typeof page.url !== "string" || !page.url || page.url.length > 2e3 || urls.has(page.url) || !/^[0-9a-f]{64}$/.test(page.hash)) {
      throw new SourceError("invalid_content", "Invalid serial page provenance");
    }
    urls.add(page.url);
  }
  if (entry.pages[0].url !== entry.pages[0].url.trim()) throw new SourceError("invalid_content", "Invalid serial page URL");
}
function concatSegments(base, appended) {
  return new Proxy([], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) {
        const index = Number(key);
        if (index < base.length) return base[index];
        return appended[index - base.length];
      }
      if (key === "length") return base.length + appended.length;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < base.length + appended.length;
      return Reflect.has(target, key);
    },
    set() {
      throw new Error("Book segments are immutable");
    }
  });
}
function attachText(book, segments) {
  let cached;
  Object.defineProperty(book, "text", { enumerable: true, configurable: false, get() {
    if (cached === void 0) {
      let text2 = "";
      for (const segment of segments) text2 += segment.text;
      cached = text2;
    }
    return cached;
  } });
}
function buildSerialBook(input, base) {
  const { catalog, serial } = input;
  validateSerialCatalog(catalog, { bookUrl: serial.bookUrl });
  if (!Array.isArray(input.cache) || input.cache.length > catalog.chapters.length || input.cache.length > 2e4) throw new SourceError("invalid_content", "Invalid serial cache length");
  for (let i = 0; i < input.cache.length; i++) validateCachedChapter(input.cache[i], i, catalog.chapters.length);
  const identity = stableSerialIdentity(serial.serialId, serial.editionEpoch);
  if (base) {
    if (!base.remote?.serial || base.key !== identity.key || base.remote.serial.serialId !== serial.serialId || base.remote.serial.editionEpoch !== serial.editionEpoch || base.remote.cache.length > input.cache.length || base.remote.catalog.chapters.length > catalog.chapters.length) throw new SourceError("invalid_content", "Serial append base is not the accepted edition");
    for (let i = 0; i < base.remote.catalog.chapters.length; i++) {
      const a = base.remote.catalog.chapters[i], b = catalog.chapters[i];
      if (chapterId(a) !== chapterId(b) || a.title !== b.title || a.url !== b.url || (a.revision ?? null) !== (b.revision ?? null)) {
        throw new SourceError("invalid_content", "Serial catalog is not a strict append of the accepted snapshot");
      }
    }
    for (let i = 0; i < base.remote.cache.length; i++) if (base.remote.cache[i].hash !== input.cache[i].hash) throw new SourceError("invalid_content", "Serial chapter prefix hash changed");
    const baseEnd = base.remote.cache.length ? base.remote.serial.layout[base.remote.cache.length - 1] : 0;
    if (base.segments.length !== baseEnd) throw new SourceError("invalid_content", "Serial layout does not match the accepted book");
  }
  const startIndex = base?.remote?.cache.length ?? 0;
  const startSegments = base?.segments ?? [];
  const startChars = base?.totalChars ?? 0;
  const appended = [];
  const appendedEnds = [];
  let offset = startChars;
  for (let i = startIndex; i < input.cache.length; i++) {
    const parts = chapterSegments(catalog.chapters[i], input.cache[i], startSegments.length + appended.length, offset);
    appended.push(...parts);
    offset += parts.reduce((n, s) => n + (s.end - s.start), 0);
    appendedEnds.push(startSegments.length + appended.length);
  }
  if (offset > MAX_BOOK_BYTES) throw new SourceError("limit", "Cached novel exceeds the current 100 MiB per-book limit; no text or progress was discarded");
  const segments = base ? concatSegments(startSegments, appended) : appended;
  const cache = base ? [...base.remote.cache, ...input.cache.slice(startIndex).map((c, i) => ({ ...c, index: startIndex + i }))] : input.cache.map((c) => ({ ...c }));
  const layout = base ? [...base.remote.serial.layout, ...appendedEnds] : appendedEnds;
  const sourceHash = serialContentHash(cache.map((c) => c.hash));
  const record = { ...serial, layout };
  validateSerialRecord(record, cache.length, segments.length);
  const remote = {
    catalog: { ...catalog, chapters: catalog.chapters.map((c) => ({ ...c })) },
    cache,
    serial: record
  };
  if (input.lastError) {
    const e = input.lastError;
    if (!["unsupported", "needs_login", "restricted", "missing", "temporary", "invalid_content", "limit", "cancelled"].includes(e.code) || typeof e.message !== "string" || e.message.length > 500 || !Number.isFinite(Date.parse(e.at)) || e.chapterIndex !== cache.length) throw new SourceError("invalid_content", "Invalid source error record");
    remote.lastError = { code: e.code, message: e.message, at: e.at, chapterIndex: e.chapterIndex };
  }
  const book = {
    key: identity.key,
    id: identity.id,
    revision: identity.revision,
    title: catalog.title,
    author: catalog.author,
    filename: "remote.md",
    text: "",
    sourceHash,
    totalChars: offset,
    parserVersion: 1,
    segments,
    remote
  };
  attachText(book, segments);
  return book;
}
function buildRemoteBook(input) {
  if (input?.serial) return buildSerialBook(input);
  const catalog = input?.catalog;
  if (!catalog || catalog.adapter !== "biquge-02345-v1" || typeof catalog.bookUrl !== "string" || catalogUrl(catalog.bookUrl) !== catalog.bookUrl || typeof catalog.title !== "string" || !catalog.title.trim() || catalog.title.length > 200 || typeof catalog.author !== "string" || !catalog.author.trim() || catalog.author.length > 100 || !Number.isInteger(catalog.declaredTotal) || catalog.declaredTotal < 1 || catalog.declaredTotal > 5e3 || !Array.isArray(catalog.chapters) || catalog.chapters.length !== catalog.declaredTotal || typeof catalog.fetchedAt !== "string" || !Number.isFinite(Date.parse(catalog.fetchedAt))) throw new SourceError("invalid_content", "Invalid remote catalog snapshot");
  if (!["finished", "ongoing", "unknown"].includes(catalog.publicationStatus)) throw new SourceError("invalid_content", "Missing source publication status");
  const urls = /* @__PURE__ */ new Set();
  for (const chapter of catalog.chapters) {
    if (!chapter || typeof chapter.title !== "string" || !chapter.title.trim() || chapter.title.length > 200 || typeof chapter.url !== "string" || sourceUrl(chapter.url).origin !== sourceUrl(catalog.bookUrl).origin || !/^\d+\/$/.test(new URL(chapter.url).pathname.slice(new URL(catalog.bookUrl).pathname.length)) || !chapter.url.startsWith(catalog.bookUrl) || urls.has(chapter.url)) throw new SourceError("invalid_content", "Invalid remote chapter URL or identity");
    urls.add(chapter.url);
  }
  if (catalog.hash !== catalogHash(catalog) || !Array.isArray(input.cache) || input.cache.length > catalog.chapters.length) throw new SourceError("invalid_content", "Catalog hash or cache length does not match");
  const segments = [];
  let text2 = "";
  let offset = 0;
  const cache = input.cache.map((entry, index) => {
    if (entry.index !== index || typeof entry.text !== "string" || entry.text.length < 30 || Buffer.byteLength(entry.text) > 256 * 1024 || entry.hash !== digest(entry.text) || typeof entry.fetchedAt !== "string" || !Number.isFinite(Date.parse(entry.fetchedAt)) || !Array.isArray(entry.pages) || !entry.pages.length || entry.pages.length > 12) throw new SourceError("invalid_content", "Remote cache is not a contiguous, valid chapter prefix");
    const chapter = catalog.chapters[index];
    for (let page = 0; page < entry.pages.length; page++) {
      const expected = page === 0 ? chapter.url : chapter.url.replace(/\/$/, `_${page + 1}/`);
      if (entry.pages[page].url !== expected || !/^[0-9a-f]{64}$/.test(entry.pages[page].hash)) throw new SourceError("invalid_content", "Invalid cached page provenance");
    }
    const chapterText = `# ${chapter.title}
${entry.text}

`;
    const chars = Array.from(chapterText);
    for (let from = 0; from < chars.length; from += SEGMENT_CHARS) {
      const part = chars.slice(from, from + SEGMENT_CHARS).join("");
      const length = Math.min(SEGMENT_CHARS, chars.length - from);
      segments.push({ id: segments.length, chapter: chapter.title, start: offset, end: offset + length, text: part });
      offset += length;
    }
    text2 += chapterText;
    return { index, text: entry.text, hash: entry.hash, fetchedAt: entry.fetchedAt, pages: entry.pages.map((p) => ({ url: p.url, hash: p.hash })) };
  });
  if (Buffer.byteLength(text2) > MAX_BOOK_BYTES) throw new SourceError("limit", "Cached novel exceeds the current 100 MiB per-book limit; no text or progress was discarded");
  const id = digest(`remote
${catalog.bookUrl}
${catalog.title}
${catalog.author}`);
  const revision = digest(`remote-v1
${catalog.hash}`);
  const remote = { catalog: {
    adapter: catalog.adapter,
    bookUrl: catalog.bookUrl,
    title: catalog.title,
    author: catalog.author,
    declaredTotal: catalog.declaredTotal,
    publicationStatus: catalog.publicationStatus,
    chapters: catalog.chapters.map((c) => ({ title: c.title, url: c.url })),
    fetchedAt: catalog.fetchedAt,
    hash: catalog.hash
  }, cache };
  if (input.lastError) {
    const e = input.lastError;
    if (!["unsupported", "needs_login", "restricted", "missing", "temporary", "invalid_content", "limit", "cancelled"].includes(e.code) || typeof e.message !== "string" || e.message.length > 500 || !Number.isFinite(Date.parse(e.at)) || e.chapterIndex !== cache.length) throw new SourceError("invalid_content", "Invalid source error record");
    remote.lastError = { code: e.code, message: e.message, at: e.at, chapterIndex: e.chapterIndex };
  }
  return {
    key: `${id}:${revision}`,
    id,
    revision,
    title: catalog.title,
    author: catalog.author,
    filename: "remote.md",
    text: text2,
    sourceHash: digest(text2),
    totalChars: offset,
    parserVersion: 1,
    segments,
    remote
  };
}

// src/paged-book.ts
var MAGIC = "BOOKPAGE1\n";
var PAGE_SIZE = 64;
var MAX_PAGE = 2 * 1024 * 1024;
var MAX_MANIFEST = 8 * 1024 * 1024;
var sha = (v) => createHash2("sha256").update(v).digest("hex");
var verified = /* @__PURE__ */ new WeakSet();
var remoteLayouts = /* @__PURE__ */ new WeakMap();
var spansByBook = /* @__PURE__ */ new WeakMap();
var PageCache = class {
  constructor(limit = 4 * 1024 * 1024) {
    this.limit = limit;
  }
  limit;
  pages = /* @__PURE__ */ new Map();
  bytes = 0;
  reads = 0;
  get(key, load3) {
    let item = this.pages.get(key);
    if (item) this.pages.delete(key);
    else {
      item = load3();
      this.reads++;
      if (item.bytes > this.limit) return item.rows;
      this.bytes += item.bytes;
    }
    this.pages.set(key, item);
    while (this.bytes > this.limit && this.pages.size > 1) {
      const key2 = this.pages.keys().next().value;
      this.bytes -= this.pages.get(key2).bytes;
      this.pages.delete(key2);
    }
    return item.rows;
  }
  clear() {
    this.pages.clear();
    this.bytes = 0;
  }
  stats() {
    return { bytes: this.bytes, pages: this.pages.size, reads: this.reads, limit: this.limit };
  }
};
function readAt(file, offset, size) {
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, bytes, at, size - at, offset + at);
      if (!n) throw Error("Truncated paged book");
      at += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function fileHash(file) {
  const fd = openSync(file, "r"), hash = createHash2("sha256");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let n;
    while (n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function writePagedStream(dir, metadata, segments, remote) {
  const temporary = dir + "/" + randomUUID() + ".tmp", fd = openSync(temporary, "wx");
  let offset = 0;
  const write = (b) => {
    let at = 0;
    while (at < b.length) at += writeSync(fd, b, at, b.length - at);
    offset += b.length;
  };
  const page = (rows) => {
    const raw = Buffer.from(JSON.stringify(rows));
    if (raw.length > MAX_PAGE) throw Error("Book page oversized");
    const compressed = gzipSync(raw), p = { offset, size: compressed.length, hash: sha(raw), count: rows.length };
    write(compressed);
    return p;
  };
  const manifest = { book: {}, segments: [], chapters: [], count: 0, cacheCount: remote?.cache.length ?? 0, spans: [] };
  try {
    write(Buffer.from(MAGIC));
    let rows = [];
    for (const s of segments) {
      if (s.id !== manifest.count || manifest.count >= 2e5) throw Error("Book has too many or inconsistent chapter ranges (maximum 200000)");
      manifest.count++;
      const previous = manifest.spans.at(-1);
      if (previous?.chapter === s.chapter) {
        previous.last = s.id;
        previous.end = s.end;
      } else manifest.spans.push({ first: s.id, last: s.id, start: s.start, end: s.end, chapter: s.chapter });
      rows.push(s);
      if (rows.length === PAGE_SIZE) {
        manifest.segments.push(page(rows));
        rows = [];
      }
    }
    if (rows.length) manifest.segments.push(page(rows));
    for (const chapter of remote?.cache ?? []) manifest.chapters.push(page([chapter]));
    manifest.book = { ...metadata(), ...remote ? { remote: { catalog: remote.catalog, ...remote.serial ? { serial: remote.serial } : {}, ...remote.lastError ? { lastError: remote.lastError } : {} } } : {} };
    const json = Buffer.from(JSON.stringify(manifest));
    if (json.length > MAX_MANIFEST) throw Error("Book manifest oversized");
    write(json);
    const footer = Buffer.alloc(8);
    footer.writeBigUInt64LE(BigInt(json.length));
    write(footer);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    const id = fileHash(temporary), target = dir + "/" + id + ".json.gz";
    if (existsSync(target)) unlinkSync(temporary);
    else renameSync(temporary, target);
    return id;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function loadPagedBook(file, id, cache, validatedLocal) {
  const trusted = !!validatedLocal;
  if (validatedLocal) {
    const st = statSync(file);
    if (st.size !== validatedLocal.size || st.mtimeMs !== validatedLocal.mtimeMs) throw Error("Validated import changed");
  } else if (fileHash(file) !== id) throw Error("Book blob checksum mismatch");
  const size = statSync(file).size;
  if (size < 18) throw Error("Truncated book");
  const length = Number(readAt(file, size - 8, 8).readBigUInt64LE());
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_MANIFEST || length > size - 18) throw Error("Invalid book manifest");
  const manifest = JSON.parse(readAt(file, size - 8 - length, length).toString("utf8"));
  if (!manifest.book || !Number.isSafeInteger(manifest.count) || manifest.count < 0 || manifest.count > 2e5 || !Number.isSafeInteger(manifest.cacheCount) || manifest.cacheCount < 0 || manifest.cacheCount > 2e4 || !Array.isArray(manifest.segments) || manifest.segments.length !== Math.ceil(manifest.count / PAGE_SIZE) || !Array.isArray(manifest.chapters) || manifest.chapters.length !== manifest.cacheCount || !Array.isArray(manifest.spans) || manifest.spans.length > 2e5) throw Error("Invalid paged book index");
  let expectedOffset = MAGIC.length;
  for (const [i, p] of [...manifest.segments, ...manifest.chapters].entries()) {
    const count = i < manifest.segments.length ? Math.min(PAGE_SIZE, manifest.count - i * PAGE_SIZE) : 1;
    if (p.offset !== expectedOffset || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_PAGE || p.count !== count || !/^[a-f0-9]{64}$/.test(p.hash)) throw Error("Invalid book page location");
    expectedOffset += p.size;
  }
  if (expectedOffset !== size - 8 - length) throw Error("Invalid book page coverage");
  const load3 = (p) => {
    const raw = gunzipSync(readAt(file, p.offset, p.size), { maxOutputLength: MAX_PAGE });
    if (sha(raw) !== p.hash) throw Error("Book page checksum mismatch");
    const rows = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(rows) || rows.length !== p.count) throw Error("Invalid book page rows");
    return { rows, bytes: raw.length * 2 + rows.length * 256 };
  };
  let chars = 0, bytes = 0, index = 0;
  const source = createHash2("sha256"), revision = createHash2("sha256").update("1\n");
  const spans = [];
  if (!trusted) for (const p of manifest.segments) {
    const rows = load3(p).rows;
    for (const s of rows) {
      if (!s || Object.keys(s).length !== 5 || s.id !== index++ || typeof s.chapter !== "string" || s.chapter.length > 200 || typeof s.text !== "string" || !s.text.length || /[\x00-\x08\x0b\x0c\x0e-\x1f\r]/.test(s.text) || s.start !== chars || Array.from(s.text).length > 1200 || s.end !== s.start + Array.from(s.text).length) throw Error("Invalid paged segment");
      chars = s.end;
      bytes += Buffer.byteLength(s.text);
      source.update(s.text);
      revision.update(s.text);
      const previous = spans.at(-1);
      if (previous?.chapter === s.chapter) {
        previous.last = s.id;
        previous.end = s.end;
      } else spans.push({ first: s.id, last: s.id, start: s.start, end: s.end, chapter: s.chapter });
    }
  }
  const b = manifest.book;
  const serial = b.remote?.serial;
  if (!trusted && (bytes > 100 * 1024 * 1024 || chars !== b.totalChars || !serial && source.digest("hex") !== b.sourceHash || b.parserVersion !== 1 || typeof b.title !== "string" || !b.title.trim() || b.title.length > 200 || typeof b.author !== "string" || b.author.length > 100 || b.key !== b.id + ":" + b.revision || JSON.stringify(spans) !== JSON.stringify(manifest.spans))) throw Error("Paged book content is inconsistent");
  if (!trusted && !b.remote && (sha(b.title.normalize("NFC") + "\n" + b.author.normalize("NFC")) !== b.id || revision.digest("hex") !== b.revision || typeof b.filename !== "string" || !/^([^\\/\x00-\x1f]+)\.(txt|md|epub|pdf)$/i.test(b.filename))) throw Error("Paged book identity mismatch");
  function virtual(count, pages, width) {
    return new Proxy(new Array(count), { get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) {
        const n = Number(key);
        if (n >= count) return void 0;
        const p = pages[Math.floor(n / width)];
        return cache.get(id + ":" + p.offset, () => load3(p))[n % width];
      }
      return Reflect.get(target, key, receiver);
    }, has(target, key) {
      return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) < count : Reflect.has(target, key);
    }, set() {
      throw Error("Book pages are immutable");
    } });
  }
  const segments = virtual(manifest.count, manifest.segments, PAGE_SIZE);
  const book = { ...b, segments };
  if (b.remote) book.remote = { ...b.remote, cache: virtual(manifest.cacheCount, manifest.chapters, 1) };
  if (!book.remote && !trusted) {
    if (!manifest.count || segments[0].text !== segments[0].text.trimStart() || segments[manifest.count - 1].text !== segments[manifest.count - 1].text.trimEnd()) throw Error("Noncanonical source whitespace");
    const chunks = function* () {
      for (const segment of segments) yield segment.text;
    };
    let index2 = 0;
    for (const expected of streamIndex(chunks)) {
      const actual = segments[index2++];
      if (!actual || actual.id !== expected.id || actual.chapter !== expected.chapter || actual.start !== expected.start || actual.end !== expected.end || actual.text !== expected.text) throw Error("Canonical segment index mismatch");
    }
    if (index2 !== manifest.count) throw Error("Canonical segment count mismatch");
  }
  if (book.remote) {
    const remote = book.remote;
    if (serial) {
      const identity = stableSerialIdentity(serial.serialId, serial.editionEpoch);
      if (book.key !== identity.key || book.id !== identity.id || book.revision !== identity.revision) throw Error("Serial book identity mismatch");
      validateSerialCatalog(remote.catalog, { bookUrl: serial.bookUrl });
      if (remote.catalog.title !== book.title || remote.catalog.author !== book.author || manifest.cacheCount !== serial.layout.length) throw Error("Serial book catalog mismatch");
      validateSerialRecord(serial, manifest.cacheCount, manifest.count);
      const hashes = [];
      let chapterIndex = 0;
      for (const chapter of remote.cache) {
        if (chapter.index !== chapterIndex++) throw Error("Noncontiguous serial cache");
        hashes.push(chapter.hash);
      }
      if (chapterIndex !== manifest.cacheCount || serialContentHash(hashes) !== book.sourceHash) throw Error("Serial content digest mismatch");
      remoteLayouts.set(book, { ends: [...serial.layout], lastFetchedAt: remote.cache.at(-1)?.fetchedAt ?? null });
    } else {
      const base = buildRemoteBook({ catalog: remote.catalog, cache: [] });
      if (base.key !== book.key || base.title !== book.title || base.author !== book.author || manifest.cacheCount > remote.catalog.chapters.length) throw Error("Remote book identity mismatch");
      let segmentId = 0, offset = 0, lastFetchedAt = null;
      const ends = [];
      let chapterIndex = 0;
      for (const chapter of remote.cache) {
        if (chapter.index !== chapterIndex++) throw Error("Noncontiguous remote cache");
        const number = remote.catalog.chapters[chapter.index];
        if (!number) throw Error("Invalid remote chapter index");
        const catalog = { ...remote.catalog, declaredTotal: 1, chapters: [number] };
        catalog.hash = catalogHash(catalog);
        const rebuilt = buildRemoteBook({ catalog, cache: [{ ...chapter, index: 0 }] });
        for (const part of rebuilt.segments) {
          const actual = segments[segmentId];
          if (!actual || actual.id !== segmentId || actual.chapter !== part.chapter || actual.text !== part.text || actual.start !== offset + part.start || actual.end !== offset + part.end) throw Error("Remote segment index mismatch");
          segmentId++;
        }
        offset += rebuilt.totalChars;
        ends.push(segmentId);
        lastFetchedAt = chapter.fetchedAt;
      }
      remoteLayouts.set(book, { ends, lastFetchedAt });
      if (segmentId !== manifest.count) throw Error("Remote cache coverage mismatch");
    }
    if (remote.lastError) {
      const e = remote.lastError;
      if (!["unsupported", "needs_login", "restricted", "missing", "temporary", "invalid_content", "limit", "cancelled"].includes(e.code) || typeof e.message !== "string" || e.message.length > 500 || !Number.isFinite(Date.parse(e.at)) || e.chapterIndex !== remote.cache.length) throw Error("Invalid source error record");
    }
  }
  Object.defineProperty(book, "text", { enumerable: true, get() {
    let text2 = "";
    for (const segment of segments) text2 += segment.text;
    return text2;
  } });
  verified.add(book);
  spansByBook.set(book, trusted ? manifest.spans : spans);
  return book;
}

// src/txt-acquisition/repair.ts
var COMMON_CHARS = /* @__PURE__ */ new Set([..."\u7684\u4E00\u662F\u4E86\u6211\u4E0D\u4EBA\u5728\u4ED6\u6709\u8FD9\u4E2A\u4E0A\u4EEC\u6765\u5230\u65F6\u5927\u5730\u4E3A\u5B50\u4E2D\u4F60\u8BF4\u751F\u56FD\u5E74\u7740\u5C31\u90A3\u548C\u8981\u5979\u51FA\u4E5F\u5F97\u91CC\u540E\u81EA\u4EE5\u4F1A\u5BB6\u53EF\u4E0B\u800C\u8FC7\u5929\u53BB\u80FD\u5BF9\u5C0F\u591A\u7136\u4E8E\u5FC3\u5B66\u4E48\u4E4B\u90FD\u597D\u770B\u8D77\u53D1\u5F53\u6CA1\u6210\u53EA\u5982\u4E8B\u628A\u8FD8\u7528\u7B2C\u6837\u9053\u60F3\u4F5C\u79CD\u5F00\u7F8E\u603B\u4ECE\u65E0\u60C5\u5DF1\u9762\u6700\u5973\u4F46\u73B0\u524D\u4E9B\u6240\u540C\u65E5\u624B\u53C8\u884C\u610F\u52A8\u65B9\u671F\u5B83\u5934\u7ECF\u957F\u513F\u56DE\u4F4D\u5206\u7231\u8001\u56E0\u5F88\u7ED9\u540D\u6CD5\u95F4\u65AF\u77E5\u4E16\u4EC0\u4E24\u6B21\u4F7F\u8EAB\u8005\u88AB\u9AD8\u5DF2\u4EB2\u5176\u8FDB\u6B64\u8BDD\u5E38\u4E0E\u6D3B\u6B63\u611F\u89C1\u660E\u95EE\u529B\u7406\u5C14\u70B9\u6587\u51E0\u5B9A\u672C\u516C\u7279\u505A\u5916\u5B69\u76F8\u897F\u679C\u8D70\u5C06\u6708\u5341\u5B9E\u5411\u58F0\u8F66\u5168\u4FE1\u91CD\u4E09\u673A\u5DE5\u7269\u6C14\u6BCF\u5E76\u522B\u771F\u6253\u592A\u65B0\u6BD4\u624D\u4FBF\u592B\u518D\u4E66\u90E8\u6C34\u50CF\u773C\u7B49\u4F53\u5374\u52A0\u7535\u4E3B\u754C\u95E8\u5229\u6D77\u53D7\u542C\u8868\u5FB7\u5C11\u514B\u4EE3\u5458\u8BB8\u7A1C\u5148\u53E3\u7531\u6B7B\u5B89\u5199\u6027\u9A6C\u5149\u767D\u6216\u4F4F\u96BE\u671B\u6559\u547D\u82B1\u7ED3\u4E50\u8272\u66F4\u62C9\u4E1C\u795E\u8BB0\u5904\u8BA9\u6BCD\u7236\u5E94\u76F4\u5B57\u573A\u5E73\u62A5\u53CB\u5173\u653E\u81F3\u5F20\u8BA4\u63A5\u544A\u5165\u7B11\u5185\u82F1\u519B\u5019\u6C11\u5C81\u5F80\u4F55\u5EA6\u5C71\u89C9\u8DEF\u5E26\u4E07\u7537\u8FB9\u98CE\u89E3\u53EB\u4EFB\u91D1\u5FEB\u539F\u5403\u5988\u53D8\u901A\u5E08\u7ACB\u8C61\u6570\u56DB\u5931\u6EE1\u6218\u8FDC\u683C\u58EB\u97F3\u8F7B\u76EE\u6761\u5462\u75C5\u59CB\u8FBE\u6DF1\u5B8C\u4ECA\u63D0\u6C42\u6E05\u738B\u5316\u7A7A\u4E1A\u601D\u5207\u600E\u975E\u627E\u7247\u7F57\u94B1\u7D36\u5417\u8BED\u5143\u559C\u66FE\u79BB\u98DE\u79D1\u8A00\u5E72\u6D41\u6B22\u7EA6\u5404\u5373\u6307\u5408\u53CD\u9898\u5FC5\u8BE5\u8BBA\u4EA4\u7EC8\u6797\u8BF7\u533B\u665A\u5236\u7403\u51B3\u7AA2\u4F20\u753B\u4FDD\u8BFB\u8FD0\u53CA\u5219\u623F\u65E9\u9662\u91CF\u82E6\u706B\u5E03\u54C1\u8FD1\u5750\u4EA7\u7B54\u661F\u7CBE\u89C6\u4E94\u8FDE\u53F8\u5DF4\u5947\u7BA1\u7C7B\u672A\u670B\u4E14\u5A5A\u53F0\u591C\u9752\u5317\u961F\u4E45\u4E4E\u8D8A\u89C2\u843D\u5C3D\u5F62\u5F71\u7EA2\u7238\u767E\u4EE4\u5468\u5427\u8BC6\u6B65\u5E0C\u4E9A\u672F\u7559\u5E02\u534A\u70ED\u9001\u5174\u9020\u8C08\u5BB9\u6781\u968F\u6F14\u6536\u9996\u6839\u8BB2\u6574\u5F0F\u53D6\u7167\u529E\u5F3A\u77F3\u53E4\u534E\u8AE3\u62FF\u8BA1\u60A8\u88C5\u4F3C\u8DB3\u53CC\u59BB\u5C3C\u8F6C\u8BC9\u7C73\u79F0\u4E3D\u5BA2\u5357\u9886\u8282\u8863\u7AD9\u9ED1\u523B\u7EDF\u65AD\u798F\u57CE\u6545\u5386\u60CA\u8138\u9009\u5305\u7D27\u4E89\u53E6\u5EFA\u7EF4\u7EDD\u6811\u7CFB\u4F24\u793A\u613F\u6301\u5343\u53F2\u8C01\u51C6\u8054\u5987\u7EAA\u57FA\u4E70\u5FD7\u9759\u963F\u8BD7\u72EC\u590D\u75DB\u6D88\u793E\u7B97\u4E49\u7ADF\u786E\u9152\u9700\u5355\u6CBB\u5361\u5E78\u5170\u5FF5\u4E3E\u4EC5\u949F\u6015\u5171\u6BDB\u53E5\u606F\u529F\u5B98\u5F85\u7A76\u8DDF\u7A7F\u5BA4\u6613\u6E38\u7A0B\u53F7\u5C45\u8003\u7A81\u76AE\u54EA\u8D39\u5012\u4EF7\u56FE\u5177\u521A\u8111\u6C38\u6B4C\u54CD\u5546\u793C\u7EC6\u4E13\u9EC4\u5757\u811A\u5473\u7075\u6539\u636E\u822C\u7834\u5F15\u98DF\u4ECD\u5B58\u4F17\u6CE8\u7B14\u751A\u67D0\u6C89\u8840\u5907\u4E60\u6821\u9ED8\u52A1\u571F\u5FAE\u5A18\u987B\u8BD5\u6000\u6599\u8C03\u5E7F\u82CF\u663E\u8D5B\u67E5\u5BC6\u8BAE\u5E95\u5217\u5BCC\u68A6\u9519\u5EA7\u53C2\u516B\u9664\u8DD1\u4EAE\u5047\u5370\u8BBE\u7EBF\u6E29\u867D\u6389\u4EAC\u521D\u517B\u9999\u505C\u9645\u81F4\u9633\u7EB8\u674E\u7EB3\u9A8C\u52A9\u6FC0\u591F\u4E25\u8BC1\u5E1D\u996D\u5FD8\u8DA3\u652F\u6625\u96C6\u4E08\u6728\u7814\u73ED\u666E\u5BFC\u987F\u7761\u5C55\u8DF3\u83B7\u827A\u516D\u6CE2\u5BDF\u7FA4\u7687\u6BB5\u6025\u5EAD\u521B\u533A\u5965\u5668\u8C22\u5F1F\u5E97\u5426\u5BB3\u8349\u6392\u80CC\u6B62\u7EC4\u5DDE\u671D\u5C01\u775B\u677F\u89D2\u51B5\u66F2\u9986\u80B2\u5FD9\u8D28\u6CB3\u7EED\u54E5\u547C\u82E5\u63A8\u5883\u9047\u96E8\u6807\u59D0\u5145\u56F4\u6848\u4F26\u62A4\u51B7\u8B66\u8D1D\u8457\u96EA\u7D22\u5267\u554A\u8239\u9669\u70DF\u4F9D\u6597\u503C\u5E2E\u6C49\u6162\u4F5B\u80AF\u95FB\u5531\u6C99\u5C40\u4F2F\u65CF\u4F4E\u73A9\u8D44\u5C4B\u51FB\u901F\u987E\u6CEA\u6D32\u56E2\u5723\u65C1\u5802\u5175\u4E03\u9732\u56ED\u725B\u54ED\u65C5\u8857\u52B3\u578B\u70C8\u59D1\u9648\u83AB\u9C7C\u5F02\u62B1\u5B9D\u6743\u9C81\u7B80\u6001\u7EA7\u7968\u602A\u5BFB\u6740\u5F8B\u80DC\u4EFD\u6C7D\u53F3\u6D0B\u8303\u5E8A\u821E\u79D8\u5348\u767B\u697C\u8D35\u5438\u8D23\u4F8B\u8FFD\u8F83\u804C\u5C5E\u6E10\u5DE6\u5F55\u4E1D\u7259\u515A\u7EE7\u6258\u8D76\u7AE0\u667A\u51B2\u53F6\u80E1\u5409\u5356\u575A\u559D\u8089\u9057\u6551\u4FEE\u677E\u4E34\u85CF\u62C5\u620F\u5584\u536B\u836F\u60B2\u6562\u9760\u4F0A\u6751\u6234\u8BCD\u68EE\u8033\u5DEE\u77ED\u7956\u4E91\u89C4\u7A97\u6563\u8FF7\u6CB9\u65E7\u9002\u4E61\u67B6\u6069\u6295\u5F39\u94C1\u535A\u96F7\u5E9C\u538B\u8D85\u8D1F\u52D2\u6742\u9192\u6D17\u91C7\u6BEB\u5634\u6BD5\u4E5D\u51B0\u65E2\u72B6\u4E71\u666F\u5E2D\u73CD\u7AE5\u9876\u6D3E\u7D20\u8131\u519C\u7591\u7EC3\u91CE\u6309\u72AF\u62CD\u5F81\u574F\u9AA8\u4F59\u627F\u7F6E\u85CF"]);

// src/stream-import.ts
var TEXT_ENCODING_ERROR = "Book must use UTF-8, GB18030 or UTF-16 encoding";
var TEXT_ENCODING_DAMAGED = "Book must use UTF-8, GB18030 or UTF-16 encoding; too many undecodable bytes (the file looks damaged or mixed-encoded)";
function detectEncoding2(prefix) {
  if (prefix.length >= 3 && prefix[0] === 239 && prefix[1] === 187 && prefix[2] === 191) return "utf-8";
  if (prefix.length >= 2 && prefix[0] === 255 && prefix[1] === 254) return "utf-16le";
  if (prefix.length >= 2 && prefix[0] === 254 && prefix[1] === 255) return "utf-16be";
  const utf8Damage = countReplacement(new TextDecoder2("utf-8", { fatal: false }).decode(prefix));
  if (utf8Damage <= Math.max(2, Math.floor(prefix.length * 2e-3))) return "utf-8";
  const gbDamage = countReplacement(new TextDecoder2("gb18030", { fatal: false }).decode(prefix));
  if (gbDamage * 10 < utf8Damage) return "gb18030";
  throw Error(TEXT_ENCODING_ERROR);
}
function repairBudget(chars) {
  return Math.max(16, Math.floor(chars * 5e-4));
}
function countReplacement(text2) {
  let n = 0;
  for (let i = 0; i < text2.length; i += 1) if (text2.charCodeAt(i) === 65533) n += 1;
  return n;
}
function canonicalize(source, target, chunkBytes, progress) {
  const size = statSync2(source).size;
  if (!size || size > MAX_BOOK_BYTES) throw Error("Book must be between 1 byte and 100 MiB");
  const input = openSync2(source, "r");
  let output;
  try {
    output = openSync2(target, "wx");
  } catch (error) {
    closeSync2(input);
    throw error;
  }
  let bytes = 0, lastGood = 0, offset = 0, started = false, pendingCR = false, chars = 0, repairs = 0, lastChar = "";
  let decoder;
  const emit = (part) => {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(part)) throw Error("Binary or control characters are not supported");
    if (pendingCR) {
      part = "\r" + part;
      pendingCR = false;
    }
    if (part.endsWith("\r")) {
      part = part.slice(0, -1);
      pendingCR = true;
    }
    part = part.replace(/\r\n?/g, "\n");
    if (!started) {
      part = part.trimStart();
      if (part) started = true;
    }
    if (!part) return;
    const data = Buffer.from(part), trimmed = part.trimEnd();
    if (trimmed) lastGood = offset + Buffer.byteLength(trimmed);
    let at = 0;
    while (at < data.length) at += writeSync2(output, data, at, data.length - at);
    offset += data.length;
  };
  const take = (part) => {
    chars += part.length;
    for (let i = 0; i < part.length; i++) if (part.charCodeAt(i) === 65533) repairs++;
    const trimmed = part.trimEnd();
    if (trimmed) lastChar = Array.from(trimmed).at(-1) ?? "";
    emit(part);
  };
  try {
    const headSize = Math.min(size, 64 * 1024), head = Buffer.alloc(headSize);
    let n = readSync2(input, head, 0, headSize, null);
    if (!n) throw Error("Book has no readable text");
    const first = head.subarray(0, n);
    decoder = new TextDecoder2(detectEncoding2(first), { fatal: false });
    bytes = n;
    take(decoder.decode(first, { stream: true }));
    progress?.(bytes, size);
    const buffer = Buffer.alloc(chunkBytes);
    while (n = readSync2(input, buffer, 0, buffer.length, null)) {
      bytes += n;
      if (bytes > MAX_BOOK_BYTES) throw Error("Book exceeds 100 MiB");
      take(decoder.decode(buffer.subarray(0, n), { stream: true }));
      if (repairs > repairBudget(chars)) throw Error(TEXT_ENCODING_DAMAGED);
      progress?.(bytes, size);
    }
    take(decoder.decode());
    if (pendingCR) {
      pendingCR = false;
      take("\n");
    }
    if (repairs > 0) {
      if (lastChar === "\uFFFD") throw Error(TEXT_ENCODING_ERROR);
      if (repairs > repairBudget(chars)) throw Error(TEXT_ENCODING_DAMAGED);
    }
    if (bytes !== size) throw Error("Source file changed while importing");
    if (!lastGood) throw Error("Book has no readable text");
    ftruncateSync(output, lastGood);
    fsyncSync2(output);
  } finally {
    closeSync2(input);
    closeSync2(output);
  }
}
function* fileText(file, chunkBytes) {
  const fd = openSync2(file, "r"), decoder = new TextDecoder2("utf-8", { fatal: true });
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let n;
    while (n = readSync2(fd, buffer, 0, buffer.length, null)) {
      const text2 = decoder.decode(buffer.subarray(0, n), { stream: true });
      if (text2) yield text2;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    closeSync2(fd);
  }
}
function importFileBlob(dir, file, metadata, chunkBytes = 16 * 1024, progress) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw Error("Invalid import buffer size");
  const identity = buildBook(metadata.filename, metadata.title, metadata.author, "x");
  const canonical = join(dir, randomUUID2() + ".canonical.tmp");
  try {
    canonicalize(file, canonical, chunkBytes, (n, total) => progress?.("normalize", n, total));
    progress?.("index", 0, statSync2(canonical).size);
    const sourceHash = createHash3("sha256"), revision = createHash3("sha256").update("1\n");
    let totalChars = 0, indexBytes = 0;
    const canonicalBytes = statSync2(canonical).size;
    function* segments() {
      for (const segment of streamIndex(() => fileText(canonical, chunkBytes))) {
        sourceHash.update(segment.text);
        revision.update(segment.text);
        totalChars = segment.end;
        indexBytes += Buffer.byteLength(segment.text);
        progress?.("index", indexBytes, canonicalBytes);
        yield segment;
      }
    }
    return writePagedStream(dir, () => {
      const rev = revision.digest("hex");
      return { key: identity.id + ":" + rev, id: identity.id, revision: rev, title: identity.title, author: identity.author, filename: identity.filename, sourceHash: sourceHash.digest("hex"), totalChars, parserVersion: 1 };
    }, segments());
  } finally {
    if (existsSync2(canonical)) unlinkSync2(canonical);
  }
}

// src/import-worker.ts
var last = 0;
var report = (stage, done, total, force = false) => {
  const now = Date.now();
  if (force || now - last >= 100) {
    last = now;
    parentPort.postMessage({ type: "progress", stage, done, total });
  }
};
async function run() {
  const { dir, file, metadata } = workerData;
  let actualMetadata = metadata;
  let sourceFile = file;
  let temp;
  try {
    const name = String(metadata.filename ?? "");
    if (/\.epub$/i.test(name) || /\.epub$/i.test(file)) {
      const book = parseEpub(readFileSync(file));
      actualMetadata = { ...metadata };
      if (book.title && (metadata.autoMetadata === true || !actualMetadata.title)) actualMetadata.title = book.title;
      if (book.author && !actualMetadata.author) actualMetadata.author = book.author;
      temp = join2(dir, randomUUID3() + ".epub.md");
      writeFileSync2(temp, book.markdown, "utf8");
      sourceFile = temp;
    } else if (/\.pdf$/i.test(name) || /\.pdf$/i.test(file)) {
      const book = await parsePdf(new Uint8Array(readFileSync(file)));
      actualMetadata = { ...metadata };
      if (book.title && (metadata.autoMetadata === true || !actualMetadata.title)) actualMetadata.title = book.title;
      if (book.author && !actualMetadata.author) actualMetadata.author = book.author;
      temp = join2(dir, randomUUID3() + ".pdf.md");
      writeFileSync2(temp, book.markdown, "utf8");
      sourceFile = temp;
    } else if (metadata.autoMetadata === true) {
      const fd = openSync3(file, "r");
      try {
        const prefix = Buffer.alloc(16 * 1024), n = readSync3(fd, prefix, 0, prefix.length, 0);
        actualMetadata = { ...metadata, ...detectImportMetadata(metadata.filename, new TextDecoder("utf-8").decode(prefix.subarray(0, n))) };
      } finally {
        closeSync3(fd);
      }
    }
    const id = importFileBlob(dir, sourceFile, actualMetadata, 16 * 1024, (stage, n, total) => report(stage, n, total));
    report("validate", 0, 1, true);
    const output = join2(dir, id + ".json.gz");
    loadPagedBook(output, id, new PageCache());
    const st = statSync3(output);
    parentPort.postMessage({ type: "done", id, receipt: { size: st.size, mtimeMs: st.mtimeMs } });
  } finally {
    if (temp && existsSync3(temp)) unlinkSync3(temp);
  }
}
run().catch((error) => parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) }));
