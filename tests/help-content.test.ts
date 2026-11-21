import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpContentError, allFeatures, compareVersions, loadHelpCatalog, readGuide, validateHelpCatalog, validateHelpLinks } from '../src/help-content.ts';
import { BOOKFISH_VERSION } from '../src/version.ts';

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-help-content-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('help content catalog', () => {
  it('matches the package version and every feature has loadable content', () => {
    const catalog = loadHelpCatalog();
    expect(catalog.currentVersion).toBe('0.64.8');
    expect(catalog.currentVersion).toBe(BOOKFISH_VERSION);
    expect(catalog.categories).toHaveLength(7);
    expect(allFeatures(catalog)).toHaveLength(19);
    expect(new Set(allFeatures(catalog).map((feature) => feature.id)).size).toBe(19);
    for (const feature of allFeatures(catalog)) {
      expect(readGuide(catalog, feature.id).markdown.length).toBeGreaterThan(80);
    }
  });

  it('keeps the internal help links resolvable', () => {
    const catalog = loadHelpCatalog();
    expect(() => validateHelpLinks(catalog)).not.toThrow();
    const ids = new Set(allFeatures(catalog).map((feature) => feature.id));
    for (const feature of allFeatures(catalog)) {
      const body = readFileSync(join(catalog.root, ...feature.contentPath.split('/')), 'utf8');
      for (const match of body.matchAll(/\]\(help:([a-z0-9-]+)\)/gu)) expect(ids.has(match[1]!)).toBe(true);
    }
  });

  it('rejects a package version that does not match the content', () => {
    const catalog = loadHelpCatalog();
    expect(() => validateHelpCatalog(catalog, '0.63.1')).toThrow(HelpContentError);
  });

  it('rejects duplicate feature ids and missing resources', () => {
    const catalog = loadHelpCatalog();
    const duplicate = structuredClone(catalog);
    duplicate.categories[0]!.features.push(structuredClone(duplicate.categories[0]!.features[0]!));
    expect(() => validateHelpCatalog(duplicate)).toThrow(/Duplicate feature id/u);
    const missing = structuredClone(catalog);
    missing.categories[0]!.features[0]!.contentPath = 'guides/not-there.md';
    expect(() => validateHelpCatalog(missing)).toThrow(/content is missing/u);
  });

  it('rejects an unknown internal link before it ships', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'guides'), { recursive: true });
    writeFileSync(join(root, 'features.json'), JSON.stringify({
      schema: 1, updatedAt: '2026-11-21',
      categories: [{ id: 'start', title: '开始', summary: '开始使用', icon: '📖', features: [{ id: 'first', title: '第一项', summary: '一项', icon: '·', contentPath: 'guides/first.md', minVersion: null, enabled: true }] }],
    }), 'utf8');
    writeFileSync(join(root, 'releases.json'), JSON.stringify({
      schema: 1, updatedAt: '2026-11-21', currentVersion: '1.0.0',
      releases: [{ version: '1.0.0', releaseDate: '2026-11-21', type: 'minor', majorAnnouncement: false, title: '更新', summary: '说明', items: [{ kind: 'note', text: '记录' }] }],
    }), 'utf8');
    writeFileSync(join(root, 'progress.json'), JSON.stringify({ schema: 1, updatedAt: '2026-11-21', items: [] }), 'utf8');
    writeFileSync(join(root, 'guides', 'first.md'), '# 第一项\n\n[broken](help:no-such-feature)\n', 'utf8');
    expect(() => validateHelpLinks(loadHelpCatalog({ root }))).toThrow(/unknown help id/u);
  });

  it('compares versions without treating 0.9.0 as newer than 0.10.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
