/** Public, read-only feed maintained directly in the GitHub repository. */
export const ANNOUNCEMENTS_URL = 'https://raw.githubusercontent.com/oceanxuhaiao/bookfish/main/announcements.json';

export type AnnouncementCategory = 'development' | 'feature' | 'notice';

export interface OnlineAnnouncement {
  id: string;
  publishedAt: string;
  title: string;
  category: AnnouncementCategory;
  content: string;
  link?: string;
}

export interface OnlineAnnouncements {
  schemaVersion: 1;
  updatedAt: string;
  announcements: OnlineAnnouncement[];
}

export type AnnouncementsErrorCode = 'invalid-json' | 'invalid-data' | 'too-large' | 'http' | 'network' | 'timeout' | 'aborted';

export class AnnouncementsError extends Error {
  constructor(readonly code: AnnouncementsErrorCode, message: string) {
    super(message);
    this.name = 'AnnouncementsError';
  }
}

const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CATEGORIES = new Set<AnnouncementCategory>(['development', 'feature', 'notice']);

function invalid(message: string): never {
  throw new AnnouncementsError('invalid-data', message);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) invalid(`${field} must not be empty`);
  if (trimmed.length > max) invalid(`${field} is too long`);
  return trimmed;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${field} must be an ISO 8601 time`);
  return value;
}

/** Validate the remote document. Never trust its shape or field lengths. */
export function parseAnnouncements(input: string | unknown): OnlineAnnouncements {
  let raw: unknown = input;
  let source = '';
  if (typeof input === 'string') {
    source = input;
    const bytes = typeof TextEncoder === 'undefined' ? source.length : new TextEncoder().encode(source).length;
    if (bytes > MAX_BYTES) throw new AnnouncementsError('too-large', 'announcements.json is too large');
    try { raw = JSON.parse(source); }
    catch { throw new AnnouncementsError('invalid-json', 'announcements.json is not valid JSON'); }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('announcements.json must be an object');
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) invalid('unsupported schemaVersion');
  const updatedAt = iso(root.updatedAt, 'updatedAt');
  if (!Array.isArray(root.announcements)) invalid('announcements must be an array');
  if (root.announcements.length > MAX_ITEMS) invalid('too many announcements');
  const ids = new Set<string>();
  const announcements = root.announcements.map((value, index): OnlineAnnouncement => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`announcements[${index}] must be an object`);
    const item = value as Record<string, unknown>;
    const id = text(item.id, `announcements[${index}].id`, 100);
    if (ids.has(id)) invalid(`duplicate announcement id: ${id}`);
    ids.add(id);
    const category = text(item.category, `announcements[${index}].category`, 20) as AnnouncementCategory;
    if (!CATEGORIES.has(category)) invalid(`unsupported announcement category: ${category}`);
    const link = item.link === undefined || item.link === null || item.link === '' ? undefined : text(item.link, `announcements[${index}].link`, 500);
    if (link !== undefined) {
      let parsed: URL;
      try { parsed = new URL(link); } catch { invalid(`announcements[${index}].link must be a URL`); }
      if (parsed.protocol !== 'https:') invalid(`announcements[${index}].link must use HTTPS`);
    }
    return {
      id,
      publishedAt: iso(item.publishedAt, `announcements[${index}].publishedAt`),
      title: text(item.title, `announcements[${index}].title`, 120),
      category,
      content: text(item.content, `announcements[${index}].content`, 5000),
      ...(link ? { link } : {}),
    };
  });
  announcements.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.id.localeCompare(right.id));
  // Return a compact copy; unknown remote fields never reach the UI.
  return { schemaVersion: 1, updatedAt, announcements };
}

export interface FetchAnnouncementsOptions {
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Fetch the feed with a hard timeout. No response is cached on failure. */
export async function fetchAnnouncements(options: FetchAnnouncementsOptions = {}): Promise<OnlineAnnouncements> {
  const url = options.url ?? ANNOUNCEMENTS_URL;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.signal?.aborted) throw new AnnouncementsError('aborted', 'announcement request was cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = (): void => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const requestInit = {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    } as RequestInit & { cache: string };
    const response = await fetchImpl(url, requestInit);
    if (!response.ok) throw new AnnouncementsError('http', `HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > MAX_BYTES) throw new AnnouncementsError('too-large', 'announcements.json is too large');
    const body = await response.text();
    return parseAnnouncements(body);
  } catch (error) {
    if (error instanceof AnnouncementsError) throw error;
    if (timedOut) throw new AnnouncementsError('timeout', 'announcement request timed out');
    if (options.signal?.aborted) throw new AnnouncementsError('aborted', 'announcement request was cancelled');
    if (error instanceof Error && error.name === 'AbortError') throw new AnnouncementsError('timeout', 'announcement request timed out');
    throw new AnnouncementsError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
