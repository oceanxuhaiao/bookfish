import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static, user-facing help content. It is deliberately separate from the
 * model-facing protocol files under src/protocol/: the help center is display
 * data and must never be injected into a model context or read through
 * bookfish_help().
 */

export interface HelpFeature {
  id: string;
  title: string;
  summary: string;
  icon: string;
  contentPath: string;
  minVersion: string | null;
  enabled: boolean;
  experimental?: boolean;
}

export interface HelpCategory {
  id: string;
  title: string;
  summary: string;
  icon: string;
  features: HelpFeature[];
}

export interface ReleaseItem {
  kind: 'feature' | 'improvement' | 'fix' | 'compatibility' | 'note';
  text: string;
}

export interface ReleaseRecord {
  version: string;
  releaseDate: string;
  type: 'major' | 'minor' | 'patch';
  majorAnnouncement: boolean;
  announcementId?: string;
  title: string;
  summary: string;
  items: ReleaseItem[];
  compatibility?: string[];
  technical?: string[];
}

export type ProgressStatus = 'planned' | 'developing' | 'testing' | 'accepted' | 'released' | 'paused';

export interface ProgressItem {
  id: string;
  title: string;
  status: ProgressStatus;
  summary: string;
  updatedAt: string;
  scope?: string;
}

export interface HelpCatalog {
  root: string;
  updatedAt: string;
  currentVersion: string;
  categories: HelpCategory[];
  releases: ReleaseRecord[];
  progress: { updatedAt: string; items: ProgressItem[] };
}

function defaultHelpRoot(): string {
  try {
    return fileURLToPath(new URL('../assets/help/', import.meta.url));
  } catch {
    // jsdom-based UI tests expose an http(s) import.meta.url; the package root
    // is still the test process working directory.
    return join(process.cwd(), 'assets', 'help');
  }
}

export const DEFAULT_HELP_ROOT = defaultHelpRoot();

const SEMVER = /^\d+\.\d+\.\d+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ITEM_KINDS = new Set(['feature', 'improvement', 'fix', 'compatibility', 'note']);
const PROGRESS_STATUSES = new Set<ProgressStatus>(['planned', 'developing', 'testing', 'accepted', 'released', 'paused']);

export class HelpContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelpContentError';
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HelpContentError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HelpContentError(`${what} must be non-empty text`);
  return value.trim();
}

function optionalText(value: unknown, what: string, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, what, max);
}

function date(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new HelpContentError(`${what} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HelpContentError(`${what} is not a valid date`);
  return value;
}

function semver(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SEMVER.test(value)) throw new HelpContentError(`${what} must be x.y.z`);
  return value;
}

/** Compare two simple x.y.z versions; returns <0, 0 or >0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function contentPath(value: unknown): string {
  const path = text(value, 'contentPath', 300).replaceAll('\\', '/');
  if (!/^guides\/[a-z0-9][a-z0-9-]*\.md$/u.test(path)) throw new HelpContentError(`Unsafe contentPath: ${path}`);
  return path;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new HelpContentError(`Cannot read ${file}: ${String(error)}`);
  }
}

function parseFeatures(raw: unknown): { updatedAt: string; categories: HelpCategory[] } {
  const root = object(raw, 'features.json');
  if (root.schema !== 1) throw new HelpContentError('features.json schema must be 1');
  const updatedAt = date(root.updatedAt, 'features.updatedAt');
  if (!Array.isArray(root.categories) || !root.categories.length) throw new HelpContentError('features.categories must be a non-empty array');
  const categoryIds = new Set<string>();
  const featureIds = new Set<string>();
  const categories: HelpCategory[] = root.categories.map((value, categoryIndex) => {
    const category = object(value, `categories[${categoryIndex}]`);
    const id = text(category.id, 'category.id', 60);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new HelpContentError(`Invalid category id: ${id}`);
    if (categoryIds.has(id)) throw new HelpContentError(`Duplicate category id: ${id}`);
    categoryIds.add(id);
    if (!Array.isArray(category.features) || !category.features.length) throw new HelpContentError(`Category ${id} has no features`);
    const features: HelpFeature[] = category.features.map((entry, featureIndex) => {
      const feature = object(entry, `${id}.features[${featureIndex}]`);
      const featureId = text(feature.id, `${id}.feature.id`, 80);
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(featureId)) throw new HelpContentError(`Invalid feature id: ${featureId}`);
      if (featureIds.has(featureId)) throw new HelpContentError(`Duplicate feature id: ${featureId}`);
      featureIds.add(featureId);
      const minVersion = feature.minVersion === undefined || feature.minVersion === null ? null : semver(feature.minVersion, `${featureId}.minVersion`);
      return {
        id: featureId,
        title: text(feature.title, `${featureId}.title`, 100),
        summary: text(feature.summary, `${featureId}.summary`, 200),
        icon: optionalText(feature.icon, `${featureId}.icon`, 8) ?? '·',
        contentPath: contentPath(feature.contentPath),
        minVersion,
        enabled: feature.enabled !== false,
        ...(feature.experimental === true ? { experimental: true } : {}),
      };
    });
    return {
      id,
      title: text(category.title, `${id}.title`, 100),
      summary: text(category.summary, `${id}.summary`, 200),
      icon: optionalText(category.icon, `${id}.icon`, 8) ?? '·',
      features,
    };
  });
  return { updatedAt, categories };
}

function parseReleases(raw: unknown): { updatedAt: string; currentVersion: string; releases: ReleaseRecord[] } {
  const root = object(raw, 'releases.json');
  if (root.schema !== 1) throw new HelpContentError('releases.json schema must be 1');
  const updatedAt = date(root.updatedAt, 'releases.updatedAt');
  const currentVersion = semver(root.currentVersion, 'releases.currentVersion');
  if (!Array.isArray(root.releases) || !root.releases.length) throw new HelpContentError('releases.releases must be a non-empty array');
  const versions = new Set<string>();
  const announcementIds = new Set<string>();
  const releases: ReleaseRecord[] = root.releases.map((value, index) => {
    const release = object(value, `releases[${index}]`);
    const version = semver(release.version, `releases[${index}].version`);
    if (versions.has(version)) throw new HelpContentError(`Duplicate release version: ${version}`);
    versions.add(version);
    const majorAnnouncement = release.majorAnnouncement === true;
    const announcementId = optionalText(release.announcementId, `${version}.announcementId`, 100);
    if (majorAnnouncement) {
      if (!announcementId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(announcementId)) throw new HelpContentError(`${version} major announcement needs a stable announcementId`);
      if (announcementIds.has(announcementId)) throw new HelpContentError(`Duplicate announcementId: ${announcementId}`);
      announcementIds.add(announcementId);
    }
    if (!Array.isArray(release.items)) throw new HelpContentError(`${version}.items must be an array`);
    const items: ReleaseItem[] = release.items.map((entry, itemIndex) => {
      const item = object(entry, `${version}.items[${itemIndex}]`);
      const kind = text(item.kind, `${version}.items[${itemIndex}].kind`, 20) as ReleaseItem['kind'];
      if (!ITEM_KINDS.has(kind)) throw new HelpContentError(`Unknown release item kind: ${kind}`);
      return { kind, text: text(item.text, `${version}.items[${itemIndex}].text`, 500) };
    });
    const list = (value: unknown, what: string): string[] | undefined => {
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value)) throw new HelpContentError(`${what} must be an array`);
      return value.map((entry, itemIndex) => text(entry, `${what}[${itemIndex}]`, 500));
    };
    const type = text(release.type, `${version}.type`, 20) as ReleaseRecord['type'];
    if (!['major', 'minor', 'patch'].includes(type)) throw new HelpContentError(`${version}.type must be major, minor or patch`);
    return {
      version,
      releaseDate: date(release.releaseDate, `${version}.releaseDate`),
      type,
      majorAnnouncement,
      ...(announcementId ? { announcementId } : {}),
      title: text(release.title, `${version}.title`, 120),
      summary: text(release.summary, `${version}.summary`, 300),
      items,
      ...(list(release.compatibility, `${version}.compatibility`) ? { compatibility: list(release.compatibility, `${version}.compatibility`)! } : {}),
      ...(list(release.technical, `${version}.technical`) ? { technical: list(release.technical, `${version}.technical`)! } : {}),
    };
  });
  if (!releases.some((release) => release.version === currentVersion)) throw new HelpContentError(`No release record for current version ${currentVersion}`);
  if (!['major', 'minor', 'patch'].includes(releases.find((release) => release.version === currentVersion)!.type)) throw new HelpContentError('Current release type must be major, minor or patch');
  return { updatedAt, currentVersion, releases };
}

function parseProgress(raw: unknown): { updatedAt: string; items: ProgressItem[] } {
  const root = object(raw, 'progress.json');
  if (root.schema !== 1) throw new HelpContentError('progress.json schema must be 1');
  const updatedAt = date(root.updatedAt, 'progress.updatedAt');
  if (!Array.isArray(root.items)) throw new HelpContentError('progress.items must be an array');
  const ids = new Set<string>();
  const items: ProgressItem[] = root.items.map((value, index) => {
    const item = object(value, `progress.items[${index}]`);
    const id = text(item.id, `progress.items[${index}].id`, 80);
    if (ids.has(id)) throw new HelpContentError(`Duplicate progress id: ${id}`);
    ids.add(id);
    const status = text(item.status, `${id}.status`, 20) as ProgressStatus;
    if (!PROGRESS_STATUSES.has(status)) throw new HelpContentError(`Unknown progress status: ${status}`);
    return {
      id,
      title: text(item.title, `${id}.title`, 120),
      status,
      summary: text(item.summary, `${id}.summary`, 400),
      updatedAt: date(item.updatedAt, `${id}.updatedAt`),
      ...(optionalText(item.scope, `${id}.scope`, 120) ? { scope: optionalText(item.scope, `${id}.scope`, 120)! } : {}),
    };
  });
  return { updatedAt, items };
}

/**
 * Load and structurally validate the bundled content. A broken optional
 * historical record should not keep the World from mounting: the caller owns
 * that policy and can show a friendly help-center error instead.
 */
export function loadHelpCatalog(options: { root?: string } = {}): HelpCatalog {
  const root = resolve(options.root ?? DEFAULT_HELP_ROOT);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HelpContentError(`Help content directory not found: ${root}`);
  const features = parseFeatures(readJson(join(root, 'features.json')));
  const releases = parseReleases(readJson(join(root, 'releases.json')));
  const progress = parseProgress(readJson(join(root, 'progress.json')));
  const catalog: HelpCatalog = { root, updatedAt: features.updatedAt, currentVersion: releases.currentVersion,
    categories: features.categories, releases: releases.releases, progress };
  validateHelpCatalog(catalog);
  return catalog;
}

/** Content checks that need the whole catalog: paths, versions and internal links. */
export function validateHelpCatalog(catalog: HelpCatalog, packageVersion?: string): void {
  const seen = new Set<string>();
  for (const category of catalog.categories) {
    for (const feature of category.features) {
      if (seen.has(feature.id)) throw new HelpContentError(`Duplicate feature id: ${feature.id}`);
      seen.add(feature.id);
      if (feature.minVersion && compareVersions(feature.minVersion, catalog.currentVersion) > 0) throw new HelpContentError(`${feature.id} needs ${feature.minVersion}, newer than ${catalog.currentVersion}`);
      const file = join(catalog.root, ...feature.contentPath.split('/'));
      if (!existsSync(file) || !statSync(file).isFile()) throw new HelpContentError(`${feature.id} content is missing: ${feature.contentPath}`);
      if (statSync(file).size === 0) throw new HelpContentError(`${feature.id} content is empty`);
    }
  }
  if (packageVersion !== undefined && packageVersion !== catalog.currentVersion) throw new HelpContentError(`Help content is for ${catalog.currentVersion}, package is ${packageVersion}`);
}

/**
 * Release-time check only. Reading every guide here would defeat the point of
 * loading a guide when the user opens it, so runtime startup validates paths
 * and `pnpm check:help` validates the actual link targets.
 */
export function validateHelpLinks(catalog: HelpCatalog): void {
  const featureIds = new Set(allFeatures(catalog).map((feature) => feature.id));
  for (const feature of allFeatures(catalog)) {
    const file = join(catalog.root, ...feature.contentPath.split('/'));
    const body = readFileSync(file, 'utf8');
    if (!body.trim()) throw new HelpContentError(`${feature.id} content is empty`);
    for (const match of body.matchAll(/\]\(help:([a-z0-9][a-z0-9-]*)\)/gu)) {
      if (!featureIds.has(match[1]!)) throw new HelpContentError(`${feature.contentPath} links to unknown help id ${match[1]}`);
    }
  }
}

export function allFeatures(catalog: HelpCatalog): HelpFeature[] {
  return catalog.categories.flatMap((category) => category.features);
}

export function findFeature(catalog: HelpCatalog, id: string): HelpFeature | undefined {
  return allFeatures(catalog).find((feature) => feature.id === id);
}

export function readGuide(catalog: HelpCatalog, id: string): { feature: HelpFeature; markdown: string } {
  const feature = findFeature(catalog, id);
  if (!feature) throw new HelpContentError(`Unknown help feature: ${id}`);
  if (!feature.enabled) throw new HelpContentError(`Help feature is not available: ${id}`);
  if (feature.minVersion && compareVersions(feature.minVersion, catalog.currentVersion) > 0) throw new HelpContentError(`Help feature is not available in this version: ${id}`);
  const file = join(catalog.root, ...feature.contentPath.split('/'));
  try {
    return { feature, markdown: readFileSync(file, 'utf8') };
  } catch (error) {
    throw new HelpContentError(`Cannot read ${feature.contentPath}: ${String(error)}`);
  }
}

export function releaseFor(catalog: HelpCatalog, version?: string): ReleaseRecord {
  const wanted = version ?? catalog.currentVersion;
  const release = catalog.releases.find((entry) => entry.version === wanted);
  if (!release) throw new HelpContentError(`Unknown release: ${wanted}`);
  return release;
}

export function releaseSummaries(catalog: HelpCatalog): Array<Pick<ReleaseRecord, 'version' | 'releaseDate' | 'type' | 'majorAnnouncement' | 'title' | 'summary'>> {
  return [...catalog.releases]
    .sort((left, right) => compareVersions(right.version, left.version))
    .map(({ version, releaseDate, type, majorAnnouncement, title, summary }) => ({ version, releaseDate, type, majorAnnouncement, title, summary }));
}

/** Resolve the newest major announcement that applies at or below `version`. */
export function newestMajorAnnouncement(catalog: HelpCatalog, version: string): ReleaseRecord | undefined {
  return catalog.releases
    .filter((release) => release.majorAnnouncement && release.announcementId && compareVersions(release.version, version) <= 0)
    .sort((left, right) => compareVersions(right.version, left.version))[0];
}

export function isHelpContentError(error: unknown): error is HelpContentError {
  return error instanceof HelpContentError;
}
