import { describe, expect, it } from 'vitest';
import { diffSerialCatalog, serialCatalogHash } from '../src/serial-types.ts';
import type { ChapterLink, SourceCatalog } from '../src/source-types.ts';

const bookUrl = 'https://serial.test/book/1/';
function link(n: number, extra: Partial<ChapterLink> = {}): ChapterLink { return { id: `c${n}`, title: `第${n}章`, url: `${bookUrl}${n}/`, ...extra }; }
function catalog(chapters: ChapterLink[], status: 'ongoing' | 'finished' | 'unknown' = 'ongoing'): SourceCatalog {
  const value: SourceCatalog = { adapter: 'controlled-serial-v1', bookUrl, title: '受控连载', author: '测试作者', declaredTotal: chapters.length,
    chapters: chapters.map((c) => ({ ...c })), publicationStatus: status, fetchedAt: new Date().toISOString(), hash: '', complete: true, pageCount: 1 };
  value.hash = serialCatalogHash(value); return value;
}
describe('strict serial catalog diff', () => {
  it('accepts only a strict tail append and reports no change otherwise', () => {
    const base = catalog([link(1), link(2)]);
    expect(diffSerialCatalog(base, catalog([link(1), link(2)]))).toEqual({ kind: 'no_change' });
    const appended = diffSerialCatalog(base, catalog([link(1), link(2), link(3)]));
    expect(appended.kind).toBe('append');
    if (appended.kind === 'append') expect(appended.appended.map((c) => c.id)).toEqual(['c3']);
  });
  it('classifies title changes and publication evidence without touching old text', () => {
    const base = catalog([link(1), link(2)]);
    const titles = diffSerialCatalog(base, catalog([link(1), { ...link(2), title: '第二章改名' }]));
    expect(titles.kind).toBe('metadata_changed');
    const finished = diffSerialCatalog(base, catalog([link(1), link(2)], 'finished'));
    expect(finished.kind).toBe('metadata_changed');
    if (finished.kind === 'metadata_changed') expect(finished.publicationChanged).toBe(true);
  });
  it('blocks shrink, identity, URL, revision and chapter-ID changes', () => {
    const base = catalog([link(1), link(2), link(3)]);
    expect(diffSerialCatalog(base, catalog([link(1), link(2)]))).toMatchObject({ kind: 'conflict', reason: 'catalog_shrunk' });
    const changedBook = catalog([link(1), link(2), link(3)]); changedBook.bookUrl = 'https://serial.test/book/2/'; changedBook.hash = serialCatalogHash(changedBook);
    expect(diffSerialCatalog(base, changedBook)).toMatchObject({ kind: 'conflict', reason: 'identity_changed' });
    expect(diffSerialCatalog(base, catalog([link(1), { ...link(2), url: `${bookUrl}99/` }, link(3)]))).toMatchObject({ kind: 'conflict', reason: 'chapter_url_changed' });
    expect(diffSerialCatalog(base, catalog([link(1), link(2), link(3, { revision: 'r2' })]))).toMatchObject({ kind: 'conflict', reason: 'source_revision_detected' });
    expect(diffSerialCatalog(base, catalog([link(1), { ...link(2), id: 'other' }, link(3)]))).toMatchObject({ kind: 'conflict', reason: 'chapter_identity_changed' });
  });
  it('rejects duplicate IDs and an explicitly incomplete catalog', () => {
    const duplicate = catalog([link(1), link(2)]); duplicate.chapters[1] = { ...duplicate.chapters[1], id: 'c1' };
    expect(() => diffSerialCatalog(catalog([link(1)]), duplicate)).toThrow(/duplicate/);
    const incomplete = catalog([link(1), link(2)]); incomplete.complete = false; incomplete.hash = serialCatalogHash(incomplete);
    expect(() => diffSerialCatalog(catalog([link(1)]), incomplete)).toThrow(/Invalid serial catalog/);
  });
  it('accepts a batch when the re-read catalog only appended later chapters', () => {
    const before = catalog([link(1), link(2)]);
    const fetched = catalog([link(1), link(2), link(3)]);
    const after = catalog([link(1), link(2), link(3), link(4)]);
    expect(diffSerialCatalog(before, fetched).kind).toBe('append');
    expect(diffSerialCatalog(fetched, after).kind).toBe('append');
  });
});
