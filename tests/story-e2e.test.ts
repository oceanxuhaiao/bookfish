import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

function syntheticBook(chapters: number) {
  let text = '';
  for (let i = 0; i < chapters; i++) text += `第${i + 1}章\n第${i + 1}段线索：${i === 0 ? '蓝色浮标' : i === 10 ? '旧船票' : '灯塔钥匙'}。\n`;
  return text;
}

describe('offline story index end-to-end', () => {
  it('runs capture -> publish -> overview/evidence/entity with omissions and conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-g2-e2e-'));
    const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
    try {
      lib.open();
      const imported = lib.importBytes({ filename: 'e2e.txt', title: '索引演练' }, Buffer.from(syntheticBook(30))) as { book: { key: string } };
      lib.select(imported.book.key);
      for (let i = 0; i < 30; i++) lib.finish({ ...lib.readNext(), understanding: '' });
      const capture = (requestId: string, segmentId: number, summary: string, quote: string) => lib.captureStory({ bookKey: imported.book.key, requestId, changes: [{ kind: 'event', summary, evidenceSegmentIds: [segmentId], quote }] });
      const one = capture('e2e-1', 0, '发现蓝色浮标', '蓝色浮标');
      const two = capture('e2e-2', 10, '发现旧船票', '旧船票');
      const three = capture('e2e-3', 20, '发现灯塔钥匙', '灯塔钥匙');
      expect(capture('e2e-1', 0, '发现蓝色浮标', '蓝色浮标').records[0].id).toBe(one.records[0].id);

      expect(() => capture('bad-quote', 0, '伪造', '不存在的句子')).toThrow();
      expect(() => lib.captureStory({ bookKey: imported.book.key, requestId: 'bad-relation', changes: [{ kind: 'relation', summary: '冲突', fromEntityId: 'missing', toEntityId: 'missing2', evidenceSegmentIds: [0] }] })).toThrow();
      expect(() => lib.putStoryPack({ id: 'bad-pack', bookKey: imported.book.key, level: 'book', summary: '越界', eventIds: [one.records[0].id], coveredRanges: [{ from: 0, to: 30 }], status: 'active' })).toThrow();

      const ids = [one.records[0].id, two.records[0].id, three.records[0].id];
      lib.putStoryPack({ id: 'root', bookKey: imported.book.key, level: 'book', summary: '全书索引', eventIds: ids, coveredRanges: [{ from: 0, to: 30 }] });
      lib.publishStoryPack('root');
      const overview = lib.storyOverview(imported.book.key, 30);
      expect(overview).toMatchObject({ total: 1, returned: 1, hasFuturePacks: false });
      const evidence = lib.storyEvidence(imported.book.key, ids, 30);
      expect(evidence.events.map(event => event.summary)).toEqual(['发现蓝色浮标', '发现旧船票', '发现灯塔钥匙']);
      expect(lib.storyEvidence(imported.book.key, ids, 10).events.slice(1).every(event => event.omitted)).toBe(true);

      lib.createStoryEntity({ bookKey: imported.book.key, canonicalName: '顾迟', aliases: ['迟'], aliasReveals: { '迟': 10 }, firstRevealedAt: 30 });
      const early = lib.storyEntityCandidates(imported.book.key, '迟', 15);
      expect(early.status).toBe('resolved');
      expect((early.candidates[0] as any).canonicalName).toBe('迟');
      expect(lib.storyEntityCandidates(imported.book.key, '顾迟', 15).status).toBe('none');
      expect(lib.storyEntityCandidates(imported.book.key, '顾迟', 30).status).toBe('resolved');
    } finally {
      lib.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
