import { readFileSync } from 'node:fs';
import { loadHelpCatalog, validateHelpCatalog, validateHelpLinks, allFeatures } from '../src/help-content.ts';
import { parseAnnouncements } from '../src/webui/announcements.ts';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof packageJson.version !== 'string') throw new Error('package.json has no version');
const catalog = loadHelpCatalog();
validateHelpCatalog(catalog, packageJson.version);
validateHelpLinks(catalog);
const ids = new Set(allFeatures(catalog).map((feature) => feature.id));
for (const feature of allFeatures(catalog)) {
  if (feature.minVersion && feature.minVersion !== packageJson.version) {
    console.log(`note: ${feature.id} needs ${feature.minVersion}`);
  }
}
const feedRaw = JSON.parse(readFileSync(new URL('../announcements.json', import.meta.url), 'utf8')) as { announcements?: Array<{ version?: unknown }> };
const feed = parseAnnouncements(feedRaw);
const versioned = (feedRaw.announcements ?? []).filter((item) => item.version !== undefined);
for (const item of versioned) {
  if (typeof item.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(item.version)) throw new Error(`announcements.json has an invalid version field: ${String(item.version)}`);
}
if (!versioned.some((item) => item.version === packageJson.version)) {
  throw new Error(`announcements.json needs an entry for version ${packageJson.version}`);
}
console.log(`help content ok: package ${packageJson.version}, ${catalog.categories.length} categories, ${ids.size} guides, ${catalog.releases.length} releases, ${catalog.progress.items.length} progress items, ${feed.announcements.length} online announcements, current-version post present`);
