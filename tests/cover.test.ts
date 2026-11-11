import { describe, expect, it } from 'vitest';
import { coverDesign } from '../src/webui/cover.ts';

describe('local book cover design', () => {
  it('uses the title and author without fetching an image', () => {
    const design = coverDesign({ key: 'a', title: '海边的风', author: '林某', source: null });
    expect(design).toMatchObject({ title: '海边的风', author: '林某', sourceHost: null, hasSource: false, mark: '海' });
    expect(design.palette).toBeGreaterThanOrEqual(0);
    expect(design.palette).toBeLessThan(8);
  });

  it('shows a normalized source host for a remote book', () => {
    const design = coverDesign({ key: 'b', title: '三国演义', author: '罗贯中', source: { bookUrl: 'https://www.biquge365.net/book/08451/' } });
    expect(design.sourceHost).toBe('biquge365.net');
    expect(design.hasSource).toBe(true);
  });

  it('keeps the palette stable across revisions of the same title and author', () => {
    const first = coverDesign({ key: 'revision-1', title: '龙族', author: '江南', source: null });
    const second = coverDesign({ key: 'revision-2', title: '龙族', author: '江南', source: null });
    expect(second.palette).toBe(first.palette);
  });

  it('leaves empty fields for the caller to localize and tolerates a broken source URL', () => {
    const design = coverDesign({ key: 'c', title: '   ', author: '', source: { bookUrl: 'not a url' } });
    expect(design.title).toBe('');
    expect(design.author).toBe('');
    expect(design.sourceHost).toBe(null);
    expect(design.hasSource).toBe(true);
    expect(design.mark).toBe('书');
  });
});
