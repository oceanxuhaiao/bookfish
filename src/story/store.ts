import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { fingerprintPackParts, validatePackTree as validatePackTreeCore, normalizeName } from './core.ts';

const MAX_DB = 256 * 1024 * 1024;
const MAX_ROW = 64 * 1024;
const KINDS = new Set(['entity', 'event', 'relation', 'rule', 'reveal', 'location']);
const SOURCE_KINDS = new Set(['original_explicit', 'model_interpretation', 'persona_recorded_opinion', 'user_supplied', 'unverified']);
const STATUSES = new Set(['candidate', 'evidence_linked', 'disputed', 'superseded']);

export interface StoryEvidence {
  segmentId: number;
  start?: number;
  end?: number;
  quote?: string;
}

export interface StoryChange {
  kind: string;
  summary: string;
  names?: string[];
  aliases?: string[];
  fromName?: string | null;
  toName?: string | null;
  fromEntityId?: string | null;
  toEntityId?: string | null;
  relation?: string | null;
  outcome?: string | null;
  storyTime?: string | null;
  evidence: StoryEvidence[];
  sourceKind?: string;
  status?: string;
  storyOrder?: number;
}

export interface StoryRecord {
  id: string;
  bookKey: string;
  bookRevision: string;
  contentVersion: number | null;
  level: 'entity' | 'event' | 'relation';
  kind: string;
  status: string;
  sourceKind: string;
  generation: number;
  revealedAt: number;
  storyOrder: number | null;
  payload: StoryChange;
  evidence: StoryEvidence[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryCaptureInput {
  bookKey: string;
  bookRevision: string;
  contentVersion: number | null;
  frontier: number;
  requestId: string;
  changes: StoryChange[];
}

export interface StoryCaptureResult {
  duplicate: boolean;
  generation: number;
  records: StoryRecord[];
}

export interface StoryPackInput {
  id?: string;
  bookKey: string;
  bookRevision: string;
  contentVersion: number | null;
  frontier: number;
  level: 'book' | 'arc' | 'scene';
  label?: string;
  summary: string;
  parentId?: string | null;
  childIds?: string[];
  eventIds: string[];
  relationIds?: string[];
  coveredRanges: Array<{ from: number; to: number }>;
  openQuestions?: string[];
  expectedGeneration?: number;
  /** active is reserved for publishPack; compile-time prevents direct active writes. */
  status?: 'draft';
}

export interface StoryEntityRecord {
  entityId: string;
  bookKey: string;
  contentVersion: number | null;
  canonicalName: string;
  aliases: string[];
  status: 'candidate' | 'bound' | 'conflict';
  firstRevealedAt: number;
  evidence: StoryEvidence[];
  createdAt: number;
  updatedAt: number;
}
export interface StoryPackRecord extends Omit<StoryPackInput, 'status'> {
  id: string;
  generation: number;
  inputFingerprint: string;
  outputFingerprint: string;
  status: 'active' | 'superseded' | 'stale' | 'draft' | 'legacy-unverified';
  createdAt: number;
  updatedAt: number;
}

export interface StoryStoreOptions {
  readOnly?: boolean;
  now?: () => number;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function integer(value: unknown, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${name} must be a safe integer >= ${min}`);
  return value as number;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string <= ${max}`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be a string <= ${max}`);
  return value;
}

function textArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} strings`);
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength) throw new Error(`${name} contains an invalid string`);
    return item;
  });
}

function normalizeEvidence(value: unknown, frontier: number): StoryEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('evidence must contain 1–4 references');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid evidence reference');
    const ref = item as Record<string, unknown>;
    const segmentId = integer(ref.segmentId, 'segmentId');
    if (segmentId >= frontier) throw new Error('evidence cites an unread segment');
    const start = ref.start === undefined ? undefined : integer(ref.start, 'start');
    const end = ref.end === undefined ? undefined : integer(ref.end, 'end');
    const quote = optionalText(ref.quote, 'quote', 120) ?? undefined;
    return { segmentId, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), ...(quote === undefined ? {} : { quote }) };
  });
}

function normalizeChange(value: unknown, frontier: number): StoryChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('change must be an object');
  const raw = value as Record<string, unknown>;
  const kind = text(raw.kind, 'kind', 20);
  if (!KINDS.has(kind)) throw new Error('invalid change kind');
  const summary = text(raw.summary, 'summary', 240);
  const sourceKind = raw.sourceKind === undefined ? 'model_interpretation' : text(raw.sourceKind, 'sourceKind', 40);
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error('invalid sourceKind');
  const status = raw.status === undefined ? 'candidate' : text(raw.status, 'status', 30);
  if (!STATUSES.has(status)) throw new Error('invalid status');
  const change: StoryChange = {
    kind, summary,
    names: textArray(raw.names, 'names', 8, 60),
    aliases: textArray(raw.aliases, 'aliases', 8, 60),
    fromName: optionalText(raw.fromName, 'fromName', 60),
    toName: optionalText(raw.toName, 'toName', 60),
    fromEntityId: optionalText(raw.fromEntityId, 'fromEntityId', 80),
    toEntityId: optionalText(raw.toEntityId, 'toEntityId', 80),
    relation: optionalText(raw.relation, 'relation', 80),
    outcome: optionalText(raw.outcome, 'outcome', 240),
    storyTime: optionalText(raw.storyTime, 'storyTime', 80),
    evidence: normalizeEvidence(raw.evidence, frontier),
    sourceKind, status,
  };
  if (raw.storyOrder !== undefined) {
    if (!Number.isFinite(raw.storyOrder)) throw new Error('storyOrder must be finite');
    change.storyOrder = raw.storyOrder as number;
  }
  if (kind === 'relation') {
    if (!change.relation) throw new Error('relation changes need a relation label');
    if ((!change.fromName && !change.fromEntityId) || (!change.toName && !change.toEntityId)) throw new Error('relation changes need both sides');
  }
  return change;
}

function versionKey(contentVersion: number | null): number {
  return contentVersion === null ? -1 : contentVersion;
}

function levelOf(kind: string): StoryRecord['level'] {
  return kind === 'relation' ? 'relation' : kind === 'entity' || kind === 'rule' || kind === 'location' ? 'entity' : 'event';
}

export class StoryStore {
  private db?: Database;
  readonly path: string;
  private readonly now: () => number;
  constructor(path: string, private readonly options: StoryStoreOptions = {}) {
    this.path = path;
    this.now = options.now ?? Date.now;
  }

  open() {
    if (this.db) return;
    if (existsSync(this.path) && statSync(this.path).size > MAX_DB) throw new Error('Story memory database exceeds 256 MiB');
    this.db = new DatabaseSync(this.path, { readOnly: this.options.readOnly });
    this.db.exec('PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;');
    if (!this.options.readOnly) {
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS story_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS story_batch(
          bookKey TEXT NOT NULL, contentVersion INTEGER NOT NULL, requestId TEXT NOT NULL,
          inputHash TEXT NOT NULL, recordIds TEXT NOT NULL, generation INTEGER NOT NULL, createdAt INTEGER NOT NULL,
          PRIMARY KEY(bookKey, contentVersion, requestId));
        CREATE TABLE IF NOT EXISTS story_record(
          id TEXT PRIMARY KEY, bookKey TEXT NOT NULL, bookRevision TEXT NOT NULL, contentVersion INTEGER NOT NULL,
          level TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, sourceKind TEXT NOT NULL,
          generation INTEGER NOT NULL, revealedAt INTEGER NOT NULL, storyOrder INTEGER,
          payload TEXT NOT NULL, evidence TEXT NOT NULL, hash TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS story_cleanup(
          bookKey TEXT PRIMARY KEY, reason TEXT NOT NULL, attempts INTEGER NOT NULL, lastError TEXT,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS story_entity_alias(
          entityId TEXT NOT NULL, alias TEXT NOT NULL, revealedAt INTEGER NOT NULL, evidence TEXT NOT NULL,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(entityId,alias));
        CREATE TABLE IF NOT EXISTS story_entity(
          entityId TEXT PRIMARY KEY, bookKey TEXT NOT NULL, contentVersion INTEGER NOT NULL,
          canonicalName TEXT NOT NULL, aliases TEXT NOT NULL, status TEXT NOT NULL,
          firstRevealedAt INTEGER NOT NULL, evidence TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS story_pack(          id TEXT NOT NULL, generation INTEGER NOT NULL, bookKey TEXT NOT NULL, bookRevision TEXT NOT NULL,
          contentVersion INTEGER NOT NULL, frontier INTEGER NOT NULL, level TEXT NOT NULL, label TEXT, summary TEXT NOT NULL,
          parentId TEXT, childIds TEXT NOT NULL, eventIds TEXT NOT NULL, relationIds TEXT NOT NULL,
          coveredRanges TEXT NOT NULL, openQuestions TEXT NOT NULL, inputFingerprint TEXT NOT NULL,
          outputFingerprint TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          PRIMARY KEY(id, bookKey, contentVersion, generation));
        CREATE INDEX IF NOT EXISTS story_pack_book ON story_pack(bookKey, contentVersion, status, generation);
        CREATE INDEX IF NOT EXISTS story_record_book ON story_record(bookKey, contentVersion, generation, id);
        CREATE INDEX IF NOT EXISTS story_record_reveal ON story_record(bookKey, revealedAt);
        INSERT INTO story_meta(key,value) VALUES('schemaVersion','1') ON CONFLICT(key) DO NOTHING;
        INSERT INTO story_meta(key,value) VALUES('contractVersion','ssm-v1') ON CONFLICT(key) DO NOTHING;
        INSERT INTO story_meta(key,value) VALUES('changeSeq','0') ON CONFLICT(key) DO NOTHING;
      `);
      const policy = this.sql.prepare("SELECT value FROM story_meta WHERE key='packPublishPolicy'").get() as { value?: string } | undefined;
      if (!policy) {
        this.sql.exec("UPDATE story_pack SET status='legacy-unverified' WHERE status='active'; INSERT INTO story_meta(key,value) VALUES('packPublishPolicy','strict-v1');");
      }
    }
    const check = this.sql.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!check || Object.values(check)[0] !== 'ok') throw new Error('Story memory database is corrupt');
    const meta = this.sql.prepare("SELECT value FROM story_meta WHERE key='schemaVersion'").get() as { value?: string } | undefined;
    if (meta?.value !== '1') throw new Error('Unsupported story memory schema');
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  private get sql(): Database {
    if (!this.db) throw new Error('Story memory store is closed');
    return this.db;
  }

  private hasTable(name: string, schema = 'main'): boolean {
    return !!this.sql.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(name);
  }

  private bumpChangeSeq() {
    this.sql.prepare("INSERT INTO story_meta(key,value) VALUES('changeSeq','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
  }

  changeSeq(): number {
    this.open();
    const row = this.sql.prepare("SELECT value FROM story_meta WHERE key='changeSeq'").get() as { value?: string } | undefined;
    return Number(row?.value ?? 0);
  }

  status() {
    this.open();
    const records = Number((this.sql.prepare('SELECT COUNT(*) AS n FROM story_record').get() as { n: number }).n);
    const batches = Number((this.sql.prepare('SELECT COUNT(*) AS n FROM story_batch').get() as { n: number }).n);
    const pendingCleanups = this.hasTable('story_cleanup') ? Number((this.sql.prepare('SELECT COUNT(*) AS n FROM story_cleanup').get() as { n: number }).n) : 0;
    const packs = this.hasTable('story_pack') ? Number((this.sql.prepare("SELECT COUNT(*) AS n FROM story_pack WHERE status='active'").get() as { n: number }).n) : 0;
    const changeSeq = Number((this.sql.prepare("SELECT value FROM story_meta WHERE key='changeSeq'").get() as { value?: string } | undefined)?.value ?? 0);
    return { path: this.path, schemaVersion: 1, records, batches, pendingCleanups, packs, changeSeq, readOnly: !!this.options.readOnly };
  }

  private decode(row: Record<string, unknown>): StoryRecord {
    const payload = JSON.parse(String(row.payload)) as StoryChange;
    const evidence = JSON.parse(String(row.evidence)) as StoryEvidence[];
    const hash = sha256(String(row.id) + '\n' + String(row.payload) + '\n' + String(row.evidence));
    if (hash !== row.hash) throw new Error('Story record checksum mismatch');
    return {
      id: String(row.id), bookKey: String(row.bookKey), bookRevision: String(row.bookRevision),
      contentVersion: Number(row.contentVersion) === -1 ? null : Number(row.contentVersion),
      level: String(row.level) as StoryRecord['level'], kind: String(row.kind), status: String(row.status),
      sourceKind: String(row.sourceKind), generation: Number(row.generation), revealedAt: Number(row.revealedAt),
      storyOrder: row.storyOrder === null ? null : Number(row.storyOrder), payload, evidence,
      createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    };
  }

  private recordsByIds(ids: string[]): StoryRecord[] {
    if (!ids.length) return [];
    const rows = this.sql.prepare(`SELECT * FROM story_record WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Record<string, unknown>[];
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return ids.map(id => {
      const row = byId.get(id);
      if (!row) throw new Error('Story record is missing');
      return this.decode(row);
    });
  }

  capture(input: StoryCaptureInput): StoryCaptureResult {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('capture input must be an object');
    const bookKey = text(input.bookKey, 'bookKey', 150);
    const bookRevision = text(input.bookRevision, 'bookRevision', 200);
    const contentVersion = input.contentVersion === null || input.contentVersion === undefined ? null : integer(input.contentVersion, 'contentVersion', 1);
    const frontier = integer(input.frontier, 'frontier');
    const requestId = text(input.requestId, 'requestId', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('requestId must be an idempotency token');
    if (!Array.isArray(input.changes) || input.changes.length > 4) throw new Error('changes must contain at most 4 candidates');
    const changes = input.changes.map(change => normalizeChange(change, frontier));
    for (const change of changes) {
      if (change.kind !== 'relation') continue;
      for (const entityId of [change.fromEntityId, change.toEntityId].filter(Boolean)) {
        const row = this.sql.prepare('SELECT bookKey,contentVersion FROM story_entity WHERE entityId=?').get(String(entityId)) as { bookKey: string; contentVersion: number } | undefined;
        if (!row || row.bookKey !== bookKey || row.contentVersion !== versionKey(contentVersion)) throw new Error('relation entityId is not bound to this book version');
      }
    }
    const inputHash = sha256(JSON.stringify({ contract: 'ssm-capture-v1', changes }));
    const version = versionKey(contentVersion);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.sql.prepare('SELECT inputHash,recordIds,generation FROM story_batch WHERE bookKey=? AND contentVersion=? AND requestId=?')
        .get(bookKey, version, requestId) as { inputHash: string; recordIds: string; generation: number } | undefined;
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error('Capture requestId is already used with different content');
        const records = this.recordsByIds(JSON.parse(existing.recordIds) as string[]);
        this.sql.exec('COMMIT');
        return { duplicate: true, generation: existing.generation, records };
      }
      const max = this.sql.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM story_record WHERE bookKey=? AND contentVersion=?')
        .get(bookKey, version) as { n: number };
      const generation = Number(max.n) + 1;
      const now = this.now();
      const ids: string[] = [];
      const insert = this.sql.prepare(`INSERT INTO story_record
        (id,bookKey,bookRevision,contentVersion,level,kind,status,sourceKind,generation,revealedAt,storyOrder,payload,evidence,hash,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const change of changes) {
        const id = randomUUID();
        const payload = JSON.stringify(change);
        const evidence = JSON.stringify(change.evidence);
        if (Buffer.byteLength(payload) > MAX_ROW || Buffer.byteLength(evidence) > MAX_ROW) throw new Error('Story record oversized');
        insert.run(id, bookKey, bookRevision, version, levelOf(change.kind), change.kind, change.status ?? 'candidate',
          change.sourceKind ?? 'model_interpretation', generation, frontier,
          change.storyOrder === undefined ? null : change.storyOrder,
          payload, evidence, sha256(id + '\n' + payload + '\n' + evidence), now, now);
        ids.push(id);
      }
      this.sql.prepare('INSERT INTO story_batch(bookKey,contentVersion,requestId,inputHash,recordIds,generation,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(bookKey, version, requestId, inputHash, JSON.stringify(ids), generation, now);
      this.bumpChangeSeq();
      this.sql.exec('COMMIT');
      return { duplicate: false, generation, records: this.recordsByIds(ids) };
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  list(bookKey: string, contentVersion?: number | null): StoryRecord[] {
    this.open();
    const key = text(bookKey, 'bookKey', 150);
    if (contentVersion === undefined) {
      return (this.sql.prepare('SELECT * FROM story_record WHERE bookKey=? ORDER BY generation,id').all(key) as Record<string, unknown>[]).map(row => this.decode(row));
    }
    const version = versionKey(contentVersion);
    return (this.sql.prepare('SELECT * FROM story_record WHERE bookKey=? AND contentVersion=? ORDER BY generation,id').all(key, version) as Record<string, unknown>[]).map(row => this.decode(row));
  }

  listBookKeys(): string[] {
    this.open();
    return (this.sql.prepare('SELECT DISTINCT bookKey FROM story_record ORDER BY bookKey').all() as Array<{ bookKey: string }>).map(row => String(row.bookKey));
  }

  get(id: string): StoryRecord {
    this.open();
    const row = this.sql.prepare('SELECT * FROM story_record WHERE id=?').get(text(id, 'id', 80)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Story record missing');
    return this.decode(row);
  }

  private packFromRow(row: Record<string, unknown>): StoryPackRecord {
    return {
      id: String(row.id), generation: Number(row.generation), bookKey: String(row.bookKey), bookRevision: String(row.bookRevision),
      contentVersion: Number(row.contentVersion) === -1 ? null : Number(row.contentVersion),
      frontier: Number(row.frontier ?? 0), level: String(row.level) as StoryPackRecord['level'],      label: row.label === null ? undefined : String(row.label), summary: String(row.summary),
      parentId: row.parentId === null ? null : String(row.parentId), childIds: JSON.parse(String(row.childIds)),
      eventIds: JSON.parse(String(row.eventIds)), relationIds: JSON.parse(String(row.relationIds)),
      coveredRanges: JSON.parse(String(row.coveredRanges)), openQuestions: JSON.parse(String(row.openQuestions)),
      inputFingerprint: String(row.inputFingerprint), outputFingerprint: String(row.outputFingerprint),
      status: String(row.status) as StoryPackRecord['status'], createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    };
  }

  putPack(input: StoryPackInput): { duplicate: boolean; pack: StoryPackRecord } {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('pack input must be an object');
    const bookKey = text(input.bookKey, 'bookKey', 150);
    const bookRevision = text(input.bookRevision, 'bookRevision', 200);
    const contentVersion = input.contentVersion === null || input.contentVersion === undefined ? null : integer(input.contentVersion, 'contentVersion', 1);
    const frontier = integer(input.frontier, 'frontier');
    const level = text(input.level, 'level', 10);
    if (!['book', 'arc', 'scene'].includes(level)) throw new Error('invalid pack level');
    const summary = text(input.summary, 'summary', 2000);
    if ((input as any).status === 'active') throw new Error('putPack cannot create active packs; use publishPack after draft validation');
    const id = input.id === undefined ? randomUUID() : text(input.id, 'pack id', 80);
    const eventIds = [...new Set((input.eventIds ?? []).map(String))];
    const relationIds = [...new Set((input.relationIds ?? []).map(String))];
    if (!eventIds.length) throw new Error('pack needs at least one event');
    const coveredRanges = (input.coveredRanges ?? []).map(range => {
      if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to <= range.from || range.to > frontier) {
        throw new Error('pack range is outside the frontier');
      }
      return { from: range.from, to: range.to };
    });
    if (!coveredRanges.length) throw new Error('pack needs covered ranges');
    const version = versionKey(contentVersion);
    const records = this.sql.prepare(`SELECT * FROM story_record WHERE bookKey=? AND contentVersion=? AND id IN (${[...eventIds, ...relationIds].map(() => '?').join(',') || "''"})`)
      .all(bookKey, version, ...eventIds, ...relationIds) as Record<string, unknown>[];
    const byId = new Map(records.map(row => [String(row.id), row]));
    const events = eventIds.map(eventId => {
      const row = byId.get(eventId);
      if (!row) throw new Error(`pack references unknown event ${eventId}`);
      const payload = JSON.parse(String(row.payload)) as StoryChange;
      if (payload.kind === 'relation') throw new Error(`${eventId} is a relation, not an event`);
      return { ...payload, id: String(row.id), evidence: JSON.parse(String(row.evidence)), status: String(row.status), sourceKind: String(row.sourceKind), revealedAt: Number(row.revealedAt), version: Number(row.generation) };
    });
    const relations = relationIds.map(relationId => {
      const row = byId.get(relationId);
      if (!row) throw new Error(`pack references unknown relation ${relationId}`);
      const payload = JSON.parse(String(row.payload)) as StoryChange;
      if (payload.kind !== 'relation') throw new Error(`${relationId} is not a relation`);
      return { ...payload, id: String(row.id), evidence: JSON.parse(String(row.evidence)), status: String(row.status), sourceKind: String(row.sourceKind), revealedAt: Number(row.revealedAt), version: Number(row.generation) };
    });
    const packForFingerprint = { ...input, id, bookKey, bookRevision, contentVersion, level, summary, eventIds, relationIds, coveredRanges, openQuestions: input.openQuestions ?? [] };
    const parts = fingerprintPackParts(packForFingerprint, events as any, relations as any);
    const existing = this.sql.prepare("SELECT * FROM story_pack WHERE id=? AND bookKey=? AND contentVersion=? AND status='active' ORDER BY generation DESC LIMIT 1")
      .get(id, bookKey, version) as Record<string, unknown> | undefined;
    if (existing && String(existing.inputFingerprint) === parts.inputFingerprint && String(existing.outputFingerprint) === parts.outputFingerprint) {
      return { duplicate: true, pack: this.packFromRow(existing) };
    }
    const max = this.sql.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM story_pack WHERE bookKey=? AND contentVersion=?')
      .get(bookKey, version) as { n: number };
    const generation = Number(max.n) + 1;
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== generation - 1) throw new Error('pack generation conflict');
    const now = this.now();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const childIds = [...new Set((input.childIds ?? []).map(String))];
      const openQuestions = [...(input.openQuestions ?? [])].map(String);
      const initialStatus = 'draft';
      this.sql.prepare(`INSERT INTO story_pack(id,generation,bookKey,bookRevision,contentVersion,frontier,level,label,summary,parentId,childIds,eventIds,relationIds,coveredRanges,openQuestions,inputFingerprint,outputFingerprint,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, generation, bookKey, bookRevision, version, frontier, level, input.label ?? null, summary, input.parentId ?? null,
        JSON.stringify(childIds), JSON.stringify(eventIds), JSON.stringify(relationIds), JSON.stringify(coveredRanges),
        JSON.stringify(openQuestions), parts.inputFingerprint, parts.outputFingerprint, initialStatus, now, now);
      this.bumpChangeSeq();
      this.sql.exec('COMMIT');
      return { duplicate: false, pack: this.packFromRow(this.sql.prepare('SELECT * FROM story_pack WHERE id=? AND bookKey=? AND contentVersion=? AND generation=?').get(id, bookKey, version, generation) as Record<string, unknown>) };
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  publishPack(id: string, contentVersion?: number | null): StoryPackRecord {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const packId = text(id, 'pack id', 80);
    const rows = (contentVersion === undefined
      ? this.sql.prepare("SELECT * FROM story_pack WHERE id=? AND status IN ('draft','active','legacy-unverified') ORDER BY generation DESC").all(packId)
      : this.sql.prepare("SELECT * FROM story_pack WHERE id=? AND contentVersion=? AND status IN ('draft','active','legacy-unverified') ORDER BY generation DESC").all(packId, versionKey(contentVersion))) as Record<string, unknown>[];
    const draft = rows.find(row => String(row.status) === 'draft') ?? rows.find(row => String(row.status) === 'legacy-unverified');
    if (!draft) {
      const active = rows.find(row => String(row.status) === 'active');
      if (active) return this.packFromRow(active);
      throw new Error('Story pack draft missing');
    }
    const candidate = this.packFromRow(draft);
    const allRows = this.sql.prepare('SELECT * FROM story_pack WHERE bookKey=? AND contentVersion=? AND status IN (\'draft\',\'active\',\'legacy-unverified\') ORDER BY generation,id')
      .all(candidate.bookKey, versionKey(candidate.contentVersion)) as Record<string, unknown>[];
    const latest = new Map<string, StoryPackRecord>();
    for (const row of allRows) {
      const pack = this.packFromRow(row);
      const prior = latest.get(pack.id);
      if (!prior || pack.generation > prior.generation) latest.set(pack.id, pack);
    }
    const packs = [...latest.values()];
    const tree = validatePackTreeCore(packs.map(pack => ({ id: pack.id, level: pack.level, parentId: pack.parentId ?? null, childIds: pack.childIds, coveredRanges: pack.coveredRanges })), { frontier: Math.max(...packs.map(pack => pack.frontier)) });
    if (!tree.ok) throw new Error(`Pack tree is not publishable: ${tree.errors.join('; ')}`);
    for (const pack of packs) {
      if (pack.bookRevision !== candidate.bookRevision) throw new Error('Pack book revision mismatch');
      const records = this.sql.prepare(`SELECT * FROM story_record WHERE bookKey=? AND contentVersion=? AND id IN (${[...pack.eventIds, ...(pack.relationIds ?? [])].map(() => '?').join(',')})`)
        .all(pack.bookKey, versionKey(pack.contentVersion), ...pack.eventIds, ...(pack.relationIds ?? [])) as Record<string, unknown>[];
      if (records.length !== pack.eventIds.length + (pack.relationIds?.length ?? 0)) throw new Error('Pack references a missing fact');
      for (const row of records) {
        if (Number(row.revealedAt) > pack.frontier) throw new Error('Pack references a fact revealed after its frontier');
        const evidence = JSON.parse(String(row.evidence)) as StoryEvidence[];
        if (evidence.some(ref => ref.segmentId >= pack.frontier)) throw new Error('Pack references evidence after its frontier');
      }
    }
    const now = this.now();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      for (const pack of packs) {
        this.sql.prepare("UPDATE story_pack SET status='superseded',updatedAt=? WHERE id=? AND bookKey=? AND contentVersion=? AND status='active'").run(now, pack.id, pack.bookKey, versionKey(pack.contentVersion));
        this.sql.prepare("UPDATE story_pack SET status='active',updatedAt=? WHERE id=? AND generation=?").run(now, pack.id, pack.generation);
      }
      this.bumpChangeSeq();
      this.sql.exec('COMMIT');
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    return this.packFromRow(this.sql.prepare('SELECT * FROM story_pack WHERE id=? AND generation=?').get(candidate.id, candidate.generation) as Record<string, unknown>);
  }

  listPacks(bookKey: string, contentVersion?: number | null): StoryPackRecord[] {    this.open();
    const key = text(bookKey, 'bookKey', 150);
    const rows = contentVersion === undefined
      ? this.sql.prepare("SELECT * FROM story_pack WHERE bookKey=? AND status='active' ORDER BY generation,id").all(key)
      : this.sql.prepare("SELECT * FROM story_pack WHERE bookKey=? AND contentVersion=? AND status='active' ORDER BY generation,id").all(key, versionKey(contentVersion));
    return (rows as Record<string, unknown>[]).map(row => this.packFromRow(row));
  }

  getPack(id: string, contentVersion?: number | null): StoryPackRecord {
    this.open();
    const row = contentVersion === undefined
      ? this.sql.prepare("SELECT * FROM story_pack WHERE id=? AND status='active' ORDER BY generation DESC LIMIT 1").get(text(id, 'pack id', 80)) as Record<string, unknown> | undefined
      : this.sql.prepare("SELECT * FROM story_pack WHERE id=? AND contentVersion=? AND status='active' ORDER BY generation DESC LIMIT 1").get(text(id, 'pack id', 80), versionKey(contentVersion)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Story pack missing');
    return this.packFromRow(row);
  }

  createEntity(input: { bookKey: string; contentVersion?: number | null; canonicalName: string; aliases?: string[]; aliasReveals?: Record<string, number>; aliasEvidence?: Record<string, StoryEvidence[]>; firstRevealedAt: number; evidence?: StoryEvidence[]; status?: 'candidate' | 'bound' }): StoryEntityRecord {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const bookKey = text(input.bookKey, 'bookKey', 150);
    const version = input.contentVersion === null || input.contentVersion === undefined ? -1 : integer(input.contentVersion, 'contentVersion', 1);
    const canonicalName = text(input.canonicalName, 'canonicalName', 60);
    const aliases = [...new Set((input.aliases ?? []).map(alias => text(alias, 'alias', 60)))].filter(alias => normalizeName(alias) !== normalizeName(canonicalName));
    const firstRevealedAt = integer(input.firstRevealedAt, 'firstRevealedAt');
    const entityId = randomUUID();
    const now = this.now();
    this.sql.prepare('INSERT INTO story_entity(entityId,bookKey,contentVersion,canonicalName,aliases,status,firstRevealedAt,evidence,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(entityId, bookKey, version, canonicalName, JSON.stringify(aliases), input.status ?? 'candidate', firstRevealedAt, JSON.stringify(input.evidence ?? []), now, now);
    const aliasValue = (alias: string) => {
      const row = this.sql.prepare('SELECT 1 FROM story_entity_alias WHERE entityId=? AND alias=?').get(entityId, alias);
      if (row) return;
      this.sql.prepare('INSERT INTO story_entity_alias(entityId,alias,revealedAt,evidence,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .run(entityId, alias, input.aliasReveals?.[alias] ?? firstRevealedAt, JSON.stringify(input.aliasEvidence?.[alias] ?? input.evidence ?? []), now, now);
    };
    aliasValue(canonicalName);
    for (const alias of aliases) aliasValue(alias);
    this.bumpChangeSeq();
    return this.getEntity(entityId);
  }

  private entityFromRow(row: Record<string, unknown>): StoryEntityRecord {
    return { entityId: String(row.entityId), bookKey: String(row.bookKey), contentVersion: Number(row.contentVersion) === -1 ? null : Number(row.contentVersion), canonicalName: String(row.canonicalName), aliases: JSON.parse(String(row.aliases)), status: String(row.status) as StoryEntityRecord['status'], firstRevealedAt: Number(row.firstRevealedAt), evidence: JSON.parse(String(row.evidence)), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  getEntity(entityId: string): StoryEntityRecord {
    this.open();
    const row = this.sql.prepare('SELECT * FROM story_entity WHERE entityId=?').get(text(entityId, 'entityId', 80)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Story entity missing');
    return this.entityFromRow(row);
  }

  listEntities(bookKey: string, contentVersion?: number | null): StoryEntityRecord[] {
    this.open();
    const key = text(bookKey, 'bookKey', 150);
    const rows = contentVersion === undefined
      ? this.sql.prepare('SELECT entityId FROM story_entity WHERE bookKey=? ORDER BY canonicalName,entityId').all(key)
      : this.sql.prepare('SELECT entityId FROM story_entity WHERE bookKey=? AND contentVersion=? ORDER BY canonicalName,entityId').all(key, versionKey(contentVersion));
    return (rows as Array<{ entityId: string }>).map(row => this.getEntity(row.entityId));
  }

  bindEntity(entityId: string, aliases: string[] = [], revealedAt?: number): StoryEntityRecord {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const entity = this.getEntity(entityId);
    const merged = [...new Set([...entity.aliases, ...aliases.map(alias => text(alias, 'alias', 60))])];
    const now = this.now();
    this.sql.prepare("UPDATE story_entity SET status='bound',aliases=?,updatedAt=? WHERE entityId=?").run(JSON.stringify(merged), now, entity.entityId);
    for (const alias of merged) {
      this.sql.prepare('INSERT INTO story_entity_alias(entityId,alias,revealedAt,evidence,createdAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(entityId,alias) DO NOTHING')
        .run(entity.entityId, alias, integer(revealedAt ?? entity.firstRevealedAt, 'revealedAt'), '[]', now, now);
    }
    this.bumpChangeSeq();
    return this.getEntity(entity.entityId);
  }

  resolveEntity(bookKey: string, name: string, atFrontier: number, contentVersion?: number | null): { status: 'resolved' | 'ambiguous' | 'none'; candidates: StoryEntityRecord[] } {
    this.open();
    const wanted = normalizeName(name);
    const version = contentVersion === undefined ? undefined : versionKey(contentVersion);
    const rows = (version === undefined
      ? this.sql.prepare('SELECT a.alias,a.revealedAt,a.evidence,e.* FROM story_entity_alias a JOIN story_entity e ON e.entityId=a.entityId WHERE e.bookKey=? ORDER BY e.entityId').all(bookKey)
      : this.sql.prepare('SELECT a.alias,a.revealedAt,a.evidence,e.* FROM story_entity_alias a JOIN story_entity e ON e.entityId=a.entityId WHERE e.bookKey=? AND e.contentVersion=? ORDER BY e.entityId').all(bookKey, version)) as Record<string, unknown>[];
    const byEntity = new Map<string, { entity: StoryEntityRecord; visible: string[] }>();
    for (const row of rows) {
      if (Number(row.revealedAt) > atFrontier || normalizeName(String(row.alias)) !== wanted) continue;
      const entity = this.entityFromRow(row);
      const entry = byEntity.get(entity.entityId) ?? { entity, visible: [] };
      entry.visible.push(String(row.alias));
      byEntity.set(entity.entityId, entry);
    }
    if (!byEntity.size) {
      const hasAliasRows = this.sql.prepare('SELECT COUNT(*) AS n FROM story_entity_alias a JOIN story_entity e ON e.entityId=a.entityId WHERE e.bookKey=?').get(bookKey) as { n: number };
      if (Number(hasAliasRows.n) > 0) return { status: 'none', candidates: [] };
      const legacy = this.listEntities(bookKey, contentVersion).filter(entity => entity.firstRevealedAt <= atFrontier && [entity.canonicalName, ...entity.aliases].some(value => normalizeName(value) === wanted));
      return { status: legacy.length === 0 ? 'none' : legacy.length === 1 ? 'resolved' : 'ambiguous', candidates: legacy };
    }
    const candidates = [...byEntity.values()].map(({ entity, visible }) => {
      const canonicalVisible = entity.firstRevealedAt <= atFrontier;
      return { ...entity, canonicalName: canonicalVisible ? entity.canonicalName : visible[0], aliases: [...new Set(visible)] };
    });
    return { status: candidates.length === 1 ? 'resolved' : 'ambiguous', candidates };
  }

  validatePackTree(bookKey: string, contentVersion?: number | null) {
    const packs = this.listPacks(bookKey, contentVersion);
    if (!packs.length) return { ok: false, errors: ['no-story-pack'] };
    return validatePackTreeCore(packs.map(pack => ({ id: pack.id, level: pack.level, parentId: pack.parentId ?? null, childIds: pack.childIds, coveredRanges: pack.coveredRanges })), { frontier: Math.max(...packs.map(pack => pack.frontier)) });
  }

  invalidatePacks(bookKey: string, contentVersion?: number | null) {    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const key = text(bookKey, 'bookKey', 150);
    const now = this.now();
    const result = contentVersion === undefined
      ? this.sql.prepare("UPDATE story_pack SET status='stale',updatedAt=? WHERE bookKey=? AND status='active'").run(now, key)
      : this.sql.prepare("UPDATE story_pack SET status='stale',updatedAt=? WHERE bookKey=? AND contentVersion=? AND status='active'").run(now, key, versionKey(contentVersion));
    this.bumpChangeSeq();
    return { invalidated: Number((result as { changes: number }).changes) };
  }

  deleteBook(bookKey: string) {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const key = text(bookKey, 'bookKey', 150);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const records = Number((this.sql.prepare('DELETE FROM story_record WHERE bookKey=?').run(key) as { changes: number }).changes);
      const batches = Number((this.sql.prepare('DELETE FROM story_batch WHERE bookKey=?').run(key) as { changes: number }).changes);
      this.sql.prepare('DELETE FROM story_pack WHERE bookKey=?').run(key);
      this.sql.prepare('DELETE FROM story_cleanup WHERE bookKey=?').run(key);
      this.bumpChangeSeq();
      this.sql.exec('COMMIT');
      return { records, batches };
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  pendingCleanups(): Array<{ bookKey: string; reason: string; attempts: number; lastError: string | null; createdAt: number; updatedAt: number }> {
    this.open();
    return (this.sql.prepare('SELECT bookKey,reason,attempts,lastError,createdAt,updatedAt FROM story_cleanup ORDER BY createdAt,bookKey').all() as Array<Record<string, unknown>>).map(row => ({
      bookKey: String(row.bookKey), reason: String(row.reason), attempts: Number(row.attempts),
      lastError: row.lastError === null ? null : String(row.lastError), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    }));
  }

  recordCleanup(bookKey: string, reason: string) {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    const key = text(bookKey, 'bookKey', 150);
    const now = this.now();
    this.sql.prepare(`INSERT INTO story_cleanup(bookKey,reason,attempts,lastError,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?) ON CONFLICT(bookKey) DO UPDATE SET reason=excluded.reason,
      attempts=story_cleanup.attempts+1,lastError=excluded.lastError,updatedAt=excluded.updatedAt`)
      .run(key, text(reason, 'reason', 500), 1, reason, now, now);
    this.bumpChangeSeq();
    return this.pendingCleanups().find(item => item.bookKey === key)!;
  }

  retryCleanups() {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    let cleaned = 0, failed = 0;
    for (const item of this.pendingCleanups()) {
      try {
        this.deleteBook(item.bookKey);
        cleaned++;
      } catch (error) {
        failed++;
        this.sql.prepare('UPDATE story_cleanup SET attempts=attempts+1,lastError=?,updatedAt=? WHERE bookKey=?')
          .run(String(error).slice(0, 500), this.now(), item.bookKey);
      }
    }
    return { cleaned, failed, pending: this.pendingCleanups() };
  }

  clear() {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.exec('DELETE FROM story_record; DELETE FROM story_batch; DELETE FROM story_cleanup; DELETE FROM story_pack;');
      this.bumpChangeSeq();
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(file: string) {
    this.open();
    this.sql.exec('VACUUM INTO ' + "'" + file.replaceAll("'", "''") + "'");
    if (statSync(file).size > MAX_DB) throw new Error('Story memory snapshot oversized');
    return { size: statSync(file).size };
  }

  /** Read-only preflight: schema, quick_check and row hashes. */
  static validateSnapshot(file: string) {
    const source = new StoryStore(file, { readOnly: true });
    try {
      source.open();
      source.status();
    } finally {
      source.close();
    }
  }

  /** Replace this store's contents from a validated snapshot. */
  restoreFrom(file: string) {
    this.open();
    if (this.options.readOnly) throw new Error('Story memory store is read-only');
    this.sql.prepare('ATTACH DATABASE ? AS story_src').run(file);
    try {
      const meta = this.sql.prepare("SELECT value FROM story_src.story_meta WHERE key='schemaVersion'").get() as { value?: string } | undefined;
      if (meta?.value !== '1') throw new Error('Unsupported story snapshot schema');
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        this.sql.exec('DELETE FROM story_record; DELETE FROM story_batch; DELETE FROM story_cleanup; DELETE FROM story_pack;');
        this.sql.exec('INSERT INTO story_record SELECT * FROM story_src.story_record; INSERT INTO story_batch SELECT * FROM story_src.story_batch;');
        if (this.hasTable('story_cleanup', 'story_src')) this.sql.exec('INSERT INTO story_cleanup SELECT * FROM story_src.story_cleanup;');
        if (this.hasTable('story_pack', 'story_src')) this.sql.exec('INSERT INTO story_pack SELECT * FROM story_src.story_pack;');
        this.bumpChangeSeq();
        this.sql.exec('COMMIT');
      } catch (error) {
        this.sql.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.sql.exec('DETACH DATABASE story_src');
    }
  }
}
