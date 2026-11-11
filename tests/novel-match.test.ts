import { describe, expect, it } from 'vitest';
import { groupCandidatesByBook, matchCandidate, normalizeIdentity, NovelMatchError, type NovelSearchCandidate } from '../src/novel-match.ts';

function candidate(title: string, author: string, url: string, source = '笔趣阁365'): NovelSearchCandidate {
  return {
    title, author, url, source: { id: 8, name: source }, revision: 'rev',
    latestChapter: '', lastUpdateTime: '',
  };
}

const results: NovelSearchCandidate[] = [
  candidate('西游记：菩提祖师下山', '不会有下次了', 'https://example.test/1/', '笔趣阁365'),
  candidate('西游记', '吴承恩（明）', 'https://example.test/979471/', '笔趣阁365'),
  candidate('西游记', '吴承恩', 'https://example.test/21551/', '书海阁'),
  candidate('西游记之圣僧', '禅海雷音', 'https://example.test/2/', '笔趣阁365'),
];

describe('novel candidate matching', () => {
  it('normalizes punctuation and dynasty suffixes', () => {
    expect(normalizeIdentity('《西游记》')).toBe('西游记');
    expect(normalizeIdentity('吴承恩（明）')).toBe('吴承恩');
    expect(normalizeIdentity('作者：罗贯中')).toBe('罗贯中');
  });

  it('never picks the first result just because it is first', () => {
    expect(() => matchCandidate(results, { title: '西游记', author: '吴承恩' })).toThrow(NovelMatchError);
    const only = [results[0]!, results[1]!];
    expect(matchCandidate(only, { title: '西游记', author: '吴承恩' }).url).toBe('https://example.test/979471/');
  });

  it('reports a wrong author instead of accepting a same-title work', () => {
    const only = [candidate('西游记', '罗贯中', 'https://example.test/wrong/')];
    expect(() => matchCandidate(only, { title: '西游记', author: '吴承恩' })).toThrow(/other authors/u);
  });

  it('rejects an ambiguous author/title pair', () => {
    expect(() => matchCandidate(results, { title: '西游记', author: '吴承恩' })).toThrow(/Ambiguous/u);
  });

  it('groups the same title and author across sources without merging different authors', () => {
    const sameBook = [
      candidate('西游记', '吴承恩', 'https://example.test/8/', '笔趣阁365'),
      candidate('西游记', '吴承恩（明）', 'https://example.test/9/', '第八中文网'),
      candidate('西游记', '罗贯中', 'https://example.test/other/', '其他'),
    ];
    const groups = groupCandidatesByBook(sameBook);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((item) => item.source.name)).toEqual(['笔趣阁365', '第八中文网']);
    expect(groups[1]![0]!.author).toBe('罗贯中');
  });
});
