import { fetchAnnouncements, type OnlineAnnouncements } from './webui/announcements.ts';

/** Server-side fallback for hosts where the WebUI cannot reach GitHub Raw directly. */
export function loadOnlineAnnouncements(): Promise<OnlineAnnouncements> {
  return fetchAnnouncements({ timeoutMs: 5000 });
}
