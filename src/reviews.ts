import { historySelect, historyFind } from './history.ts';
import { randomUUID } from 'node:crypto';
import { digest, requiredText } from './books.ts';
import { normalizeEpisode, record, type Evidence } from './journal.ts';
import type { BookEntry, LibraryState } from './library.ts';
export interface ReviewJob { id: string; requestId: string; bookKey: string; snapshot: string; snapshotV2?: ReviewSnapshot; episodeCount: number; createdAt: number; expiresAt: number;
  status: 'pending' | 'failed' | 'cancelled' | 'completed'; rangesSeen: number[]; episodesSeen: number[]; error: string | null; reviewId?: string }
export interface BookReview { id: string; jobId: string; bookKey: string; version: number; recordedAt: string; title: string; text: string;
  snapshot: string; snapshotV2?: ReviewSnapshot; episodeIds: string[]; evidence: Evidence[]; coverage: { segments: number; episodes: number; rangesWithoutEpisode: number }; previousId: string | null }
export interface ReviewSnapshot { frontier: number; sourceHash: string | null; catalogHash: string | null; episodeIds: string[] }
/** Launch boundary: a full-text review must fit the 30-minute material walk. */
export const REVIEW_MAX_SEGMENTS = 300;
function assertReviewSize(entry: BookEntry) {
  if (entry.frontier > REVIEW_MAX_SEGMENTS) throw new Error(`Long-book full review is disabled in this release: ${entry.frontier} confirmed segments exceeds the ${REVIEW_MAX_SEGMENTS}-segment limit. Use the reading journal or a stage review.`);
}
export function completed(entry: BookEntry) { return entry.frontier === entry.book.segments.length && (!entry.book.remote ||
  entry.book.remote.cache.length === entry.book.remote.catalog.chapters.length && entry.book.remote.catalog.publicationStatus === 'finished'); }
export function reviewSnapshot(state: LibraryState, key: string, count = Infinity) { const entry = state.books.find(e => e.book.key === key)!;
  return digest(JSON.stringify([key, entry.frontier, entry.book.sourceHash, historySelect(state.episodes,{bookKey:key}).slice(0, count).map(e => e.id)])); }
export function captureReviewSnapshot(state: LibraryState, key: string, count = Infinity): ReviewSnapshot { const entry = state.books.find(e => e.book.key === key)!;
  return { frontier: entry.frontier, sourceHash: entry.book.sourceHash, catalogHash: entry.book.remote?.catalog.hash ?? null,
    episodeIds: historySelect(state.episodes,{bookKey:key}).slice(0, count).map(e => e.id) }; }
function snapshotDigest(key: string, snapshot: ReviewSnapshot) { return digest(JSON.stringify([key, snapshot.frontier, snapshot.sourceHash, snapshot.episodeIds])); }
function legacySnapshot(state: LibraryState, job: ReviewJob): ReviewSnapshot | null {
  const entry = state.books.find(e => e.book.key === job.bookKey);
  const episodes = historySelect(state.episodes, { bookKey: job.bookKey }).slice(0, job.episodeCount);
  if (!entry || episodes.length !== job.episodeCount) return null;
  return { frontier: job.rangesSeen.length, sourceHash: null, catalogHash: null, episodeIds: episodes.map(e => e.id) };
}
export function beginReview(state: LibraryState, args: Record<string, unknown>, now: number) {
  const bookKey = requiredText(args.bookKey, 'bookKey', 150), requestId = requiredText(args.requestId, 'requestId', 80);
  if (!/^[A-Za-z0-9:_-]+$/.test(requestId)) throw new Error('Review requestId must be ASCII');
  const entry = state.books.find(e => e.book.key === bookKey);
  if (!entry || !completed(entry)) throw new Error('Full-book review requires a fully and continuously confirmed finished revision');
  assertReviewSize(entry);
  if (state.paused || state.selected !== bookKey) throw new Error('Select and resume this revision before starting a review');
  const old = state.reviewJobs.find(j => j.bookKey === bookKey && j.requestId === requestId);
  if (old) return { duplicate: true, job: old };
  if (state.reviewJobs.length >= 1000) throw new Error('Review job history full');
  const snapshot = reviewSnapshot(state, bookKey);
  const pending = state.reviewJobs.find(j => j.bookKey === bookKey && j.status === 'pending' && j.expiresAt > now);
  if (pending) throw new Error('A review is already pending; use its jobId or explicitly fail it first');
  for (const j of state.reviewJobs) if (j.status === 'pending' && j.expiresAt <= now) { j.status = 'failed'; j.error = 'Review lease expired; retry with a new requestId'; }
  const job: ReviewJob = { id: randomUUID(), bookKey, requestId, snapshot, snapshotV2: captureReviewSnapshot(state, bookKey), episodeCount: historySelect(state.episodes,{bookKey}).length, createdAt: now, expiresAt: now + 30 * 60000, status: 'pending', rangesSeen: [], episodesSeen: [], error: null };
  state.reviewJobs.push(job); return { duplicate: false, job };
}
function pendingJob(state: LibraryState, id: unknown, now: number) {
  const job = state.reviewJobs.find(j => j.id === id);
  if (!job || job.status !== 'pending' || job.expiresAt <= now || state.paused || state.selected !== job.bookKey || job.snapshot !== reviewSnapshot(state, job.bookKey)) throw new Error('Review job is stale, paused, expired or cancelled; fail it and begin a new request');
  return job;
}
export function reviewMaterials(state: LibraryState, args: Record<string, unknown>, now: number) {
  const job = pendingJob(state, args.jobId, now); const kind = args.kind;
  if (kind !== 'ranges' && kind !== 'episodes') throw new Error('Material kind must be ranges or episodes');
  const offset = args.offset ?? 0, limit = args.limit ?? 3;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 5) throw new Error('Invalid material page');
  const entry = state.books.find(e => e.book.key === job.bookKey)!; assertReviewSize(entry); const episodes = historySelect(state.episodes,{bookKey:job.bookKey});
  const receipts = new Map(historySelect(state.tasks,{bookKey:job.bookKey,status:'committed'}).map(t => [t.segmentId, t.receipt!]));
  const total=kind==='ranges'?entry.book.segments.length:episodes.length;
  const row=(i:number)=>kind==='ranges'?{segment:entry.book.segments[i],receipt:receipts.get(i)!}:episodes[i];
  if ((offset as number) > total) throw new Error('Material offset out of range');
  const items: unknown[] = []; let used = 0;
  for (let i = offset as number; i < Math.min(total, (offset as number) + (limit as number)); i++) {
    const item=row(i);const size = JSON.stringify(item).length; if (items.length && used + size > 20000) break;
    if (size > 20000) throw new Error('Record exceeds the review material budget');
    items.push(item); used += size;
  }
  const seen = kind === 'ranges' ? job.rangesSeen : job.episodesSeen;
  for (let i = offset as number; i < (offset as number) + items.length; i++) if (!seen.includes(i)) seen.push(i);
  seen.sort((a, b) => a - b);
  return { jobId: job.id, bookKey: job.bookKey, snapshot: job.snapshot, kind, offset, items, total: total,
    nextOffset: (offset as number) + items.length < total ? (offset as number) + items.length : null,
    coverage: { rangesOffered: job.rangesSeen.length, totalRanges: entry.frontier, episodesOffered: job.episodesSeen.length, totalEpisodes: episodes.length },
    source: 'untrusted-external-book-and-authored-notes', offeredIsNotProofOfComprehension: true };
}
function content(state: LibraryState, key: string, args: Record<string, unknown>) {
  const entry = state.books.find(e => e.book.key === key)!;
  const title = requiredText(args.title, 'title', 160), text = requiredText(args.text, 'text', 12000);
  if (Array.from(text).length < 100) throw new Error('Review text must contain at least 100 characters');
  if (!Array.isArray(args.episodeIds) || args.episodeIds.length > 12) throw new Error('episodeIds needs at most twelve saved records');
  const episodeIds = [...new Set(args.episodeIds.map(id => {
    if (!historyFind(state.episodes,{id,bookKey:key})) throw new Error('Review episode must belong to this exact revision'); return id as string;
  }))];
  if (historySelect(state.episodes,{bookKey:key}).length>0 && !episodeIds.length) throw new Error('Cite at least one saved episode when reading records exist');
  const evidence = normalizeEpisode({ trigger: 'Review citation validation', interpretation: 'Text identity only', evidence: args.evidence }, entry, state.episodes).evidence;
  return { title, text, episodeIds, evidence };
}
export function finishReview(state: LibraryState, args: Record<string, unknown>, now: number) {
  const oldJob = state.reviewJobs.find(j => j.id === args.jobId);
  if (!oldJob) throw new Error('Review job missing');
  const normalized = content(state, oldJob.bookKey, args);
  if (oldJob.status === 'completed') {
    const old = state.reviews.find(r => r.id === oldJob.reviewId)!;
    if (JSON.stringify(normalized) !== JSON.stringify({ title: old.title, text: old.text, episodeIds: old.episodeIds, evidence: old.evidence })) throw new Error('Review retry must match saved version');
    return { duplicate: true, review: old };
  }
  const job = pendingJob(state, args.jobId, now); const entry = state.books.find(e => e.book.key === job.bookKey)!; assertReviewSize(entry);
  const episodes = historySelect(state.episodes,{bookKey:job.bookKey});
  if (job.rangesSeen.length !== entry.frontier || job.episodesSeen.length !== episodes.length) throw new Error('Request all ranges and episode material pages before writing a full-book review');
  if (state.reviews.length >= 500) throw new Error('Review version history full');
  const previous = state.reviews.filter(r => r.bookKey === job.bookKey).at(-1);
  const review: BookReview = { id: randomUUID(), jobId: job.id, bookKey: job.bookKey, version: (previous?.version ?? 0) + 1, recordedAt: new Date(now).toISOString(),
    ...normalized, snapshot: job.snapshot, snapshotV2: job.snapshotV2 ?? captureReviewSnapshot(state, job.bookKey), previousId: previous?.id ?? null,
    coverage: { segments: entry.frontier, episodes: episodes.length, rangesWithoutEpisode: entry.frontier - new Set(historySelect(episodes,{kind:'reading'}).map(e => e.taskId)).size } };
  state.reviews.push(review); job.status = 'completed'; job.reviewId = review.id; return { duplicate: false, review };
}
export function failReview(state: LibraryState, args: Record<string, unknown>) {
  const job = state.reviewJobs.find(j => j.id === args.jobId); if (!job) throw new Error('Review job missing');
  if (job.status === 'completed') throw new Error('A saved review cannot be failed or overwritten');
  job.status = 'failed'; job.error = requiredText(args.reason, 'reason', 500); return job;
}
export function validateReviews(state: LibraryState) {
  if (!Array.isArray(state.reviewJobs) || state.reviewJobs.length > 1000 || !Array.isArray(state.reviews) || state.reviews.length > 500) throw new Error('Invalid review collections');
  const ids = new Set<string>(), requests = new Set<string>();
  for (const raw of state.reviewJobs) {
    const j = record(raw, 'review job') as unknown as ReviewJob; const entry = state.books.find(e => e.book.key === j.bookKey);
    if (!entry || !/^[a-f0-9-]{36}$/.test(j.id) || ids.has(j.id) || typeof j.requestId !== 'string' || j.requestId.length > 80 || !/^[A-Za-z0-9:_-]+$/.test(j.requestId) || requests.has(j.bookKey + j.requestId) ||
      typeof j.snapshot !== 'string' || !Number.isSafeInteger(j.episodeCount) || j.episodeCount < 0 || j.episodeCount > historySelect(state.episodes,{bookKey:j.bookKey}).length ||
      !Number.isSafeInteger(j.createdAt) || j.createdAt < 0 || !Number.isSafeInteger(j.expiresAt) || j.expiresAt <= j.createdAt ||
      !['pending', 'failed', 'cancelled', 'completed'].includes(j.status) || (j.error !== null && (typeof j.error !== 'string' || j.error.length > 500))) throw new Error('Invalid review job');
    if (!j.snapshotV2 && j.status === 'completed') { const legacy = legacySnapshot(state, j); if (!legacy) throw new Error('Completed review job has no verifiable snapshot'); j.snapshotV2 = legacy; }
    if (j.status === 'pending') {
      if (!completed(entry) || j.snapshot !== reviewSnapshot(state, j.bookKey, j.episodeCount)) throw new Error('Invalid pending review snapshot');
    }
    const snap = j.snapshotV2;
    if (snap) {
      if (!Number.isSafeInteger(snap.frontier) || snap.frontier < 0 || snap.frontier > entry.book.segments.length ||
        !Array.isArray(snap.episodeIds) || snap.episodeIds.some(id => typeof id !== 'string')) throw new Error('Invalid review snapshot');
      if (snap.sourceHash !== null && (typeof snap.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(snap.sourceHash))) throw new Error('Invalid review snapshot hash');
      if (snap.catalogHash !== null && (typeof snap.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(snap.catalogHash))) throw new Error('Invalid review catalog hash');
      if (snap.sourceHash !== null && snapshotDigest(j.bookKey, snap) !== j.snapshot) throw new Error('Review snapshot digest is inconsistent');
      const maxRange = Math.min(snap.frontier, entry.book.segments.length);
      if (!Array.isArray(j.rangesSeen) || new Set(j.rangesSeen).size !== j.rangesSeen.length || j.rangesSeen.some(i => !Number.isSafeInteger(i) || i < 0 || i >= maxRange)) throw new Error('Invalid material coverage');
      if (j.status === 'completed' && (j.rangesSeen.length !== snap.frontier || snap.episodeIds.length !== j.episodeCount)) throw new Error('Completed review material does not cover its snapshot');
    } else if (j.status === 'pending') throw new Error('Pending review needs a snapshot');
    if (!Array.isArray(j.episodesSeen) || new Set(j.episodesSeen).size !== j.episodesSeen.length || j.episodesSeen.some(i => !Number.isSafeInteger(i) || i < 0 || i >= j.episodeCount)) throw new Error('Invalid material coverage');
    ids.add(j.id); requests.add(j.bookKey + j.requestId);
  }
  ids.clear(); const prior = new Map<string, BookReview>();
  for (const raw of state.reviews) {
    const r = record(raw, 'review') as unknown as BookReview; const job = state.reviewJobs.find(j => j.id === r.jobId); const previous = prior.get(r.bookKey);
    if (!job || job.bookKey !== r.bookKey || job.status !== 'completed' || job.reviewId !== r.id || r.snapshot !== job.snapshot || !/^[a-f0-9-]{36}$/.test(r.id) || ids.has(r.id) || r.version !== (previous?.version ?? 0) + 1 || r.previousId !== (previous?.id ?? null) ||
      typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt)) || new Date(r.recordedAt).toISOString() !== r.recordedAt) throw new Error('Invalid review version');
    if (!r.snapshotV2 && job.snapshotV2) r.snapshotV2 = job.snapshotV2;
    const snap = r.snapshotV2;
    if (!snap) throw new Error('Saved review has no verifiable snapshot');
    if (snap.sourceHash !== null && snapshotDigest(r.bookKey, snap) !== r.snapshot) throw new Error('Saved review snapshot digest changed');
    const normalized = content(state, r.bookKey, r as unknown as Record<string, unknown>);
    const historicalEpisodes = historySelect(state.episodes,{bookKey:r.bookKey}).slice(0, job.episodeCount);
    if (r.episodeIds.some(id => !historicalEpisodes.some(e => e.id === id)) || snap.episodeIds.length !== job.episodeCount || r.episodeIds.some(id => !snap.episodeIds.includes(id))) throw new Error('Review cannot cite later records outside its snapshot');
    if (JSON.stringify(normalized) !== JSON.stringify({ title: r.title, text: r.text, episodeIds: r.episodeIds, evidence: r.evidence })) throw new Error('Review content is inconsistent');
    const entry = state.books.find(e => e.book.key === r.bookKey)!;
    if (!r.coverage || r.coverage.segments !== snap.frontier || r.coverage.episodes !== job.episodeCount || r.coverage.episodes < r.episodeIds.length ||
      r.coverage.rangesWithoutEpisode !== snap.frontier - new Set(historySelect(historicalEpisodes,{kind:'reading'}).map(e => e.taskId)).size ||
      job.rangesSeen.length !== snap.frontier || job.episodesSeen.length !== r.coverage.episodes ||
      snap.frontier > entry.book.segments.length) throw new Error('Invalid review coverage');
    ids.add(r.id); prior.set(r.bookKey, r);
  }
  for (const j of state.reviewJobs) if (j.status === 'completed' && !state.reviews.some(r => r.id === j.reviewId && r.jobId === j.id)) throw new Error('Completed review missing');
}
