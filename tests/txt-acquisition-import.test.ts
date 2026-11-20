import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { BestEffortRejected } from '../src/stream-import.ts';

let dir: string;
let library: Library;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-best-effort-'));
  library = new Library({ dataDir: dir });
  library.open();
});
afterEach(() => { library.close(); rmSync(dir, { recursive: true, force: true }); });

const BODY = '她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。';

function chapter(number: number, body = BODY): string {
  return `第${number}章 海风\n\n　　${body.repeat(14)}\n`;
}
function novel(chapters = 5): string {
  return Array.from({ length: chapters }, (_, index) => chapter(index + 1)).join('\n');
}
function utf16be(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) { be[index] = le[index + 1]!; be[index + 1] = le[index]!; }
  return be;
}
const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3]); // 中文测试。

function write(name: string, bytes: Buffer | string): string {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}
/** Walk the reader pages to rebuild the imported text. */
function textOf(key: string): string {
  const chunks: string[] = [];
  let segment: number | null = 0;
  while (segment !== null && chunks.length < 4000) {
    const page = library.reader({ bookKey: key, segment }) as { segments: Array<{ text: string }>; next: number | null };
    chunks.push(...page.segments.map((entry) => entry.text));
    segment = page.next;
  }
  return chunks.join("");
}

describe('lenient TXT import across encodings', () => {
  it.each([
    ['utf8', (text: string) => Buffer.from(text, 'utf8')],
    ['utf8-bom', (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])],
    ['utf16le', (text: string) => Buffer.from(text, 'utf16le')],
    ['utf16be', (text: string) => utf16be(text)],
  ] as const)('imports a %s novel and keeps the prose intact', (name, encode) => {
    const file = write(`${name}.txt`, encode(novel()));
    const result = library.importFileBestEffort({ filename: `${name}.txt`, title: `样本${name}` }, file);
    expect(result.imported).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(textOf(result.book.key)).toContain('她把信折好');
    expect(result.readableChars).toBeGreaterThan(200);
    if (name === 'utf8-bom') expect(textOf(result.book.key).includes('\uFEFF')).toBe(false);
  });

  it('imports a GB18030 novel that the strict decoder would also accept, and reports no damage', () => {
    // Long GBK body: 中文测试。 × 60 gives 300 readable characters.
    const bytes = Buffer.concat(Array.from({ length: 60 }, () => GBK));
    const file = write('gbk.txt', bytes);
    const result = library.importFileBestEffort({ filename: 'gbk.txt', title: 'GBK 样本' }, file);
    expect(result.imported).toBe(true);
    expect(textOf(result.book.key)).toContain('中文测试。');
    expect(result.quality.repairs.map((repair) => repair.code)).not.toContain('encoding_repaired');
  });

  it('keeps a few undecodable bytes as replacement marks instead of refusing the book', () => {
    const body = novel();
    const bytes = Buffer.concat([Buffer.from(body.slice(0, 300), 'utf8'), Buffer.from([0xa4]), Buffer.from(body.slice(300), 'utf8')]);
    const file = write('stray.txt', bytes);
    const result = library.importFileBestEffort({ filename: 'stray.txt', title: '孤立坏字节' }, file);
    expect(result.imported).toBe(true);
    expect(result.quality.quality).toBe('warning');
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('replacement_characters');
    expect(textOf(result.book.key)).toContain('\uFFFD');
  });

  it('keeps the valid prefix when the last character is cut in half', () => {
    const body = novel();
    const bytes = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.from([0xe4, 0xb8])]);
    const file = write('cut.txt', bytes);
    const result = library.importFileBestEffort({ filename: 'cut.txt', title: '末尾截断' }, file);
    expect(result.imported).toBe(true);
    expect(result.quality.quality).toBe('partial');
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('tail_truncated');
    expect(textOf(result.book.key)).toContain('第5章 海风');
  });
});

describe('lenient TXT import when the copy is imperfect', () => {
  it('imports a novel with an out-of-order chapter number and warns', () => {
    const text = [chapter(1), chapter(2), chapter(2), chapter(3)].join('\n');
    const result = library.importFileBestEffort({ filename: 'order.txt', title: '章节号错乱' }, write('order.txt', text));
    expect(result.imported).toBe(true);
    const codes = result.quality.warnings.map((warning) => warning.code);
    expect(codes).toContain('duplicate_chapters');
    expect(codes).toContain('chapter_numbers_irregular');
  });

  it('imports a novel with a missing chapter and warns, without truncating anything', () => {
    const text = [chapter(1), chapter(3), chapter(4)].join('\n');
    const result = library.importFileBestEffort({ filename: 'gap.txt', title: '缺章' }, write('gap.txt', text));
    expect(result.imported).toBe(true);
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('chapters_missing');
    expect(textOf(result.book.key)).toContain('第4章 海风');
  });

  it('imports mixed heading styles and repeated headings', () => {
    const text = ['第1章 起', '## 第二章 承', '第1章 起', chapter(3)].join('\n\n');
    const result = library.importFileBestEffort({ filename: 'mixed.txt', title: '标题不一' }, write('mixed.txt', text));
    expect(result.imported).toBe(true);
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('heading_style_mixed');
  });

  it('imports prose with no chapter headings at all', () => {
    const file = write('plain.txt', BODY.repeat(120));
    const result = library.importFileBestEffort({ filename: 'plain.txt', title: '无章节' }, file);
    expect(result.imported).toBe(true);
    expect(library.chapters(result.book.key).items[0]!.title).toBe('正文');
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('no_chapters');
    expect(textOf(result.book.key).length).toBeGreaterThan(1200);
  });

  it('keeps advertising lines and reports them as warnings', () => {
    const ad = '请记住本站域名 www.example-novel.com 最新章节免费阅读';
    const text = `${chapter(1)}\n${ad}\n${chapter(2)}`;
    const result = library.importFileBestEffort({ filename: 'ads.txt', title: '带广告' }, write('ads.txt', text));
    expect(result.imported).toBe(true);
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('ad_lines');
    expect(textOf(result.book.key)).toContain('www.example-novel.com');
  });

  it('imports an obviously partial copy and marks it partial', () => {
    const text = `第1章 残卷\n\n　　${BODY.repeat(20)}\n　　她还没来得及说完`;
    const result = library.importFileBestEffort({ filename: 'partial.txt', title: '残卷' }, write('partial.txt', text));
    expect(result.imported).toBe(true);
    expect(result.quality.quality).toBe('partial');
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('possible_truncation');
  });

  it('imports a title that does not match the request but reports the mismatch', () => {
    const result = library.importFileBestEffort(
      { filename: 'other.txt', title: '别的书' },
      write('other.txt', novel()),
      { wanted: { title: '海风', author: '小鱼' }, declared: { title: '别的书', author: '小鱼' } },
    );
    expect(result.imported).toBe(true);
    expect(result.identity).toBe('partial');
    expect(result.quality.warnings.map((warning) => warning.code)).toContain('identity_mismatch');
  });
});

describe('lenient TXT import still refuses what cannot be read', () => {
  it('refuses an empty file', () => {
    const file = write('empty.txt', '');
    expect(() => library.importFileBestEffort({ filename: 'empty.txt', title: '空文件' }, file))
      .toThrowError(expect.objectContaining({ code: 'empty_file' }));
    expect(library.list()).toHaveLength(0);
  });

  it('refuses a binary file', () => {
    const file = write('binary.txt', Buffer.alloc(4096, 0));
    let thrown: unknown;
    try { library.importFileBestEffort({ filename: 'binary.txt', title: '二进制' }, file); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(BestEffortRejected);
    expect((thrown as BestEffortRejected).code).toBe('binary_file');
  });

  it('refuses a login or captcha page', () => {
    const wall = `请先登录后阅读\n\n请输入验证码继续\n\n${'登录后即可阅读全文。'.repeat(40)}`;
    const file = write('login.txt', wall);
    let thrown: unknown;
    try { library.importFileBestEffort({ filename: 'login.txt', title: '登录页' }, file); } catch (error) { thrown = error; }
    expect((thrown as BestEffortRejected).code).toBe('not_a_book');
    expect(library.list()).toHaveLength(0);
  });

  it('refuses a body that is mostly undecodable', () => {
    const bytes = Buffer.concat([Buffer.from(novel(), 'utf8'), Buffer.alloc(600, 0xff)]);
    const file = write('garbage.txt', bytes);
    let thrown: unknown;
    try { library.importFileBestEffort({ filename: 'garbage.txt', title: '大面积乱码' }, file); } catch (error) { thrown = error; }
    expect((thrown as BestEffortRejected).code).toMatch(/unreadable_text|binary_file/);
  });

  it('leaves the strict import entry untouched', () => {
    const file = write('control.txt', `${novel()}\u0001`);
    expect(() => library.importFile({ filename: 'control.txt', title: '控制字符' }, file))
      .toThrow(/Binary or control characters/);
    expect(library.list()).toHaveLength(0);
  });
});

