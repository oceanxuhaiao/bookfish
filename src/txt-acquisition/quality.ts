/**
 * Quality assessment for an acquired text. This never decides "good novel or
 * not"; it separates the few cases that cannot form readable prose (empty,
 * binary, login wall) from the many imperfections that are worth reporting and
 * reading anyway.
 */
import { normalizeTitle, normalizeAuthor } from '../novel-match.ts';
import type { DetectedEncoding, QualityIssue, QualityReport } from './types.ts';

/** Below this size the copy is flagged for review, never rejected solely for length. */
export const MIN_READABLE_CHARS = 200;
export const MAX_REPLACEMENT_RATIO = 0.1;

const CHAPTER_LINE = /^\s*(?:第[零〇一二三四五六七八九十百千万两0-9０-９]{1,12}[章节卷回部篇集]|#{1,6}\s+\S|[0-9]{1,4}[、.．]\s*\S)/u;
const ARABIC_CHAPTER = /^\s*第\s*([0-9０-９]{1,6})\s*[章节回]/u;
function chapterNumber(heading: string): number | undefined {
  const raw=/^\s*第\s*([零〇一二三四五六七八九十百千万两0-9０-９]{1,12})\s*[章节回]/u.exec(heading)?.[1];
  if(!raw)return;
  const normalized=raw.replace(/[０-９]/gu,d=>String('０１２３４５６７８９'.indexOf(d)));
  if(/^\d+$/u.test(normalized))return Number(normalized);
  const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(!/[十百千万]/u.test(raw))return Number([...raw].map(c=>digits[c]).join(''));
  let result=0,section=0,digit=0,lastUnit=10000;
  for(const c of raw){if(c in digits){digit=digits[c]!;continue;}const unit=({十:10,百:100,千:1000,万:10000} as Record<string,number>)[c];if(!unit)return;
    if(unit===10000){result+=(section+digit)*unit;section=0;digit=0;lastUnit=10000;}
    else{if(unit>=lastUnit)return;section+=(digit||1)*unit;digit=0;lastUnit=unit;}}
  return result+section+digit;
}
const LOGIN_HINTS = ['请先登录', '登录后', '登陆后', '用户登录', '账号登录', '立即登录', '验证码', '人机验证', 'captcha', 'sign in to continue', 'please log in', 'access denied', '403 forbidden', '404 not found'];
const AD_HINTS = ['www.', 'http://', 'https://', '最新章节', '请记住本站', '手机阅读', '手机版', '免费阅读', '加入书签', '一秒记住', '本章未完', '笔趣阁', '无弹窗'];

export interface AssessInput {
  text: string;
  metrics?: TextQualityMetrics;
  warnings?: QualityIssue[];
  encoding: DetectedEncoding;
  replacements: number;
  truncatedTail: boolean;
  repairs: QualityIssue[];
  filename?: string;
  /** Identity the model asked for. */
  wanted?: { title?: string; author?: string };
  /** Identity claimed by the page or the file name. */
  declared?: { title?: string; author?: string };
}

export type IdentityMatch = 'exact' | 'partial' | 'unknown';

export interface Assessment {
  report: QualityReport;
  verdict: 'accept' | 'reject';
  reject?: { code: string; message: string };
  identity: IdentityMatch;
}

function isReadableChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x0a || code === 0x0d || code === 0x09) return false;
  if (code === 0x20 || code === 0x3000) return false;
  if (code === 0xfffd) return false;
  return true;
}

function textishRatio(text: string): number {
  let supported = 0, total = 0;
  for (const char of text) { total++; if (/[\p{L}\p{N}\p{P}\p{M}\p{Z}\p{S}\s]/u.test(char) || char === '\ufffd') supported++; }
  return total ? supported / total : 0;
}

function chapterLines(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 60) continue;
    if (CHAPTER_LINE.test(trimmed)) found.push(trimmed);
  }
  return found;
}

export function identityMatch(wanted?: { title?: string; author?: string }, declared?: { title?: string; author?: string }): IdentityMatch {
  const wantedTitle = normalizeTitle(wanted?.title ?? '');
  const declaredTitle = normalizeTitle(declared?.title ?? '');
  if (!wantedTitle || !declaredTitle) return 'unknown';
  const titleOk = wantedTitle === declaredTitle;
  const wantedAuthor = normalizeAuthor(wanted?.author ?? '');
  const declaredAuthor = normalizeAuthor(declared?.author ?? '');
  if (!wantedAuthor || !declaredAuthor) return titleOk ? 'partial' : 'unknown';
  const authorOk = wantedAuthor === declaredAuthor;
  return titleOk && authorOk ? 'exact' : 'partial';
}

export interface TextQualityMetrics {
  totalChars: number; readableChars: number; supported: number; codePoints: number; hasLetter: boolean;
  head: string; tail: string; headings: string[]; headingsCapped: boolean; adLines: number; gateChars: number;
}
/** Bounded line/head/tail summaries; never retains a whole book or an unbounded line. */
export class TextQualityAccumulator {
  readonly metrics: TextQualityMetrics = { totalChars: 0, readableChars: 0, supported: 0, codePoints: 0, hasLetter: false, head: '', tail: '', headings: [], headingsCapped: false, adLines: 0, gateChars: 0 };
  private line = ''; private length = 0; private gate = false; private ad = false; private carry = '';
  push(text: string): void {
    const m = this.metrics; m.totalChars += text.length; m.head = (m.head + text).slice(0, 4000); m.tail = (m.tail + text).slice(-80);
    const count = (pattern: RegExp): number => { let n=0; while(pattern.exec(text)) n++; return n; };
    const points = text.length - count(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g);
    m.codePoints += points;
    m.readableChars += points - count(/[\n\r\t \u3000\ufffd]/gu);
    m.supported += points - count(/[^\p{L}\p{N}\p{P}\p{M}\p{Z}\p{S}\s\ufffd]/gu);
    m.hasLetter ||= /\p{L}/u.test(text);
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!; const window = this.carry + part; this.length += part.length;
      if (this.line.length < 8192) this.line = (this.line + part).slice(0, 8192);
      this.gate ||= LOGIN_HINTS.some(hint => window.toLowerCase().includes(hint)); this.ad ||= AD_HINTS.some(hint => window.includes(hint)); this.carry = window.slice(-64);
      if (i < parts.length - 1) this.endLine();
    }
  }
  private endLine(): void {
    const trimmed = this.line.trim(); const m = this.metrics;
    if (this.gate) m.gateChars += this.length <= 8192 ? trimmed.length : this.length;
    if (this.ad) m.adLines++;
    if (this.length <= 60 && CHAPTER_LINE.test(trimmed)) { if (m.headings.length < 10000) m.headings.push(trimmed); else m.headingsCapped = true; }
    this.line = ''; this.length = 0; this.gate = false; this.ad = false; this.carry = '';
  }
  finish(): TextQualityMetrics { this.endLine(); return this.metrics; }
}

export function assessText(input: AssessInput): Assessment {
  const warnings: QualityIssue[] = [...(input.warnings ?? [])];
  const repairs = [...input.repairs];
  const text = input.text;
  const accumulator = new TextQualityAccumulator();
  if (!input.metrics) accumulator.push(text);
  const metrics = input.metrics ?? accumulator.finish();
  const { readableChars, totalChars } = metrics;

  const fail = (code: string, message: string): Assessment => ({
    report: { quality: 'partial', encoding: input.encoding, readableChars, totalChars, warnings, repairs, truncated: input.truncatedTail, suspectedPartial: true },
    verdict: 'reject',
    reject: { code, message },
    identity: 'unknown',
  });

  if (!readableChars && !metrics.hasLetter) return fail('empty_file', 'The file has no text content');
  if (!metrics.hasLetter) return fail('not_a_book', 'The file has no readable prose');
  if (readableChars < MIN_READABLE_CHARS) warnings.push({ code: 'short_text', message: 'Short text retained for reading; completeness is uncertain' });
  if (metrics.supported / Math.max(1, metrics.codePoints) < 0.6) return fail('binary_file', 'Content is mostly non-text data');

  const replacementRatio = input.replacements / Math.max(1, totalChars);
  if (replacementRatio > MAX_REPLACEMENT_RATIO) {
    warnings.push({ code: 'encoding_damaged', message: `${Math.round(replacementRatio * 100)}% could not be decoded; readable text retained for review` });
  }
  if (input.replacements > 0) {
    warnings.push({ code: 'replacement_characters', message: `${input.replacements} undecodable character(s) kept as replacement marks`, count: input.replacements });
  }
  const localizedDamage = input.replacements >= 8;
  if (localizedDamage && replacementRatio <= MAX_REPLACEMENT_RATIO) warnings.push({ code: 'localized_encoding_damage', message: 'Multiple undecodable characters remain in otherwise readable text; affected portions require review of the retained original', count: input.replacements });

  const lowerHead = metrics.head.toLowerCase();
  const loginHits = LOGIN_HINTS.filter((hint) => lowerHead.includes(hint)).length;
  const gateChars = metrics.gateChars;
  if (loginHits >= 2 && readableChars < 6000 && gateChars / Math.max(1, totalChars) > 0.7) return fail('not_a_book', 'Looks like a login, captcha or error page rather than a book');
  if (loginHits >= 2) warnings.push({ code: 'possible_gate_text', message: 'Login or error wording occurs alongside readable text; content retained' });

  const headings = metrics.headings;
  if (metrics.headingsCapped) warnings.push({ code: 'heading_analysis_capped', message: 'Heading detail analysis is capped at 10000; all prose is retained' });
  if (!headings.length) {
    warnings.push({ code: 'no_chapters', message: 'No chapter headings were detected; importing as continuous prose' });
  } else {
    const styles = new Set(headings.map((line) => (/^#/u.test(line) ? 'markdown' : ARABIC_CHAPTER.test(line) ? 'arabic' : 'chinese')));
    if (styles.size > 1) warnings.push({ code: 'heading_style_mixed', message: 'Chapter headings use more than one format' });
    const seen = new Map<string, number>();
    for (const heading of headings) seen.set(heading, (seen.get(heading) ?? 0) + 1);
    const duplicates = [...seen.values()].filter((count) => count > 1).length;
    if (duplicates) warnings.push({ code: 'duplicate_chapters', message: `${duplicates} chapter heading(s) appear more than once`, count: duplicates });
    let irregular = 0;
    let previous = 0;
    for (const heading of headings) {
      const value = chapterNumber(heading);
      if (value === undefined) continue;
      if (Number.isFinite(value) && value <= previous) irregular += 1;
      if (Number.isFinite(value)) previous = value;
    }
    if (irregular) warnings.push({ code: 'chapter_numbers_irregular', message: `${irregular} chapter number(s) do not increase`, count: irregular });
    const numbers = headings.map(chapterNumber).filter((value):value is number => value !== undefined && Number.isFinite(value));
    if (numbers.length >= 2) {
      for (let index = 1; index < numbers.length; index += 1) {
        if (numbers[index]! - numbers[index - 1]! > 1) {
          warnings.push({ code: 'chapters_missing', message: `Chapter ${numbers[index - 1]} is followed by ${numbers[index]}` });
          break;
        }
      }
    }
  }

  const adLines = metrics.adLines;
  if (adLines) warnings.push({ code: 'ad_lines', message: `${adLines} line(s) look like site advertising or navigation; kept as-is`, count: adLines });

  let suspectedPartial = warnings.some(issue => issue.code === 'mixed_encoding_suspected') || localizedDamage || replacementRatio > MAX_REPLACEMENT_RATIO || readableChars < MIN_READABLE_CHARS;
  if (input.truncatedTail) {
    suspectedPartial = true;
    warnings.push({ code: 'tail_truncated', message: 'The file ended with an incomplete character' });
  }
  const tail = metrics.tail.trimEnd();
  if (tail.length > 40 && !/[。！？…”』」】)\]!?."'~～]$/u.test(tail)) {
    suspectedPartial = true;
    warnings.push({ code: 'possible_truncation', message: 'The text stops without an ending sentence mark; the copy may be incomplete' });
  }

  let identity = identityMatch(input.wanted, input.declared);
  // A bounded, explicit header contradiction can disprove a filename claim.
  // Absence of a header never proves the narrative's identity, and no prose is rejected.
  if (identity === 'exact') {
    const leading = metrics.head.split('\n').slice(0, 8);
    const title = leading.map(line => /^\s*(?:书名|标题|作品)\s*[:：]\s*(.{1,80}?)\s*$/u.exec(line)?.[1]).find(Boolean);
    const author = leading.map(line => /^\s*(?:作者|著者)\s*[:：]\s*(.{1,40}?)\s*$/u.exec(line)?.[1]).find(Boolean);
    if ((title && normalizeTitle(title.replace(/\s+(?:作者|著者)\s*[:：].*$/u, '')) !== normalizeTitle(input.wanted?.title ?? ''))
      || (author && normalizeAuthor(author) !== normalizeAuthor(input.wanted?.author ?? ''))) {
      identity = 'partial';
      warnings.push({code:'identity_header_conflict',message:'Explicit opening metadata conflicts with the source declaration; confirmation required, prose retained'});
    }
  }
  if (identity === 'partial' && (input.wanted?.title || input.declared?.title)) {
    warnings.push({ code: 'identity_mismatch', message: 'Title or author on the page does not exactly match the requested book' });
  }

  const quality: QualityReport['quality'] = suspectedPartial ? 'partial' : warnings.length || repairs.length ? 'warning' : 'clean';
  return {
    report: { quality, encoding: input.encoding, readableChars, totalChars, warnings, repairs, truncated: input.truncatedTail, suspectedPartial },
    verdict: 'accept',
    identity,
  };
}
