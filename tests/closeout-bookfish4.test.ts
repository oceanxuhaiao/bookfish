/**
 * BF-R2-CLOSEOUT-001 补测：BOOKFISH4（序列化书）。
 * 用产品真实 createSerial 路径造样本；不手工编造格式。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Library } from '../src/library.ts';
import { newSerialRecord } from '../src/serial-types.ts';
import { CONTROLLED_BOOK_URL, ControlledAdapter, controlledCatalog, controlledChapter, controlledLink } from './helpers/serial-adapter.ts';

let root: string;

function openAt(dir: string) {
  const library = new Library({ dataDir: dir, now: () => Date.now() });
  library.open();
  return library;
}

function makeSerial(library: Library) {
  const link = controlledLink(1);
  const text = '小鱼把灯留在窗边，海风从门缝里吹进来。'.repeat(60);
  const catalog = controlledCatalog([link], 'finished');
  const serial = newSerialRecord({
    serialId: randomUUID(), adapterId: 'controlled-serial-v1', sourceBookId: '/book/4/', bookUrl: CONTROLLED_BOOK_URL,
    capabilities: new ControlledAdapter(catalog).capabilities, authorization: 'allowed', authorizationNote: '受控原创源', catalog,
    enabled: false, intervalMinutes: 60, now: Date.now(),
  });
  const created = library.createSerial({
    catalog, serial, chapters: [{ ...controlledChapter(link, text), index: 0 }],
  }, library.generation());
  library.select(created.book.key);
  return created.book.key;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bookfish-bf4-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 }); } catch { /* 句柄 */ } });

describe('BOOKFISH4', () => {
  it('is produced by the real writer from a real serial book', () => {
    const source = join(root, 'src'); mkdirSync(source, { recursive: true });
    const library = openAt(source);
    const key = makeSerial(library);
    const file = join(root, 'b4.bfbak');
    library.writeArchive(file);
    library.close();

    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('BOOKFISH4');
    const list = openAt(source).list() as any[];
    expect(list[0].key).toBe(key);
    expect(list[0].serial ?? list[0].book?.remote?.serial).toBeTruthy();
  });

  it('restores the serial book into an empty library with the same key', () => {
    const source = join(root, 'src2'); mkdirSync(source, { recursive: true });
    const library = openAt(source);
    const key = makeSerial(library);
    const file = join(root, 'b4b.bfbak');
    library.writeArchive(file);
    library.close();

    const target = join(root, 'dst2'); mkdirSync(target, { recursive: true });
    const fresh = openAt(target);
    fresh.restoreArchive(file);
    const restored = (fresh.list() as any[])[0];
    fresh.close();

    expect(restored.key).toBe(key);
    expect(restored.serial ?? restored.book?.remote?.serial).toBeTruthy();
  });
});
