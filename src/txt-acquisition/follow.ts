/**
 * One-step follow for discovery: when a result page only links to another
 * download page, open that one page and look again.
 *
 * Bounded on purpose: a small candidate list, same-site links first, no
 * further crawling, and pages that ask for a login, payment or verification
 * are not treated as download pages.
 */
import * as cheerio from 'cheerio';

const DIRECT_FILE = /\.(txt|md|markdown)(?:$|[?#])/iu;
const STRONG_HINT = /(?:下载|download)[^。！？\n]{0,8}(?:txt|全本|精校|文件|附件|电子书)|(?:txt|全本|精校|电子书)[^。！？\n]{0,8}(?:下载|download)|网盘|提取码|附件下载/iu;
const WEAK_HINT = /下载|download|附件|资源|文件/iu;
const BLOCKED_HINT = /登录|登陆|注册|付费|购买|充值|验证码|人机验证|sign in|log in|pay|subscribe/iu;
const TWO_LEVEL_SUFFIXES = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'org.uk', 'co.jp', 'com.tw', 'com.hk', 'com.sg']);

export function registrableHost(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./u, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

export interface DownloadPageLink { url: string; sameSite: boolean; strong: boolean }

/** Pick at most `limit` pages that look like download pages, same site first. */
export function pickDownloadPages(html: string, baseUrl: string, limit = 3): DownloadPageLink[] {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const found = new Map<string, DownloadPageLink>();
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    let url: URL;
    try { url = new URL(href.trim(), base); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (url.href === base.href || url.hash === base.href) return;
    if (DIRECT_FILE.test(url.pathname) || DIRECT_FILE.test(url.search)) return;
    const text = $(element).text().replace(/\s+/gu, ' ').trim().slice(0, 200);
    const path = (() => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } })();
    const label = `${text} ${path}`;
    if (BLOCKED_HINT.test(label)) return;
    const strong = STRONG_HINT.test(label);
    if (!strong && !WEAK_HINT.test(label)) return;
    if (found.has(url.href)) return;
    found.set(url.href, { url: url.href, sameSite: registrableHost(url.hostname) === registrableHost(base.hostname), strong });
  });
  return [...found.values()]
    .sort((a, b) => Number(b.sameSite) - Number(a.sameSite) || Number(b.strong) - Number(a.strong))
    .slice(0, Math.max(1, limit));
}

/** GitHub renders text files as blob pages; the raw bytes live on another host. */
export function rawFileUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.hostname !== 'github.com') return;
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/u.exec(url.pathname);
  if (!match) return;
  const [, owner, repo, ref, path] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}${url.search}`;
}
