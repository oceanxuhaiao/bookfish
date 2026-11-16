import { createHash } from 'node:crypto';

/** Public structural contracts for the pure story-memory layer. */
export interface StoryBookView {
  bookKey?: string;
  revision?: string;
  frontier?: number;
  totalSegments?: number;
  segments: Array<{ id: number; text: string; start: number; end: number; chapter?: string }>;
}
export interface StoryEvidenceRef {
  segmentId: number;
  quote?: string;
  start?: number;
  end?: number;
  revision?: string;
}
export interface StoryPackView {
  id: string;
  bookKey?: string;
  bookRevision?: string;
  contentVersion?: number | null;
  level: 'book' | 'arc' | 'scene';
  parentId?: string | null;
  childIds?: string[];
  summary: string;
  label?: string;
  eventIds: string[];
  relationIds?: string[];
  coveredRanges: Array<{ from: number; to: number }>;
  openQuestions?: string[];
}
export interface StorySnapshot {
  bookKey: string;
  bookRevision: string;
  contentVersion: number | null;
  frontier: number;
  sourceHash: string;
  catalogHash: string | null;
  episodeWatermark: number;
  storyGeneration: number;
}
export interface RecallResult {
  items: Array<{ id: string; summary: string; revealedAt: number; storyOrder: number | null; status?: string; evidence?: StoryEvidenceRef[] }>;
  relations: Array<Record<string, unknown>>;
  omitted: string[];
  omittedCount: number;
  budgetExhausted: boolean;
  nextCursor: string | null;
  chronology: 'read' | 'story';
  semanticMatchVerified: false;
}

/**
 * SSM P0-1 pure-function prototype.
 *
 * Scope:
 * - No World wiring, no SQLite, no model calls.
 * - Evidence is validated against one already-loaded book view.
 * - All ordering/coverage/recall results are deterministic.
 *
 * This file is a proposal prototype, not production code.
 */

const CHANGE_KINDS = new Set(['entity', 'event', 'relation', 'rule', 'reveal']);
const SOURCE_KINDS = new Set(['original_explicit', 'model_interpretation']);
const LEVEL_ORDER = { book: 0, arc: 1, scene: 2 };

export function sha256(text: any) {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeName(value: any) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('name must be a non-empty string');
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function cpLength(value: any) {
  return Array.from(value).length;
}

function integer(value: any, name: any) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function assertBook(book: any) {
  if (!book || typeof book !== 'object' || !Array.isArray(book.segments)) throw new Error('book.segments is required');
  if (book.totalSegments !== undefined) {
    if (!Number.isSafeInteger(book.totalSegments) || book.totalSegments < 0) throw new Error('book.totalSegments must be a non-negative integer');
    if (book.totalSegments !== book.segments.length) throw new Error('book view is partial; segments.length does not match totalSegments');
  }
  let expectedStart = 0;
  for (let index = 0; index < book.segments.length; index++) {
    const segment = book.segments[index];
    if (!segment || !Number.isSafeInteger(segment.id) || typeof segment.text !== 'string' ||
      !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) ||
      segment.end - segment.start !== cpLength(segment.text)) {
      throw new Error('book contains an invalid segment');
    }
    // BookFish segment ids are the contiguous 0..n-1 index, and offsets are a
    // continuous codepoint partition. A partial/paged view must not masquerade
    // as the whole book.
    if (segment.id !== index) throw new Error(`segment id ${segment.id} is not the expected index ${index}`);
    if (segment.start !== expectedStart) throw new Error(`segment ${index} has a gap or overlap in source offsets`);
    if (segment.end <= segment.start) throw new Error(`segment ${index} is empty`);
    expectedStart = segment.end;
  }
}

function segmentById(book: any, id: any) {
  const segment = book.segments.find((item: any) => item.id === id);
  if (!segment) throw new Error(`segment ${id} is missing`);
  return segment;
}

function locator(segment: any, quote: any) {
  const first = segment.text.indexOf(quote);
  if (first < 0) throw new Error('Evidence quote does not match the supplied source text');
  if (segment.text.indexOf(quote, first + 1) >= 0) {
    throw new Error('Evidence quote is ambiguous; provide its absolute Unicode-codepoint start');
  }
  return segment.start + cpLength(segment.text.slice(0, first));
}

/**
 * Validate one or more exact source references.
 *
 * @param {{segments:Array<{id:number,text:string,start:number,end:number}>,revision?:string,frontier?:number}} book
 * @param {Array<{segmentId:number,quote:string,start?:number,end?:number,revision?:string}>} refs
 * @param {{frontier?:number,maxRefs?:number,maxQuote?:number}} [options]
 */
export function validateEvidence(book: any, refs: any, options: any = {}) {
  assertBook(book);
  const frontier = options.frontier ?? book.frontier;
  if (!Number.isSafeInteger(frontier) || frontier < 0 || frontier > book.segments.length) {
    throw new Error('frontier must be an integer inside the book range');
  }
  const maxRefs = options.maxRefs ?? 5;
  const maxQuote = options.maxQuote ?? 300;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > maxRefs) {
    throw new Error(`evidence must contain 1–${maxRefs} references`);
  }
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object') throw new Error('evidence reference must be an object');
    const segmentId = integer(ref.segmentId, 'segmentId');
    if (ref.revision !== undefined && book.revision !== undefined && ref.revision !== book.revision) {
      throw new Error('evidence belongs to a different book revision');
    }
    if (segmentId < 0 || segmentId >= frontier) throw new Error('Evidence must belong to a confirmed range of this exact revision');
    const segment = segmentById(book, segmentId);
    if (typeof ref.quote !== 'string' || !ref.quote) throw new Error('Evidence quote must be a non-empty exact source string');
    if (cpLength(ref.quote) > maxQuote) throw new Error(`Evidence quote exceeds ${maxQuote} characters`);
    let start;
    if (ref.start !== undefined) {
      start = integer(ref.start, 'start');
    } else {
      start = locator(segment, ref.quote);
    }
    const end = start + cpLength(ref.quote);
    if (ref.end !== undefined && ref.end !== end) throw new Error('Evidence end does not match its quote');
    if (start < segment.start || end > segment.end) throw new Error('Evidence offsets fall outside the cited segment');
    const actual = Array.from(segment.text).slice(start - segment.start, end - segment.start).join('');
    if (actual !== ref.quote) throw new Error('Evidence offsets and exact quote do not match this segment');
    return { segmentId, start, end, quote: ref.quote };
  });
}

/**
 * Deterministic event ordering. `read` follows what the reader learned;
 * `story` follows in-world order and marks missing order as unknown.
 */
export function orderEvents(events: any, mode: any = 'read') {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (mode !== 'read' && mode !== 'story') throw new Error('mode must be read or story');
  const unknownOrderIds = [];
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.revealedAt) || typeof event.id !== 'string') {
      throw new Error('each event needs a string id and integer revealedAt');
    }
  }
  const ordered = [...events].sort((a, b) => {
    if (mode === 'read') return a.revealedAt - b.revealedAt || String(a.id).localeCompare(String(b.id));
    const aOrder = Number.isFinite(a.storyOrder) ? a.storyOrder : Infinity;
    const bOrder = Number.isFinite(b.storyOrder) ? b.storyOrder : Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.revealedAt - b.revealedAt || String(a.id).localeCompare(String(b.id));
  });
  if (mode === 'story') {
    for (const event of ordered) if (!Number.isFinite(event.storyOrder)) unknownOrderIds.push(String(event.id));
  }
  return { events: ordered, unknownOrderIds };
}

/**
 * Relations active at a story event, optionally filtered by what the reader
 * knew at a later frontier. Story position and reader knowledge are separate:
 * `atStoryEventId` answers "where in the story", `knownAtFrontier` answers
 * "what had the reader learned at that point".
 */
export function relationAt(relations: any, fromEntityId: any, toEntityId: any, atStoryEventId: any, events: any, options: any = {}) {
  if (!Array.isArray(relations)) throw new Error('relations must be an array');
  if (!Array.isArray(events)) throw new Error('events must be an array');
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !Number.isSafeInteger(event.revealedAt) || !Number.isFinite(event.storyOrder)) {
      throw new Error('relation ordering is unknown; every event needs a finite storyOrder');
    }
  }
  const ordered = orderEvents(events, 'story').events;
  const positions = new Map(ordered.map((event, index) => [String(event.id), index]));
  const atIndex = positions.get(String(atStoryEventId));
  if (atIndex === undefined) throw new Error('atStoryEventId is not in the supplied story events');
  const at = ordered[atIndex];
  const knownAtFrontier = options.knownAtFrontier ?? at.revealedAt;
  if (!Number.isSafeInteger(knownAtFrontier) || knownAtFrontier < 0) throw new Error('knownAtFrontier must be a non-negative integer');
  const result = [];
  for (const relation of relations) {
    if (!relation || typeof relation.id !== 'string') throw new Error('relation must have a string id');
    if (!Number.isSafeInteger(relation.revealedAt)) throw new Error('relation.revealedAt must be a safe integer');
    const from = relation.validFromEventId === undefined ? 0 : positions.get(String(relation.validFromEventId));
    const to = relation.validToEventId === undefined ? Infinity : positions.get(String(relation.validToEventId));
    if (from === undefined || to === undefined) throw new Error('relation references an unknown story event');
    if (to !== Infinity && to <= from) throw new Error('relation validTo must be after validFrom');
    if (relation.fromEntityId !== fromEntityId || relation.toEntityId !== toEntityId) continue;
    if (from <= atIndex && atIndex < to && relation.revealedAt <= knownAtFrontier) result.push(relation);
  }
  return result.sort((a, b) => {
    const ai = positions.get(String(a.validFromEventId)) ?? -1;
    const bi = positions.get(String(b.validFromEventId)) ?? -1;
    return ai - bi || String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Resolve a canonical name or alias without merging ambiguous entities.
 * Alias scope, when supplied, must match exactly or be absent.
 */
export function resolveEntity(name: any, entities: any, options: any = {}) {
  const wanted = normalizeName(name);
  const scope = options.scope === undefined ? undefined : String(options.scope);
  if (!Array.isArray(entities)) throw new Error('entities must be an array');
  const candidates: any[] = [];
  for (const entity of entities) {
    if (!entity || typeof entity.canonicalName !== 'string') throw new Error('invalid entity');
    let match = normalizeName(entity.canonicalName) === wanted;
    if (!match && Array.isArray(entity.aliases)) {
      match = entity.aliases.some((alias: any) => {
        const value = typeof alias === 'string' ? alias : alias?.value;
        const aliasScope = typeof alias === 'string' ? undefined : alias?.scope;
        if (typeof value !== 'string' || normalizeName(value) !== wanted) return false;
        return scope === undefined || aliasScope === undefined || String(aliasScope) === scope;
      });
    }
    if (match && !candidates.some(item => item.id === entity.id)) candidates.push(entity);
  }
  if (candidates.length === 1) return { status: 'resolved', entity: candidates[0], candidates };
  if (candidates.length === 0) return { status: 'none', candidates: [] };
  return { status: 'ambiguous', candidates };
}

function normalizeRanges(ranges: any, frontier: any) {
  if (!Array.isArray(ranges)) throw new Error('coveredRanges must be an array');
  const clean = ranges.map(range => {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to <= range.from || range.to > frontier) {
      throw new Error('covered range is outside the confirmed frontier');
    }
    return { from: range.from, to: range.to };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: any[] = [];
  for (const range of clean) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function complementRanges(covered: any, frontier: any) {
  const result = [];
  let at = 0;
  for (const range of covered) {
    if (range.from > at) result.push({ from: at, to: range.from });
    at = Math.max(at, range.to);
  }
  if (at < frontier) result.push({ from: at, to: frontier });
  return result;
}

/**
 * Build an explicit coverage report. The model must never supply this value.
 * A structurally valid pack tree is not the same as a usable whole-book
 * skeleton; `isReviewReady` is a separate conservative decision.
 */
export function buildCoverage({ packs = [], events = [], frontier }: any) {
  if (!Number.isSafeInteger(frontier) || frontier < 0) throw new Error('frontier must be a non-negative integer');
  if (!Array.isArray(packs)) throw new Error('packs must be an array');
  if (!Array.isArray(events)) throw new Error('events must be an array');
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !Number.isSafeInteger(event.revealedAt) || event.revealedAt < 0) {
      throw new Error('invalid story event: string id and non-negative revealedAt are required');
    }
    if (event.evidence !== undefined && !Array.isArray(event.evidence)) throw new Error(`event ${event.id} has invalid evidence`);
  }
  const coveredRanges = normalizeRanges(packs.flatMap(pack => pack?.coveredRanges ?? []), frontier);
  const uncoveredRanges = complementRanges(coveredRanges, frontier);
  const coveredSegments = coveredRanges.reduce((sum, range) => sum + range.to - range.from, 0);
  const visibleEvents = events.filter(event => event.revealedAt <= frontier);
  const evidenceLinkedCount = visibleEvents.filter(event => event.status === 'evidence_linked' && Array.isArray(event.evidence) && event.evidence.length > 0).length;
  const disputedCount = visibleEvents.filter(event => event.status === 'disputed').length;
  const missingEvidence = visibleEvents.filter(event => !Array.isArray(event.evidence) || event.evidence.length === 0).length;
  const gaps = [];
  if (frontier === 0) gaps.push('frontier-empty');
  if (!packs.length) gaps.push('no-story-pack');
  if (!packs.some(pack => pack?.level === 'book')) gaps.push('no-book-pack');
  for (const range of uncoveredRanges) gaps.push(`uncovered:${range.from}-${range.to}`);
  if (missingEvidence) gaps.push(`events-without-evidence:${missingEvidence}`);
  const packIds = packs.map(pack => String(pack.id)).sort();
  const eventDigest = visibleEvents.map(event => ({
    id: String(event.id),
    summary: String(event.summary ?? ''),
    action: String(event.action ?? ''),
    outcome: String(event.outcome ?? ''),
    status: String(event.status ?? ''),
    sourceKind: String(event.sourceKind ?? ''),
    evidence: (event.evidence ?? []).map((e: any) => [e.segmentId, e.start, e.end, e.quote]).sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const coverageDigest = sha256(JSON.stringify({
    frontier, coveredRanges, uncoveredRanges, packIds, eventDigest,
  }));
  const report = {
    frontier,
    coveredRanges,
    uncoveredRanges,
    coveredSegments,
    coverageRatio: frontier === 0 ? 0 : coveredSegments / frontier,
    rangeCoverageRatio: frontier === 0 ? 0 : coveredSegments / frontier,
    eventEvidenceRatio: visibleEvents.length ? evidenceLinkedCount / visibleEvents.length : 0,
    packCount: packs.length,
    eventCount: visibleEvents.length,
    evidenceLinkedCount,
    disputedCount,
    missingEvidence,
    gaps,
    coverageDigest,
  };
  const readiness = isStoryReviewReady({ packs, coverage: report });
  (report as any).isReviewReady = readiness.ready;
  (report as any).reviewReadyReasons = readiness.reasons;
  return report;
}

/**
 * A separate, conservative readiness decision. It is deliberately not the
 * same thing as "the pack tree has no structural error".
 */
export function isStoryReviewReady({ packs = [], coverage }: any = {}) {
  if (!Array.isArray(packs)) throw new Error('packs must be an array');
  if (!coverage || !Number.isSafeInteger(coverage.frontier)) throw new Error('coverage report is required');
  const reasons = [];
  if (coverage.frontier <= 0) reasons.push('frontier-empty');
  if (!packs.some(pack => pack?.level === 'book')) reasons.push('no-book-pack');
  if (!packs.some(pack => pack?.level === 'arc')) reasons.push('no-arc-pack');
  const tree = validatePackTree(packs, { frontier: coverage.frontier });
  if (!tree.ok) reasons.push('invalid-pack-tree');
  if (!coverage.coveredRanges?.length) reasons.push('no-covered-range');
  if (coverage.uncoveredRanges?.length) reasons.push('uncovered-ranges');
  if ((coverage.missingEvidence ?? 0) > 0) reasons.push('events-without-evidence');
  if ((coverage.evidenceLinkedCount ?? 0) === 0) reasons.push('no-evidence-linked-event');
  return { ready: reasons.length === 0, reasons };
}

/**
 * Validate a parent/child pack tree and its ranges.
 */
export function validatePackTree(packs: any, { frontier }: any = {}) {
  if (!Array.isArray(packs)) throw new Error('packs must be an array');
  if (!Number.isSafeInteger(frontier) || frontier < 0) throw new Error('frontier must be a non-negative integer');
  if (!packs.length) return { ok: false, errors: ['no-story-pack'] };
  const byId = new Map();
  const errors = [];
  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || !pack.id) { errors.push('pack id is required'); continue; }
    if (byId.has(pack.id)) { errors.push(`duplicate pack:${pack.id}`); continue; }
    if (!(pack.level in LEVEL_ORDER)) errors.push(`invalid level:${pack.id}`);
    if (!Array.isArray(pack.childIds) || pack.childIds.some((id: any) => typeof id !== 'string')) errors.push(`invalid childIds:${pack.id}`);
    try { normalizeRanges(pack.coveredRanges ?? [], frontier); } catch (error) { errors.push(`${pack.id}:${(error as Error).message}`); }
    byId.set(pack.id, pack);
  }
  const roots = packs.filter(pack => pack.parentId === undefined || pack.parentId === null);
  if (roots.length > 1) errors.push('multiple story roots');
  if (roots.some(pack => pack.level !== 'book')) errors.push('root pack must be level=book');
  for (const pack of packs) {
    if (!pack?.id) continue;
    if (pack.parentId !== undefined && pack.parentId !== null) {
      const parent = byId.get(pack.parentId);
      if (!parent) errors.push(`missing parent:${pack.id}`);
      else {
        if (!Array.isArray(parent.childIds)) errors.push(`parent has invalid childIds:${pack.id}`);
        else if (!parent.childIds.includes(pack.id)) errors.push(`parent does not list child:${pack.id}`);
        if ((LEVEL_ORDER as any)[pack.level] !== (LEVEL_ORDER as any)[parent.level] + 1) errors.push(`invalid level transition:${pack.id}`);
        const parentRanges = parent.coveredRanges ?? [];
        for (const range of pack.coveredRanges ?? []) {
          if (!parentRanges.some((parentRange: any) => parentRange.from <= range.from && range.to <= parentRange.to)) {
            errors.push(`child range outside parent:${pack.id}`);
          }
        }
      }
    }
    for (const childId of pack.childIds ?? []) {
      const child = byId.get(childId);
      if (!child) errors.push(`missing child:${childId}`);
      else if (child.parentId !== pack.id) errors.push(`child parent mismatch:${childId}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id: any) => {
    if (visiting.has(id)) { errors.push(`cycle:${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const childId of byId.get(id)?.childIds ?? []) if (byId.has(childId)) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function eventInput(event: any) {
  return {
    id: String(event.id),
    summary: event.summary ?? null,
    action: event.action ?? null,
    outcome: event.outcome ?? null,
    status: event.status ?? null,
    sourceKind: event.sourceKind ?? null,
    participantIds: [...new Set((event.participantIds ?? []).map(String))].sort(),
    locationIds: [...new Set((event.locationIds ?? []).map(String))].sort(),
    goals: [...(event.goals ?? [])].map(String).sort(),
    changedStates: [...(event.changedStates ?? [])].map(String).sort(),
    causes: [...(event.causes ?? [])].map(String).sort(),
    storyTime: event.storyTime ?? null,
    storyOrder: Number.isFinite(event.storyOrder) ? event.storyOrder : null,
    revealedAt: event.revealedAt ?? null,
    importance: event.importance ?? null,
    uncertainty: event.uncertainty ?? null,
    supersedes: event.supersedes ?? null,
    version: event.version ?? null,
    contentVersion: event.contentVersion ?? null,
    evidence: [...(event.evidence ?? [])].map(ref => ({
      segmentId: ref.segmentId,
      start: ref.start ?? null,
      end: ref.end ?? null,
      quoteHash: sha256(ref.quote ?? ''),
      revision: ref.revision ?? null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

function relationInput(relation: any) {
  return {
    id: String(relation.id),
    fromEntityId: relation.fromEntityId ?? null,
    toEntityId: relation.toEntityId ?? null,
    relation: relation.relation ?? null,
    validFromEventId: relation.validFromEventId ?? null,
    validToEventId: relation.validToEventId ?? null,
    revealedAt: relation.revealedAt ?? null,
    status: relation.status ?? null,
    sourceKind: relation.sourceKind ?? null,
    version: relation.version ?? null,
    contentVersion: relation.contentVersion ?? null,
    evidence: [...(relation.evidence ?? [])].map(ref => ({
      segmentId: ref.segmentId,
      start: ref.start ?? null,
      end: ref.end ?? null,
      quoteHash: sha256(ref.quote ?? ''),
      revision: ref.revision ?? null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

/**
 * Split fingerprints: `inputFingerprint` covers upstream events/relations,
 * evidence, versions and contract; `outputFingerprint` covers the pack text.
 */
export function fingerprintPackParts(pack: any, events: any = [], relations: any = []) {
  if (!pack || typeof pack !== 'object') throw new Error('pack is required');
  if (!Array.isArray(events) || !Array.isArray(relations)) throw new Error('events and relations must be arrays');
  const eventIds = [...new Set((pack.eventIds ?? []).map(String))].sort();
  const eventById = new Map(events.map(event => [String(event.id), event]));
  if (eventById.size !== events.length) throw new Error('event ids must be unique');
  const eventInputs = eventIds.map(id => {
    const event = (eventById as any).get(id);
    if (!event) throw new Error(`pack references unknown event ${id}`);
    return eventInput(event);
  });
  const relationIds = [...new Set((pack.relationIds ?? []).map(String))].sort();
  const relationById = new Map(relations.map(relation => [String(relation.id), relation]));
  if (relationById.size !== relations.length) throw new Error('relation ids must be unique');
  const relationInputs = relationIds.map(id => {
    const relation = (relationById as any).get(id);
    // The original P0-1 API allowed relation ids without relation records.
    // Preserve that shape, but when records are supplied they participate.
    return relation ? relationInput(relation) : { id, unresolved: true };
  });
  const coveredRanges = [...(pack.coveredRanges ?? [])]
    .map(range => [range.from, range.to])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const inputFingerprint = sha256(JSON.stringify({
    contract: 'ssm-v1',
    bookKey: pack.bookKey ?? null,
    bookRevision: pack.bookRevision ?? null,
    contentVersion: pack.contentVersion ?? null,
    eventIds,
    events: eventInputs,
    relationIds,
    relations: relationInputs,
    coveredRanges,
  }));
  const outputFingerprint = sha256(JSON.stringify({
    contract: 'ssm-v1',
    level: pack.level ?? null,
    label: pack.label ?? null,
    summary: pack.summary ?? '',
    openQuestions: [...(pack.openQuestions ?? [])].map(String).sort(),
  }));
  return { inputFingerprint, outputFingerprint };
}

export function fingerprintPack(pack: any, events: any = [], relations: any = []) {
  const { inputFingerprint, outputFingerprint } = fingerprintPackParts(pack, events, relations);
  return `${inputFingerprint}:${outputFingerprint}`;
}

function eventText(event: any) {
  return [
    event.summary, event.action, event.outcome,
    ...(event.goals ?? []), ...(event.participantIds ?? []),
    ...(event.tags ?? []),
  ].filter(Boolean).join('\n');
}

function encodeCursor(value: any) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: any) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('cursor must be a short string');
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is invalid');
  }
}

function visiblePayloadLength(result: any) {
  // Reserve six digits for usedChars so setting the reported value cannot
  // push the serialized payload over the same budget.
  return JSON.stringify({ ...result, usedChars: 999999 }).length;
}

/**
 * Deterministic, bounded recall. Never returns events beyond `atFrontier`.
 * The budget applies to the complete model-visible JSON payload, not only
 * the items array. Cursors bind a snapshot, query, frontier and chronology.
 */
export function recall({ query = '', events = [], relations = [], atFrontier, chronology = 'read', budgetChars = 6000, maxItems = 8, cursor }: any = {}) {
  if (!Number.isSafeInteger(atFrontier) || atFrontier < 0) throw new Error('atFrontier must be a non-negative integer');
  if (chronology !== 'read' && chronology !== 'story') throw new Error('chronology must be read or story');
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 200) throw new Error('budgetChars must be an integer of at least 200');
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new Error('maxItems must be a positive integer');
  if (!Array.isArray(events) || !Array.isArray(relations)) throw new Error('events and relations must be arrays');
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !Number.isSafeInteger(event.revealedAt) || event.revealedAt < 0) {
      throw new Error('each event needs a string id and non-negative revealedAt');
    }
  }
  for (const relation of relations) {
    if (!relation || typeof relation.id !== 'string' || !Number.isSafeInteger(relation.revealedAt) || relation.revealedAt < 0) {
      throw new Error('each relation needs a string id and non-negative revealedAt');
    }
  }
  const rawQuery = typeof query === 'string' ? query.trim() : '';
  const wanted = rawQuery ? normalizeName(rawQuery) : '';
  const tokens = wanted ? wanted.split(' ').filter(Boolean) : [];
  const order = orderEvents(events.filter(event => event.revealedAt <= atFrontier), chronology).events;
  const position = new Map(order.map((event, index) => [String(event.id), index]));
  const visibleRelations = relations.filter(relation => relation.revealedAt <= atFrontier);
  const snapshot = sha256(JSON.stringify({
    v: 2,
    query: wanted,
    atFrontier,
    chronology,
    // Reuse the full semantic/evidence projection; a summary, evidence or
    // relation-content update must invalidate an old pagination cursor.
    events: order.map(eventInput),
    relations: visibleRelations.map(relationInput),
  }));
  let offset = 0;
  if (cursor !== undefined && cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (!decoded || decoded.v !== 1 || decoded.snapshot !== snapshot || decoded.query !== wanted ||
      decoded.atFrontier !== atFrontier || decoded.chronology !== chronology ||
      !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error('cursor does not belong to this query/snapshot');
    }
    offset = decoded.offset;
  }
  if (offset > order.length) throw new Error('cursor offset is outside the recall result');
  const scored = [];
  for (const event of order) {
    const text = normalizeName(eventText(event));
    let score = 0;
    if (tokens.length) {
      if (text.includes(wanted)) score += 100;
      score += tokens.filter(token => text.includes(token)).length * 20;
      if (!score) continue;
    }
    scored.push({ event, score });
  }
  scored.sort((a, b) => b.score - a.score ||
    (position.get(String(a.event.id)) ?? 0) - (position.get(String(b.event.id)) ?? 0) ||
    String(a.event.id).localeCompare(String(b.event.id)));
  const items = [];
  let budgetBlocked = false;
  for (let index = offset; index < scored.length; index++) {
    if (items.length >= maxItems) break;
    const { event, score } = scored[index];
    const item = {
      id: String(event.id),
      summary: event.summary,
      revealedAt: event.revealedAt,
      storyOrder: Number.isFinite(event.storyOrder) ? event.storyOrder : null,
      participantIds: event.participantIds ?? [],
      evidence: event.evidence ?? [],
      status: event.status,
      score,
    };
    // A provisional result is used to measure the whole visible payload.
    const provisional = {
      items: [...items, item],
      relations: [],
      omitted: [],
      omittedCount: 0,
      usedChars: 0,
      budgetChars,
      budgetExhausted: false,
      nextCursor: null,
      chronology,
      scope: 'confirmed-frontier-only',
      semanticMatchVerified: false,
    };
    if (visiblePayloadLength(provisional) > budgetChars) {
      budgetBlocked = true;
      break;
    }
    items.push(item);
  }
  const nextOffset = offset + items.length < scored.length ? offset + items.length : null;
  const participantIds = new Set(items.flatMap(item => item.participantIds.map(String)));
  const relationCandidates = visibleRelations.filter(relation => {
    if (!tokens.length) return true;
    const text = normalizeName([relation.relation ?? '', relation.fromEntityId ?? '', relation.toEntityId ?? ''].join(' '));
    return text.includes(wanted) || participantIds.has(String(relation.fromEntityId)) || participantIds.has(String(relation.toEntityId));
  }).slice(0, 4);
  const relationsOut = [];
  let relationsTruncated = relationCandidates.length < visibleRelations.filter(relation => {
    if (!tokens.length) return true;
    const text = normalizeName([relation.relation ?? '', relation.fromEntityId ?? '', relation.toEntityId ?? ''].join(' '));
    return text.includes(wanted) || participantIds.has(String(relation.fromEntityId)) || participantIds.has(String(relation.toEntityId));
  }).length;
  for (const relation of relationCandidates) {
    const provisional = {
      items, relations: [...relationsOut, relation], omitted: [], omittedCount: 0,
      usedChars: 0, budgetChars, budgetExhausted: false, nextCursor: null,
      chronology, scope: 'confirmed-frontier-only', semanticMatchVerified: false,
    };
    if (visiblePayloadLength(provisional) > budgetChars) { relationsTruncated = true; break; }
    relationsOut.push(relation);
  }
  const omitted = scored.slice(offset + items.length, offset + items.length + 20).map(entry => String(entry.event.id));
  const omittedCount = Math.max(0, scored.length - (offset + items.length));
  const base = {
    items,
    relations: relationsOut,
    omitted,
    omittedCount,
    usedChars: 0,
    budgetChars,
    budgetExhausted: omittedCount > 0 || budgetBlocked || relationsTruncated,
    nextCursor: nextOffset === null ? null : encodeCursor({ v: 1, snapshot, query: wanted, atFrontier, chronology, offset: nextOffset }),
    chronology,
    scope: 'confirmed-frontier-only',
    semanticMatchVerified: false,
    noResultsMeaning: 'No deterministic match under these filters; not proof that a memory or event never existed.',
    ...(budgetBlocked ? { budgetBlocked: true } : {}),
    ...(relationsTruncated ? { relationsTruncated: true } : {}),
  };
  // Trim optional metadata/omissions until the complete visible JSON fits.
  while (visiblePayloadLength(base) > budgetChars) {
    if (base.omitted.length) { base.omitted.pop(); (base as any).omittedTruncated = true; continue; }
    if (base.relations.length) { base.relations.pop(); base.relationsTruncated = true; continue; }
    if (base.items.length) { base.items.pop(); base.budgetBlocked = true; base.nextCursor = null; base.budgetExhausted = true; continue; }
    break;
  }
  if (visiblePayloadLength(base) > budgetChars) {
    // A very small budget cannot carry the normal metadata. Return a compact,
    // explicit refusal instead of overflowing the model-visible payload.
    const compact = {
      items: [],
      relations: [],
      omitted: [],
      omittedCount,
      usedChars: 0,
      budgetChars,
      budgetExhausted: true,
      nextCursor: null,
      budgetBlocked: true,
    };
    compact.usedChars = JSON.stringify(compact).length;
    if (JSON.stringify(compact).length > budgetChars) throw new Error('budgetChars is too small for a valid recall receipt');
    return compact;
  }
  base.usedChars = JSON.stringify(base).length;
  return base;
}

function optionalText(value: any, name: any, max: any, { allowEmpty = false }: any = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null`);
  if (cpLength(value) > max) throw new Error(`${name} exceeds ${max} characters`);
  if (!allowEmpty && !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

function textArray(value: any, name: any, maxItems: any, maxLength: any) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} strings`);
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim() || cpLength(item) > maxLength) throw new Error(`${name} contains an invalid string`);
    return item;
  });
}

const CHANGE_FIELDS = new Set([
  'kind', 'summary', 'names', 'aliases', 'fromName', 'toName',
  'fromEntityId', 'toEntityId', 'relation', 'outcome', 'storyTime',
  'evidenceSegmentIds', 'quote', 'sourceKind', 'revision',
]);

/**
 * Validate one optional story-change candidate from a reading turn.
 * Every field that can be persisted is checked here; unknown fields are
 * rejected rather than passed through.
 */
export function validateStoryChange(change: any, book: any, { frontier = book.frontier }: any = {}) {
  assertBook(book);
  if (!Number.isSafeInteger(frontier) || frontier < 0 || frontier > book.segments.length) throw new Error('invalid frontier');
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('change must be an object');
  for (const key of Object.keys(change)) if (!CHANGE_FIELDS.has(key)) throw new Error(`unknown story change field: ${key}`);
  if (!CHANGE_KINDS.has(change.kind)) throw new Error('invalid change kind');
  if (typeof change.summary !== 'string' || !change.summary.trim() || cpLength(change.summary) > 240) throw new Error('summary must be 1–240 characters');
  if (change.revision !== undefined && book.revision !== undefined && change.revision !== book.revision) throw new Error('change belongs to another revision');
  if (!Array.isArray(change.evidenceSegmentIds) || change.evidenceSegmentIds.length < 1 || change.evidenceSegmentIds.length > 4) {
    throw new Error('evidenceSegmentIds must contain 1–4 ids');
  }
  const ids: number[] = [...new Set<number>(change.evidenceSegmentIds)];
  if (ids.length !== change.evidenceSegmentIds.length) throw new Error('duplicate evidenceSegmentIds');
  for (const id of ids) {
    integer(id, 'evidenceSegmentIds');
    if (id < 0 || id >= frontier) throw new Error('story change cites an unread segment');
    segmentById(book, id);
  }
  const quote = change.quote;
  let evidence = [];
  let sourceKind = change.sourceKind ?? 'model_interpretation';
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error('invalid sourceKind');
  if (quote !== undefined) {
    if (typeof quote !== 'string' || !quote || cpLength(quote) > 120) throw new Error('quote must be 1–120 characters');
    const matches = [];
    for (const id of ids) {
      try {
        const [ref] = validateEvidence(book, [{ segmentId: id, quote }], { frontier, maxRefs: 1, maxQuote: 120 });
        matches.push(ref);
      } catch {
        // This segment does not contain the quote; try the next cited segment.
      }
    }
    if (matches.length !== 1) throw new Error('quote must match exactly one cited segment');
    evidence = matches;
  } else {
    sourceKind = 'model_interpretation';
    evidence = ids.map(segmentId => {
      const segment = segmentById(book, segmentId);
      return { segmentId, start: segment.start, end: segment.end };
    });
  }
  const names = textArray(change.names, 'names', 8, 60);
  const aliases = textArray(change.aliases, 'aliases', 8, 60);
  const fromName = optionalText(change.fromName, 'fromName', 60);
  const toName = optionalText(change.toName, 'toName', 60);
  const fromEntityId = optionalText(change.fromEntityId, 'fromEntityId', 80);
  const toEntityId = optionalText(change.toEntityId, 'toEntityId', 80);
  const relation = optionalText(change.relation, 'relation', 80);
  const outcome = optionalText(change.outcome, 'outcome', 240);
  const storyTime = optionalText(change.storyTime, 'storyTime', 80);
  const qualityFlags = [];
  let entityBinding = null;
  if (change.kind === 'relation') {
    if (!relation) throw new Error('relation changes need a relation label');
    if ((!fromName && !fromEntityId) || (!toName && !toEntityId)) throw new Error('relation changes need both sides by name or entity id');
    entityBinding = fromEntityId && toEntityId ? 'ids' : 'names-only-unresolved';
    if (entityBinding !== 'ids') qualityFlags.push('relation-names-unresolved');
  } else if (fromName || toName || fromEntityId || toEntityId || relation) {
    throw new Error('relation fields are only valid for kind=relation');
  }
  return {
    kind: change.kind,
    summary: change.summary,
    names,
    aliases,
    fromName,
    toName,
    fromEntityId,
    toEntityId,
    relation,
    outcome,
    storyTime,
    evidence,
    sourceKind,
    entityBinding,
    qualityFlags,
    status: 'candidate',
    progressAdvanced: false,
  };
}

export function validateStoryChanges(changes: any, book: any, options: any = {}) {
  if (!Array.isArray(changes) || changes.length > 4) throw new Error('changes must contain at most 4 candidates');
  return changes.map(change => validateStoryChange(change, book, options));
}
