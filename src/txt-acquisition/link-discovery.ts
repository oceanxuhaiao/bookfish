/**
 * Link discovery: find TXT/Markdown candidates on an already rendered page.
 * This is link extraction, not a search engine — the model supplies the page.
 */
import * as cheerio from 'cheerio';
import { MAX_DISCOVERY_LINKS, type DiscoveredLink, type FileFormat } from './types.ts';

const FILE_EXTENSION = /\.(txt|md|markdown)$/iu;
const TEXT_EXTENSION = /\.(txt|md|markdown)(?:$|[?#])/iu;

function cleanFilename(raw: string): string {
  let name = raw;
  try { name = decodeURIComponent(raw); } catch { /* keep as-is */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '_').replace(/\s+/gu, ' ').trim();
  return name.slice(0, 160) || 'novel.txt';
}

function formatOf(name: string): FileFormat {
  return /\.md$|\.markdown$/iu.test(name) ? 'md' : 'txt';
}

/** Pull a title/author pair out of anchor text or file name. */
export function extractIdentity(raw: string): { title?: string; author?: string; size?: number } {
  const text = raw.replace(/\s+/gu, ' ').trim();
  const out: { title?: string; author?: string; size?: number } = {};
  const book = /《([^》]{1,80})》/u.exec(text);
  if (book?.[1]) out.title = book[1].trim();
  const titleField = /(?:书名|标题|作品)\s*[:：]\s*([^\s,，;；|]{1,80})/u.exec(text);
  if (!out.title && titleField?.[1]) out.title = titleField[1].trim();
  const authorField = /(?:作者|著者)\s*[:：]\s*([^\s,，;；|]{1,40})/u.exec(text);
  if (authorField?.[1]) out.author = authorField[1].trim();
  const size = /([0-9]+(?:\.[0-9]+)?)\s*(GB|MB|KB|B)\b/iu.exec(text);
  if (size?.[1] && size[2]) {
    const unit = size[2].toUpperCase();
    const factor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
    out.size = Math.round(Number(size[1]) * factor);
  }
  // Anchor text and file name are concatenated, so a trailing extension can cling
  // to the author field ("作者：小鱼.txt"); the extension is not part of the name.
  if (out.author) out.author = out.author.replace(FILE_EXTENSION, '').trim() || undefined;
  if (!out.author) delete out.author;
  if (out.title) out.title = out.title.replace(FILE_EXTENSION, '').trim() || undefined;
  if (!out.title) delete out.title;
  return out;
}

export interface DiscoveryResult { links: DiscoveredLink[]; truncated: boolean; total: number }

export function discoverLinks(html: string, baseUrl: string, maxLinks = MAX_DISCOVERY_LINKS): DiscoveryResult {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: DiscoveredLink[] = [];
  let total = 0;
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    let resolved: URL;
    try { resolved = new URL(href.trim(), baseUrl); } catch { return; }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
    const pathname = resolved.pathname;
    const downloadName = $(element).attr('download');
    const looksLikeFile = FILE_EXTENSION.test(pathname) || TEXT_EXTENSION.test(resolved.search) || (downloadName ? FILE_EXTENSION.test(downloadName) : false);
    if (!looksLikeFile) return;
    resolved.hash = '';
    const key = resolved.toString();
    if (seen.has(key)) return;
    seen.add(key);
    total += 1;
    if (links.length >= maxLinks) return;
    const baseName = pathname.split('/').filter(Boolean).pop() ?? downloadName ?? 'novel.txt';
    const filename = cleanFilename(downloadName ?? baseName);
    const anchorText = $(element).text().replace(/\s+/gu, ' ').trim();
    const identity = extractIdentity(`${anchorText} ${filename}`);
    links.push({
      url: key,
      filename,
      format: formatOf(filename),
      ...(identity.title ? { title: identity.title } : {}),
      ...(identity.author ? { author: identity.author } : {}),
      ...(identity.size ? { size: identity.size } : {}),
      ...(anchorText ? { label: anchorText.slice(0, 120) } : {}),
    });
  });
  return { links, truncated: total > links.length, total };
}
