import { describe, expect, it, vi } from 'vitest';
import { AnnouncementsError, fetchAnnouncements, parseAnnouncements } from '../../src/webui/announcements.ts';

const good = JSON.stringify({
  schemaVersion: 1,
  updatedAt: '2026-11-21T10:00:00Z',
  announcements: [
    { id: 'older', publishedAt: '2026-11-20T10:00:00Z', title: 'Older', category: 'development', content: 'old', link: null },
    { id: 'newer', publishedAt: '2026-11-21T09:00:00Z', title: 'Newer', category: 'feature', content: 'new\nline', link: 'https://example.com/post' },
  ],
});

describe('online announcements', () => {
  it('validates and sorts newest first, dropping unknown fields', () => {
    const feed = parseAnnouncements(good);
    expect(feed.announcements.map((item) => item.id)).toEqual(['newer', 'older']);
    expect(feed.announcements[0]!.content).toBe('new\nline');
    expect(feed.announcements[1]!.link).toBeUndefined();
  });

  it('rejects duplicate ids, unsupported schemas and non-HTTPS links', () => {
    expect(() => parseAnnouncements(JSON.stringify({ ...JSON.parse(good), announcements: [
      { id: 'same', publishedAt: '2026-11-21T09:00:00Z', title: 'A', category: 'notice', content: 'a' },
      { id: 'same', publishedAt: '2026-11-21T08:00:00Z', title: 'B', category: 'notice', content: 'b' },
    ] }))).toThrow(AnnouncementsError);
    expect(() => parseAnnouncements(JSON.stringify({ schemaVersion: 2, updatedAt: '2026-11-21T10:00:00Z', announcements: [] }))).toThrow(AnnouncementsError);
    expect(() => parseAnnouncements(JSON.stringify({ ...JSON.parse(good), announcements: [
      { id: 'bad-link', publishedAt: '2026-11-21T09:00:00Z', title: 'A', category: 'notice', content: 'a', link: 'http://example.com' },
    ] }))).toThrow(AnnouncementsError);
  });

  it('rejects malformed and oversized documents', () => {
    expect(() => parseAnnouncements('{')).toThrow(AnnouncementsError);
    expect(() => parseAnnouncements(JSON.stringify({ schemaVersion: 1, updatedAt: '2026-11-21T10:00:00Z', announcements: 'nope' }))).toThrow(AnnouncementsError);
    expect(() => parseAnnouncements('x'.repeat(256 * 1024 + 1))).toThrow(AnnouncementsError);
  });

  it('fetches with no-store and returns the parsed feed', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(good, { status: 200, headers: { 'content-type': 'application/json' } }));
    const feed = await fetchAnnouncements({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(feed.announcements[0]!.id).toBe('newer');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', method: 'GET' });
  });

  it('turns non-2xx responses into a fallback-safe error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(fetchAnnouncements({ fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ code: 'http' });
  });

  it('aborts a hanging request after the timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    await expect(fetchAnnouncements({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
