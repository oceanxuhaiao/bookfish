import { randomUUID } from 'node:crypto';

/**
 * The single cross-book reading plan.
 *
 * One plan per library; the array order *is* the reading order. Only books that
 * are still waiting or currently being read live in `items`; anything finished,
 * skipped or removed moves to `archive` so the plan never loses history while
 * keeping reordering trivial (array index).
 *
 * The currently read book is never stored here: it is derived from
 * `LibraryState.selected`. That keeps one source of truth for progress and makes
 * "the active item cannot be pushed aside by a reorder" automatic.
 */
export const PLAN_ITEM_LIMIT = 200;
export const PLAN_ARCHIVE_LIMIT = 300;
export const PLAN_SERIES_LIMIT = 100;

export type PlanSource = 'user' | 'persona';
export type PlanArchiveStatus = 'completed' | 'skipped' | 'removed';

export interface PlanSeries {
  id: string;
  name: string;
  source: 'auto' | 'manual';
  /** Auto-detected groups start unconfirmed; membership never reorders the plan by itself. */
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PlanItem {
  id: string;
  bookKey: string;
  /** Snapshot for display when the shelf entry is temporarily unavailable. */
  title: string;
  author?: string;
  source: PlanSource;
  seriesId: string | null;
  addedAt: number;
  intentId?: string;
  /** When it first became the selected book through the plan. */
  startedAt?: number;
  /** Advisory deferral: auto-advance skips it until then, exactly like the old queue. */
  notBefore?: number;
}

export interface PlanArchiveEntry {
  id: string;
  bookKey: string;
  title: string;
  source: PlanSource;
  seriesId: string | null;
  /** Kept even after the series itself is gone, so history stays readable. */
  seriesName?: string;
  status: PlanArchiveStatus;
  addedAt: number;
  startedAt?: number;
  endedAt: number;
  reason?: string;
}

/**
 * Lifetime counters.
 *
 * `archive` is bounded by PLAN_ARCHIVE_LIMIT, so counting its rows would make a
 * long-time user's total shrink as old entries are trimmed. These counters are
 * the source of truth for "how many books did I finish"; `truncated` is the
 * audit trail that says how many rows are no longer shown.
 */
export interface PlanStats {
  completed: number;
  skipped: number;
  removed: number;
  truncated: number;
  lastArchivedAt?: number;
}

export interface ReadingPlan {
  schema: 1;
  id: string;
  /** Monotonic mutation counter; every write bumps it so stale UIs cannot overwrite silently. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
  items: PlanItem[];
  archive: PlanArchiveEntry[];
  series: PlanSeries[];
  stats: PlanStats;
}

const MAX_TITLE = 200;
const MAX_AUTHOR = 100;
const MAX_KEY = 200;
const MAX_REASON = 300;
const UUID = /^[a-f0-9-]{36}$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid reading plan ${name}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid reading plan ${name}`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid reading plan ${name}`);
  return value;
}

function stamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8_640_000_000_000_000) throw new Error(`Invalid reading plan ${name}`);
  return value as number;
}

function optionalStamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return stamp(value, name);
}

function uuid(value: unknown, name: string): string {
  const id = text(value, name, 64);
  if (!UUID.test(id)) throw new Error(`Invalid reading plan ${name}`);
  return id;
}

export function emptyPlan(now: number, id: string = randomUUID()): ReadingPlan {
  return { schema: 1, id, revision: 0, createdAt: now, updatedAt: now, enabled: true, items: [], archive: [], series: [],
    stats: { completed: 0, skipped: 0, removed: 0, truncated: 0 } };
}

function validateSeries(raw: unknown): PlanSeries {
  const value = record(raw, 'series');
  return {
    id: uuid(value.id, 'series id'),
    name: text(value.name, 'series name', MAX_TITLE),
    source: value.source === 'auto' ? 'auto' : 'manual',
    confirmed: value.confirmed === true,
    createdAt: stamp(value.createdAt, 'series created time'),
    updatedAt: stamp(value.updatedAt, 'series updated time'),
  };
}

function validateItem(raw: unknown): PlanItem {
  const value = record(raw, 'item');
  const source = value.source === 'persona' ? 'persona' : 'user';
  return {
    id: uuid(value.id, 'item id'),
    bookKey: text(value.bookKey, 'item book key', MAX_KEY),
    title: text(value.title, 'item title', MAX_TITLE),
    ...(optionalText(value.author, 'item author', MAX_AUTHOR) ? { author: optionalText(value.author, 'item author', MAX_AUTHOR) } : {}),
    source,
    seriesId: value.seriesId === null || value.seriesId === undefined ? null : uuid(value.seriesId, 'item series id'),
    addedAt: stamp(value.addedAt, 'item added time'),
    ...(optionalText(value.intentId, 'item intent id', 64) ? { intentId: optionalText(value.intentId, 'item intent id', 64) } : {}),
    ...(optionalStamp(value.startedAt, 'item started time') !== undefined ? { startedAt: optionalStamp(value.startedAt, 'item started time') } : {}),
    ...(optionalStamp(value.notBefore, 'item not-before time') !== undefined ? { notBefore: optionalStamp(value.notBefore, 'item not-before time') } : {}),
  };
}

function validateArchive(raw: unknown): PlanArchiveEntry {
  const value = record(raw, 'archive entry');
  if (!['completed', 'skipped', 'removed'].includes(String(value.status))) throw new Error('Invalid reading plan archive status');
  return {
    id: uuid(value.id, 'archive id'),
    bookKey: text(value.bookKey, 'archive book key', MAX_KEY),
    title: text(value.title, 'archive title', MAX_TITLE),
    source: value.source === 'persona' ? 'persona' : 'user',
    seriesId: value.seriesId === null || value.seriesId === undefined ? null : uuid(value.seriesId, 'archive series id'),
    status: value.status as PlanArchiveStatus,
    addedAt: stamp(value.addedAt, 'archive added time'),
    ...(optionalStamp(value.startedAt, 'archive started time') !== undefined ? { startedAt: optionalStamp(value.startedAt, 'archive started time') } : {}),
    endedAt: stamp(value.endedAt, 'archive ended time'),
    ...(optionalText(value.reason, 'archive reason', MAX_REASON) ? { reason: optionalText(value.reason, 'archive reason', MAX_REASON) } : {}),
  };
}

/**
 * Strict validation of a persisted plan. Missing state is a clean, empty plan
 * (not fabricated history); a malformed plan is refused so the caller can keep
 * the previous snapshot instead of silently dropping entries.
 */
export function validatePlan(raw: unknown, now: number): ReadingPlan {
  if (raw === undefined || raw === null) return emptyPlan(now);
  const value = record(raw, 'state');
  if (value.schema !== 1) throw new Error('Unsupported reading plan schema');
  if (!Array.isArray(value.items) || value.items.length > PLAN_ITEM_LIMIT) throw new Error('Invalid reading plan items');
  if (value.archive !== undefined && (!Array.isArray(value.archive) || value.archive.length > PLAN_ARCHIVE_LIMIT)) throw new Error('Invalid reading plan archive');
  if (value.series !== undefined && (!Array.isArray(value.series) || value.series.length > PLAN_SERIES_LIMIT)) throw new Error('Invalid reading plan series');
  const revision = stamp(value.revision, 'revision');
  const items = value.items.map(validateItem);
  const keys = new Set<string>();
  for (const item of items) {
    if (keys.has(item.bookKey)) throw new Error('Duplicate book in reading plan');
    keys.add(item.bookKey);
  }
  const series = (value.series ?? []).map(validateSeries);
  const seriesIds = new Set<string>();
  for (const group of series) {
    if (seriesIds.has(group.id)) throw new Error('Duplicate reading plan series id');
    seriesIds.add(group.id);
  }
  for (const item of items) if (item.seriesId && !seriesIds.has(item.seriesId)) throw new Error('Reading plan item references a missing series');
  const archive = (value.archive ?? []).map(validateArchive);
  return {
    schema: 1,
    id: uuid(value.id, 'plan id'),
    revision,
    createdAt: stamp(value.createdAt, 'created time'),
    updatedAt: stamp(value.updatedAt, 'updated time'),
    enabled: value.enabled !== false,
    items,
    archive,
    series,
    stats: validateStats((value as { stats?: unknown }).stats, archive),
  };
}

/**
 * Lifetime counters. A plan written before they existed is backfilled from the
 * archive it still has, which is the best available lower bound; a snapshot whose
 * counters are smaller than its own archive is rejected rather than trusted.
 */
function validateStats(raw: unknown, archive: readonly PlanArchiveEntry[]): PlanStats {
  const counted = { completed: 0, skipped: 0, removed: 0 };
  for (const entry of archive) counted[entry.status] += 1;
  if (raw === undefined) return { ...counted, truncated: 0 };
  const value = record(raw, 'stats');
  const number = (name: keyof PlanStats): number => {
    const field = value[name];
    if (field === undefined) return name === 'truncated' ? 0 : counted[name as 'completed' | 'skipped' | 'removed'];
    if (!Number.isSafeInteger(field) || (field as number) < 0) throw new Error(`Invalid reading plan stats.${String(name)}`);
    return field as number;
  };
  const stats: PlanStats = { completed: number('completed'), skipped: number('skipped'), removed: number('removed'), truncated: number('truncated') };
  const last = value.lastArchivedAt;
  if (last !== undefined) stats.lastArchivedAt = stamp(last, 'stats time');
  // The archive is a window into history, so it can never hold more of a status
  // than the lifetime counter claims.
  if (stats.completed < counted.completed || stats.skipped < counted.skipped || stats.removed < counted.removed) {
    throw new Error('Reading plan stats are smaller than its own archive');
  }
  return stats;
}

function touch(plan: ReadingPlan, now: number): void {
  plan.revision += 1;
  plan.updatedAt = now;
}

export function planIndexOf(plan: ReadingPlan, itemId: string): number {
  return plan.items.findIndex((item) => item.id === itemId);
}

export function findItem(plan: ReadingPlan, bookKey: string): PlanItem | undefined {
  return plan.items.find((item) => item.bookKey === bookKey);
}

export interface PlanAddInput {
  bookKey: string;
  title: string;
  author?: string;
  source: PlanSource;
  intentId?: string;
  seriesId?: string | null;
  notBefore?: number;
}

export interface PlanAddResult {
  added: PlanItem[];
  duplicates: string[];
  archived: string[];
  overflow: number;
}

/**
 * Append entries in the given order. A book already in the plan (or already
 * archived as completed) is never queued twice: the plan is one list, not a
 * place to pile up accidental duplicates.
 */
export function addPlanItems(plan: ReadingPlan, inputs: readonly PlanAddInput[], now: number): PlanAddResult {
  const added: PlanItem[] = [];
  const duplicates: string[] = [];
  const archived: string[] = [];
  let overflow = 0;
  for (const input of inputs) {
    if (findItem(plan, input.bookKey)) { duplicates.push(input.bookKey); continue; }
    if (plan.archive.some((entry) => entry.bookKey === input.bookKey && entry.status === 'completed')) { archived.push(input.bookKey); continue; }
    if (plan.items.length >= PLAN_ITEM_LIMIT) { overflow += 1; continue; }
    const item: PlanItem = {
      id: randomUUID(), bookKey: input.bookKey,
      title: String(input.title).slice(0, MAX_TITLE) || '未命名小说',
      ...(input.author ? { author: String(input.author).slice(0, MAX_AUTHOR) } : {}),
      source: input.source, seriesId: input.seriesId ?? null, addedAt: now,
      ...(input.intentId ? { intentId: input.intentId } : {}),
      ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    };
    plan.items.push(item);
    added.push(item);
  }
  if (added.length) touch(plan, now);
  return { added, duplicates, archived, overflow };
}

export function archiveItem(plan: ReadingPlan, itemId: string, status: PlanArchiveStatus, now: number, reason?: string): PlanArchiveEntry | undefined {
  const index = planIndexOf(plan, itemId);
  if (index < 0) return undefined;
  const [item] = plan.items.splice(index, 1);
  const entry: PlanArchiveEntry = {
    id: item.id, bookKey: item.bookKey, title: item.title, source: item.source, seriesId: item.seriesId,
    status, addedAt: item.addedAt, ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    endedAt: now, ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}),
  };
  const series = item.seriesId ? plan.series.find((group) => group.id === item.seriesId) : undefined;
  if (series) entry.seriesName = series.name;
  plan.archive.push(entry);
  // The array stays bounded, but the counters never lose a book: `truncated`
  // records exactly how many rows the window pushed out.
  const overflow = plan.archive.length - PLAN_ARCHIVE_LIMIT;
  if (overflow > 0) { plan.archive = plan.archive.slice(overflow); plan.stats.truncated += overflow; }
  if (status === 'completed') plan.stats.completed += 1;
  else if (status === 'skipped') plan.stats.skipped += 1;
  else plan.stats.removed += 1;
  plan.stats.lastArchivedAt = now;
  dropUnusedSeries(plan);
  touch(plan, now);
  return entry;
}

/** Move one waiting item. An item is never moved past nothing: the index is clamped. */
export function movePlanItem(plan: ReadingPlan, itemId: string, target: number, now: number): boolean {
  const index = planIndexOf(plan, itemId);
  if (index < 0) return false;
  const to = Math.max(0, Math.min(plan.items.length - 1, Math.trunc(target)));
  if (to === index) return false;
  const [item] = plan.items.splice(index, 1);
  plan.items.splice(to, 0, item);
  touch(plan, now);
  return true;
}

/** Move a whole series block, preserving the members' relative order. */
export function movePlanSeries(plan: ReadingPlan, seriesId: string, target: number, now: number): boolean {
  const members = plan.items.filter((item) => item.seriesId === seriesId);
  if (members.length === 0) return false;
  const firstIndex = planIndexOf(plan, members[0].id);
  const rest = plan.items.filter((item) => item.seriesId !== seriesId);
  // Target counted against the plan without the block, then clamped.
  const to = Math.max(0, Math.min(rest.length, Math.trunc(target)));
  const next = [...rest.slice(0, to), ...members, ...rest.slice(to)];
  if (next.every((item, i) => item.id === plan.items[i].id)) return false;
  plan.items = next;
  touch(plan, now);
  return true;
}

/** Mark the plan item for this book as the started entry without moving it. */
export function markStarted(plan: ReadingPlan, bookKey: string, now: number): boolean {
  const item = findItem(plan, bookKey);
  if (!item || item.startedAt !== undefined) return false;
  item.startedAt = now;
  touch(plan, now);
  return true;
}

export function setItemSeries(plan: ReadingPlan, itemId: string, seriesId: string | null, now: number): boolean {
  const item = plan.items.find((entry) => entry.id === itemId);
  if (!item || item.seriesId === seriesId) return false;
  item.seriesId = seriesId;
  dropUnusedSeries(plan);
  touch(plan, now);
  return true;
}

export function setPlanEnabled(plan: ReadingPlan, enabled: boolean, now: number): boolean {
  if (plan.enabled === enabled) return false;
  plan.enabled = enabled;
  touch(plan, now);
  return true;
}

export function setItemNotBefore(plan: ReadingPlan, itemId: string, notBefore: number | undefined, now: number): boolean {
  const item = plan.items.find((entry) => entry.id === itemId);
  if (!item) return false;
  if (notBefore === undefined) { if (item.notBefore === undefined) return false; delete item.notBefore; }
  else { if (item.notBefore === notBefore) return false; item.notBefore = notBefore; }
  touch(plan, now);
  return true;
}

export function createSeries(plan: ReadingPlan, name: string, source: 'auto' | 'manual', confirmed: boolean, now: number): PlanSeries {
  const existing = plan.series.find((group) => group.name === name && group.confirmed === confirmed);
  if (existing) return existing;
  if (plan.series.length >= PLAN_SERIES_LIMIT) throw new Error('Reading plan has too many series groups');
  const group: PlanSeries = { id: randomUUID(), name: name.slice(0, MAX_TITLE), source, confirmed, createdAt: now, updatedAt: now };
  plan.series.push(group);
  touch(plan, now);
  return group;
}

/**
 * Remove series groups that no waiting entry belongs to.
 *
 * Archived entries keep the human-readable name and lose the id, so history is
 * never left pointing at a group that no longer exists.
 */
export function dropUnusedSeries(plan: ReadingPlan): void {
  const used = new Set(plan.items.map((item) => item.seriesId).filter((id): id is string => !!id));
  const dropped = plan.series.filter((group) => !used.has(group.id));
  if (!dropped.length) return;
  const names = new Map(dropped.map((group) => [group.id, group.name] as const));
  plan.series = plan.series.filter((group) => used.has(group.id));
  for (const entry of plan.archive) {
    if (!entry.seriesId) continue;
    const name = names.get(entry.seriesId);
    if (!name) continue;
    entry.seriesName = entry.seriesName ?? name;
    entry.seriesId = null;
  }
}

/** Books removed from the shelf leave the plan, but the entry stays in the archive. */
export function reconcilePlan(plan: ReadingPlan, known: ReadonlySet<string>, now: number): boolean {
  let changed = false;
  for (const item of [...plan.items]) {
    if (known.has(item.bookKey)) continue;
    archiveItem(plan, item.id, 'removed', now, 'book_removed');
    changed = true;
  }
  return changed;
}

export interface LegacyQueueRow {
  id: string;
  intentId: string;
  bookKey: string;
  title: string;
  source: 'pet' | 'user';
  status: 'queued' | 'active' | 'done' | 'cancelled' | string;
  addedAt: number;
  updatedAt: number;
  notBefore?: number;
}

/**
 * Old installs kept the pet's queue inside `selection.queue`. It becomes the
 * first version of the single plan: ordering by original add time, terminal rows
 * kept in the archive, and rows whose book is gone dropped (they can never be
 * read again). Idempotent: a plan that already has items is returned untouched.
 */
export function migrateLegacyQueue(queue: readonly LegacyQueueRow[], books: ReadonlyMap<string, { title: string; author?: string }>, now: number): { plan: ReadingPlan; migrated: number; dropped: number } {
  const plan = emptyPlan(now);
  if (plan.items.length === 0 && queue.length === 0) return { plan, migrated: 0, dropped: 0 };
  let migrated = 0, dropped = 0;
  for (const row of [...queue].sort((a, b) => a.addedAt - b.addedAt)) {
    const book = books.get(row.bookKey);
    if (!book) { dropped += 1; continue; }
    if (row.status === 'cancelled') {
      plan.archive.push({ id: row.id, bookKey: row.bookKey, title: row.title, source: row.source === 'pet' ? 'persona' : 'user',
        seriesId: null, status: 'removed', addedAt: row.addedAt, endedAt: row.updatedAt, reason: 'legacy_cancelled' });
      plan.stats.removed += 1;
      migrated += 1; continue;
    }
    if (row.status === 'done') {
      plan.archive.push({ id: row.id, bookKey: row.bookKey, title: row.title, source: row.source === 'pet' ? 'persona' : 'user',
        seriesId: null, status: 'completed', addedAt: row.addedAt, endedAt: row.updatedAt });
      // Migrated rows are history too, so the lifetime counters must see them.
      plan.stats.completed += 1;
      migrated += 1; continue;
    }
    if (plan.items.some((item) => item.bookKey === row.bookKey)) { dropped += 1; continue; }
    plan.items.push({ id: row.id, bookKey: row.bookKey, title: book.title, ...(book.author ? { author: book.author } : {}),
      source: row.source === 'pet' ? 'persona' : 'user', seriesId: null, addedAt: row.addedAt,
      intentId: row.intentId, ...(row.notBefore ? { notBefore: row.notBefore } : {}) });
    migrated += 1;
  }
  // The archive is bounded, so a long legacy queue can overflow it exactly like
  // the live path does; record how many rows the window dropped.
  const overflow = plan.archive.length - PLAN_ARCHIVE_LIMIT;
  if (overflow > 0) { plan.archive = plan.archive.slice(overflow); plan.stats.truncated += overflow; }
  if (plan.archive.length) plan.stats.lastArchivedAt = plan.archive[plan.archive.length - 1].endedAt;
  plan.revision = migrated ? 1 : 0;
  plan.updatedAt = now;
  return { plan, migrated, dropped };
}

// ---------------------------------------------------------------- series hints

export interface SeriesCandidate {
  bookKey: string;
  title: string;
  filename?: string;
  /** Folder path as reported by the file picker or a ZIP entry, e.g. `斗罗大陆/01.txt`. */
  relativePath?: string;
}

export interface SeriesSuggestion {
  /** Stable-ish key for the proposal (base name, folder or filename stem). */
  key: string;
  name: string;
  bookKeys: string[];
  evidence: 'folder' | 'title' | 'filename';
  /** High only when the folder or the stripped title itself is distinctive. */
  confidence: 'high' | 'low';
  /** Foreign/extra volumes and ambiguous markers require an explicit human decision. */
  ambiguous: boolean;
}

const GENERIC_FOLDERS = new Set(['txt', 'txts', 'book', 'books', 'novel', 'novels', '小说', '下载', 'download', 'downloads', '新建文件夹', '文档', 'bookshelf', '电子书']);
const AMBIGUOUS_MARKERS = /(外传|番外|前传|后传|续集|续作|番外篇|合集|全集|同人|短篇集)/u;
const VOLUME_PATTERN = /(?:第\s*([零〇一二三四五六七八九十百千两0-9]+)\s*[部卷册集季篇])|(?:卷\s*([零〇一二三四五六七八九十百千两0-9]+))|(?:[（(]\s*([零〇一二三四五六七八九十0-9]+)\s*[)）])|(?:^|[^\p{L}\d])([上中下])\s*册?$|(?:[（(]\s*([上中下])\s*[)）])/u;

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function chineseNumber(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value);
  let total = 0, section = 0, digit = 0;
  for (const char of value) {
    if (CN_DIGITS[char] !== undefined) digit = CN_DIGITS[char];
    else if (char === '十') { section += (digit || 1) * 10; digit = 0; }
    else if (char === '百') { section += (digit || 1) * 100; digit = 0; }
    else if (char === '千') { section += (digit || 1) * 1000; digit = 0; }
    else return null;
  }
  total += section + digit;
  return total || null;
}

/** Volume number a title declares, for a *suggested* internal order only. */
export function volumeOf(title: string): { volume: number; base: string } | null {
  const trimmed = title.trim();
  const match = VOLUME_PATTERN.exec(trimmed);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3];
  if (match[4] || match[5]) {
    const marker = match[4] ?? match[5];
    const volume = marker === '上' ? 1 : marker === '中' ? 2 : 3;
    const base = match[5] ? trimmed.slice(0, match.index).trim()
      : trimmed.slice(0, match.index + (match[0].length - marker.length)).trim();
    return { volume, base };
  }
  const volume = raw ? chineseNumber(raw) : null;
  if (!volume) return null;
  return { volume, base: trimmed.slice(0, match.index).trim() };
}

function stemOf(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? name;
  return base.replace(/\.(txt|md|epub|pdf)$/iu, '').trim();
}

function filenameBase(name: string): string {
  return stemOf(name).replace(/[\s._-]*(\d{1,3}|[零〇一二三四五六七八九十百]+)\s*$/u, '').replace(/[（(]\s*\d+\s*[)）]\s*$/u, '').trim();
}

/**
 * Grouping proposals only. Nothing here writes to the plan: the caller shows the
 * proposals and a human confirms. A folder or title that could equally be one
 * split novel gets `ambiguous: true` instead of being merged behind the user's back.
 */
export function suggestSeries(candidates: readonly SeriesCandidate[]): SeriesSuggestion[] {
  const byFolder = new Map<string, SeriesCandidate[]>();
  const byTitle = new Map<string, SeriesCandidate[]>();
  const byFilename = new Map<string, SeriesCandidate[]>();
  for (const candidate of candidates) {
    const relative = candidate.relativePath ?? '';
    const folder = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    const folderName = folder.split('/').filter(Boolean).pop() ?? '';
    if (folderName && !GENERIC_FOLDERS.has(folderName.toLowerCase())) {
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), candidate]);
    }
    const volume = volumeOf(candidate.title);
    if (volume && volume.base.length >= 2) byTitle.set(volume.base, [...(byTitle.get(volume.base) ?? []), candidate]);
    const base = filenameBase(candidate.filename ?? candidate.title);
    if (base.length >= 2 && (candidate.filename ?? '').length > base.length + 1) {
      byFilename.set(base, [...(byFilename.get(base) ?? []), candidate]);
    }
  }
  const suggestions: SeriesSuggestion[] = [];
  const claimed = new Set<string>();
  const push = (key: string, name: string, rows: SeriesCandidate[], evidence: SeriesSuggestion['evidence'], confidence: 'high' | 'low') => {
    const fresh = rows.filter((row) => !claimed.has(row.bookKey));
    if (fresh.length < 2) return;
    for (const row of fresh) claimed.add(row.bookKey);
    suggestions.push({
      key, name: name.slice(0, MAX_TITLE), bookKeys: fresh.map((row) => row.bookKey), evidence, confidence,
      ambiguous: fresh.some((row) => AMBIGUOUS_MARKERS.test(row.title)) || fresh.length > 30,
    });
  };
  // Explicit folder structure is the strongest hint, then a shared base title.
  for (const [folder, rows] of byFolder) push('folder:' + folder, folder.split('/').filter(Boolean).pop() ?? folder, rows, 'folder', 'high');
  for (const [base, rows] of byTitle) push('title:' + base, base, rows, 'title', base.length >= 3 ? 'high' : 'low');
  for (const [base, rows] of byFilename) push('file:' + base, base, rows, 'filename', 'low');
  return suggestions;
}

/** Suggested internal order for a proposal: declared volume first, then name. */
export function orderSuggestion(rows: readonly { bookKey: string; title: string }[]): string[] {
  return [...rows].sort((a, b) => {
    const va = volumeOf(a.title), vb = volumeOf(b.title);
    if (va && vb && va.volume !== vb.volume) return va.volume - vb.volume;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  }).map((row) => row.bookKey);
}
