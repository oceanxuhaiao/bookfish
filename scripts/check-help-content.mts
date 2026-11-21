import { readFileSync } from 'node:fs';
import { loadHelpCatalog, validateHelpCatalog, validateHelpLinks, allFeatures } from '../src/help-content.ts';

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
console.log(`help content ok: package ${packageJson.version}, ${catalog.categories.length} categories, ${ids.size} guides, ${catalog.releases.length} releases, ${catalog.progress.items.length} progress items`);
