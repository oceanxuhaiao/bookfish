import { isHistory, historyFind, historySelect } from './history.ts';
import { remoteLayout } from './paged-book.ts';
import { requiredText, digest } from './books.ts';
import type { BookEntry, ReadingTask } from './library.ts';

export interface Evidence { segmentId: number; start: number; end: number; quote: string }
export interface EpisodeContent {
  trigger: string; interpretation: string; priorJudgment: string | null; reason: string | null;
  mood: { label: string; intensity: number | null } | null;
  evidence: Evidence[]; characters: { name: string; aliases: string[] }[];
  questions: string[]; relatedEpisodeIds: string[];
}
export interface ReadingEpisode {
  id: string; sequence: number; bookKey: string; recordedAt: string;
  kind: 'reading' | 'reflection' | 'revision'; content: EpisodeContent;
  taskId?: string; requestId?: string; revises?: string;
}
export const MAX_EPISODES = 100000;
export function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function optional(value: unknown, field: string, max: number): string | null {
  return value === undefined || value === null ? null : requiredText(value, field, max);
}
function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must be an array of at most ${max}`);
  return value;
}
export function normalizeEpisode(input: unknown, entry: BookEntry, earlier: readonly ReadingEpisode[], frontier = entry.frontier): EpisodeContent {
  const v = record(input, 'episode');
  const evidence = array(v.evidence, 'evidence', 5).map(item => {
    const e = record(item, 'evidence');
    if (!Number.isSafeInteger(e.segmentId) || (e.segmentId as number) < 0 || (e.segmentId as number) >= frontier) throw new Error('Evidence must belong to a confirmed range of this exact revision');
    const segment = entry.book.segments[e.segmentId as number];
    if (typeof e.quote !== 'string' || !e.quote.trim() || Array.from(e.quote).length > 300) throw new Error('Evidence quote must be 1–300 exact source characters');
    let start: number;
    if (e.start === undefined) {
      const index = segment.text.indexOf(e.quote);
      if (index < 0) throw new Error('Evidence quote does not match the supplied source text');
      if (segment.text.indexOf(e.quote, index + 1) >= 0) throw new Error('Evidence quote is ambiguous; provide its absolute Unicode-codepoint start');
      start = segment.start + Array.from(segment.text.slice(0, index)).length;
    } else {
      if (!Number.isSafeInteger(e.start)) throw new Error('Evidence start must be an absolute Unicode-codepoint offset');
      start = e.start as number;
    }
    const end = start + Array.from(e.quote).length;
    if (start < segment.start || end > segment.end || (e.end !== undefined && e.end !== end) ||
      Array.from(segment.text).slice(start - segment.start, end - segment.start).join('') !== e.quote) throw new Error('Evidence offsets and exact quote do not match this segment');
    return { segmentId: e.segmentId as number, start, end, quote: e.quote };
  });
  if (!evidence.length) throw new Error('An episode needs at least one exact source quotation');
  let mood: EpisodeContent['mood'] = null;
  if (v.mood !== undefined && v.mood !== null) {
    const m = record(v.mood, 'mood');
    if (m.intensity !== undefined && m.intensity !== null && (!Number.isInteger(m.intensity) || (m.intensity as number) < 1 || (m.intensity as number) > 5)) throw new Error('Mood intensity must be 1–5 or omitted');
    mood = { label: requiredText(m.label, 'mood.label', 80), intensity: m.intensity === undefined || m.intensity === null ? null : m.intensity as number };
  }
  const characters = array(v.characters ?? [], 'characters', 8).map(item => {
    const c = record(item, 'character');
    return { name: requiredText(c.name, 'character.name', 60), aliases: [...new Set(array(c.aliases ?? [], 'aliases', 8).map(a => requiredText(a, 'alias', 60)))] };
  });
  const relatedEpisodeIds = [...new Set(array(v.relatedEpisodeIds ?? [], 'relatedEpisodeIds', 8).map(id => {
    const value = requiredText(id, 'related episode id', 80);
    if (!historyFind(earlier,{id:value,bookKey:entry.book.key})) throw new Error('Related episode must be an earlier record from the same revision');
    return value;
  }))];
  return { trigger: requiredText(v.trigger, 'trigger', 500), interpretation: requiredText(v.interpretation, 'interpretation', 800),
    priorJudgment: optional(v.priorJudgment, 'priorJudgment', 500), reason: optional(v.reason, 'reason', 800), mood, evidence, characters,
    questions: array(v.questions ?? [], 'questions', 8).map(q => requiredText(q, 'question', 200)), relatedEpisodeIds };
}

export function validateEpisodes(raw: unknown, books: Map<string, BookEntry>, tasks: readonly ReadingTask[]): ReadingEpisode[] {
  const taskById=isHistory(tasks)?null:new Map(tasks.map(t=>[t.id,t]));
  const paged=isHistory(raw);const source=raw as ReadingEpisode[];const result: ReadingEpisode[] = [];let lastSequence=0;const earlier=new Map<string,{id:string;bookKey:string;sequence:number;taskId?:string}>(); const ids = new Set<string>(); const requests = new Set<string>(); const readingTasks = new Set<string>();
  for (const item of array(raw, 'episodes', MAX_EPISODES)) {
    const e = record(item, 'episode record') as unknown as ReadingEpisode;
    const entry = books.get(e.bookKey);
    if (!entry || typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id) || ids.has(e.id) ||
      !Number.isSafeInteger(e.sequence) || e.sequence <= lastSequence ||
      typeof e.recordedAt !== 'string' || !Number.isFinite(Date.parse(e.recordedAt)) || new Date(e.recordedAt).toISOString() !== e.recordedAt ||
      !['reading', 'reflection', 'revision'].includes(e.kind)) throw new Error('Invalid episode identity, time or order');
    const related=Array.isArray(e.content?.relatedEpisodeIds)?e.content.relatedEpisodeIds.map(id=>earlier.get(id)).filter(Boolean) as ReadingEpisode[]:[];
    const content = normalizeEpisode(e.content, entry, related);
    if (JSON.stringify(content) !== JSON.stringify(e.content)) throw new Error('Episode content or evidence is inconsistent');
    if (e.kind === 'reading') {
      const task = taskById?taskById.get(e.taskId!):historyFind(tasks,{id:e.taskId});
      if (!task || task.status !== 'committed' || task.bookKey !== e.bookKey || task.receipt?.episodeId !== e.id || readingTasks.has(task.id) ||
        !content.evidence.some(q => q.segmentId === task.segmentId) || content.evidence.some(q => q.segmentId > task.segmentId) || e.requestId !== undefined || e.revises !== undefined) throw new Error('Episode is not backed by its confirmed task');
      readingTasks.add(task.id);
    } else {
      if (typeof e.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(e.requestId) || requests.has(e.requestId) || e.taskId !== undefined) throw new Error('Invalid or duplicate reflection request');
      requests.add(e.requestId);
      if (e.kind === 'revision' ? earlier.get(e.revises!)?.bookKey!==e.bookKey : e.revises !== undefined) throw new Error('Revision must reference an earlier record of the same revision');
    }
    ids.add(e.id);
    earlier.set(e.id,{id:e.id,bookKey:e.bookKey,sequence:e.sequence,taskId:e.taskId});lastSequence=e.sequence;
    if(!paged)result.push({ id: e.id, sequence: e.sequence, bookKey: e.bookKey, recordedAt: e.recordedAt, kind: e.kind, content,
      ...(e.taskId !== undefined ? { taskId: e.taskId } : {}), ...(e.requestId !== undefined ? { requestId: e.requestId } : {}), ...(e.revises !== undefined ? { revises: e.revises } : {}) });
  }
  for (const task of tasks) if (task.receipt?.episodeId && earlier.get(task.receipt!.episodeId)?.taskId!==task.id) throw new Error('Receipt episode is missing');
  return paged?source:result;
}

export function evidenceView(entry: BookEntry, evidence: Evidence) {
  const segment = entry.book.segments[evidence.segmentId];
  const source = entry.book.remote;
  let chapterIndex = -1, count = 0;
  const layout=remoteLayout(entry.book);if(layout)chapterIndex=layout.ends.findIndex(end=>evidence.segmentId<end);
  if (source&&!layout) for (const chapter of source.cache) {
    count += Math.ceil(Array.from(`# ${source.catalog.chapters[chapter.index].title}\n${chapter.text}\n\n`).length / 1200);
    if (evidence.segmentId < count) { chapterIndex = chapter.index; break; }
  }
  return { ...evidence, chapter: segment.chapter, segmentHash: digest(segment.text), source: source && chapterIndex >= 0 ? {
    url: source.catalog.chapters[chapterIndex].url, fetchedAt: source.cache[chapterIndex].fetchedAt, chapterHash: source.cache[chapterIndex].hash,
  } : { filename: entry.book.filename, sourceHash: entry.book.sourceHash }, exactTextMatched: true as const,
  interpretationVerified: false as const };
}

export const EPISODE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    trigger: { type: 'string', maxLength: 500, description: 'Event in the cited text that prompted this record; your account, not a verified fact.' },
    interpretation: { type: 'string', maxLength: 800 }, priorJudgment: { type: ['string', 'null'], maxLength: 500 },
    reason: { type: ['string', 'null'], maxLength: 800, description: 'Short stated explanation, never hidden chain-of-thought. Omit when not recorded.' },
    mood: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { label: { type: 'string', maxLength: 80 }, intensity: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['label'] }] },
    evidence: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, properties: {
      segmentId: { type: 'integer', minimum: 0 }, quote: { type: 'string', minLength: 1, maxLength: 300, description: 'Exact substring of the provided segment, never paraphrase.' },
      start: { type: 'integer', minimum: 0, description: 'Optional absolute Unicode-codepoint offset; omit for unique quotations so the World locates it.' },
    }, required: ['segmentId', 'quote'] } },
    characters: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 60 }, aliases: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 60 } } }, required: ['name'] } },
    questions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
    relatedEpisodeIds: { type: 'array', maxItems: 8, items: { type: 'string' } },
  }, required: ['trigger', 'interpretation', 'evidence'],
};
