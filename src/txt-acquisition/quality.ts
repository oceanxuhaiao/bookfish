/**
 * Quality assessment for an acquired text. This never decides "good novel or
 * not"; it separates the few cases that cannot form readable prose (empty,
 * binary, login wall) from the many imperfections that are worth reporting and
 * reading anyway.
 */
import { normalizeIdentity } from '../novel-match.ts';
import type { DetectedEncoding, QualityIssue, QualityReport } from './types.ts';

/** Below this size the copy is flagged for review, never rejected solely for length. */
export const MIN_READABLE_CHARS = 200;
export const MAX_REPLACEMENT_RATIO = 0.1;

const CHAPTER_LINE = /^\s*(?:第[零〇一二三四五六七八九十百千万两0-9０-９]{1,12}[章节卷回部篇集]|#{1,6}\s+\S|[0-9]{1,4}[、.．]\s*\S)/u;
const ARABIC_CHAPTER = /^\s*第\s*([0-9０-９]{1,6})\s*[章节回]/u;
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

function identityMatch(wanted?: { title?: string; author?: string }, declared?: { title?: string; author?: string }): IdentityMatch {
  const wantedTitle = normalizeIdentity(wanted?.title ?? '');
  const declaredTitle = normalizeIdentity(declared?.title ?? '');
  if (!wantedTitle || !declaredTitle) return 'unknown';
  const titleOk = wantedTitle === declaredTitle || wantedTitle.includes(declaredTitle) || declaredTitle.includes(wantedTitle);
  const wantedAuthor = normalizeIdentity(wanted?.author ?? '');
  const declaredAuthor = normalizeIdentity(declared?.author ?? '');
  if (!wantedAuthor || !declaredAuthor) return titleOk ? 'partial' : 'unknown';
  const authorOk = wantedAuthor === declaredAuthor || wantedAuthor.includes(declaredAuthor) || declaredAuthor.includes(wantedAuthor);
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
    for (const char of text) { m.codePoints++; if (isReadableChar(char)) m.readableChars++; if (/[\p{L}\p{N}\p{P}\p{M}\p{Z}\p{S}\s]/u.test(char) || char === '\ufffd') m.supported++; if (!m.hasLetter && /\p{L}/u.test(char)) m.hasLetter = true; }
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
      const match = ARABIC_CHAPTER.exec(heading);
      if (!match) continue;
      const value = Number(match[1]!.replace(/[０-９]/gu, (digit) => String('０１２３４５６７８９'.indexOf(digit))));
      if (Number.isFinite(value) && value <= previous) irregular += 1;
      if (Number.isFinite(value)) previous = value;
    }
    if (irregular) warnings.push({ code: 'chapter_numbers_irregular', message: `${irregular} chapter number(s) do not increase`, count: irregular });
    const arabic = headings.filter((line) => ARABIC_CHAPTER.test(line));
    if (arabic.length >= 2) {
      const numbers = arabic.map((line) => Number(ARABIC_CHAPTER.exec(line)![1]!.replace(/[０-９]/gu, (digit) => String('０１２３４５６７８９'.indexOf(digit))))).filter((value) => Number.isFinite(value));
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

  let suspectedPartial = warnings.some(issue => issue.code === 'mixed_encoding_suspected') || replacementRatio > MAX_REPLACEMENT_RATIO || readableChars < MIN_READABLE_CHARS;
  if (input.truncatedTail) {
    suspectedPartial = true;
    warnings.push({ code: 'tail_truncated', message: 'The file ended with an incomplete character' });
  }
  const tail = metrics.tail.trimEnd();
  if (tail.length > 40 && !/[。！？…”』」】)\]!?."'~～]$/u.test(tail)) {
    suspectedPartial = true;
    warnings.push({ code: 'possible_truncation', message: 'The text stops without an ending sentence mark; the copy may be incomplete' });
  }

  const identity = identityMatch(input.wanted, input.declared);
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
