import { randomUUID } from 'node:crypto';
import type { RunPhase, WorldHost } from 'cortico/core/types.ts';
import type { BookfishConfigSection } from './config.ts';
import type { Library } from './library.ts';
import { REVIEW_MAX_SEGMENTS } from './reviews.ts';
export class ReviewFlow {
  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private phase: RunPhase['state'] | 'unknown' = 'unknown';
  private idleSince = 0;
  error: string | null = null;
  constructor(private lib: Library, private cfg: BookfishConfigSection, private now = Date.now) {}
  start(host: WorldHost) { this.host = host; this.phase = 'unknown'; this.timer = setInterval(() => this.tick(), 5000); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.host = undefined; this.phase = 'unknown'; }
  onRunPhase(p: RunPhase) { if (p.state === 'idle' && this.phase !== 'idle') this.idleSince = this.now(); this.phase = p.state; }
  request(automatic = false) {
    if (!this.host) throw new Error('Not mounted');
    const current = this.lib.status().current; if (!current?.complete) throw new Error('This revision is not fully read and finished');
    const result = this.lib.beginReview({ bookKey: current.key, requestId: automatic ? `auto:${current.revision}` : `user:${randomUUID()}` });
    const host = this.host, generation = this.lib.generation();
    host.pushDeferred({ type: 'bookfish.review_opportunity', origin: 'internal', senderKey: 'bookfish', meta: { jobId: result.job.id }, render: () => {
      if (this.host !== host || this.lib.generation() !== generation || this.lib.status().paused || (automatic && (!this.cfg.automaticReading || this.cfg.automaticReview === false))) return null;
      const job = this.lib.reviews(current.key).jobs.find(j => j.id === result.job.id);
      if (job?.status !== 'pending' || job.expiresAt <= this.now()) return null;
      return `A finished-book review job is available: jobId=${job.id}, bookKey=${job.bookKey}. This revision is continuously confirmed complete. Query bookfish_review(action="materials") for BOTH ranges and episodes, following nextOffset until null for each kind, then inspect exact evidence and save with bookfish_review(action="finish"). Write a natural personal response to the book in your own Persona voice. Use notes/corrections privately; do not repeat mood labels or narrate recording, revision, checking or emotional retrospection in the article. Keep provenance in structured episodeIds/evidence, separate from prose. Do not invent personal history. Quote only this version. If interrupted, stale, or unable to finish, bookfish_review(action="fail") with a brief reason; no autonomous retry loop. Existing article versions remain immutable. Prioritize real user messages. Save the article, do not send it to desktop/voice or advance reading. This mechanism event contains no book text.`;
    } }, { trigger: 'flush' });
    return result;
  }
  tick() {
    if (!this.host || !this.cfg.automaticReading || this.cfg.automaticReview === false || this.phase !== 'idle' || this.now() - this.idleSince < 30000) return;
    try {
      const state = this.lib.status(); if (state.paused || !state.current?.complete) return;
      if (state.current.totalSegments > REVIEW_MAX_SEGMENTS) return;
      const history = this.lib.reviews(state.current.key); if (history.jobs.length || history.versions.length) return;
      this.request(true); this.error = null;
    } catch (error) { this.error = String(error).slice(0, 500); }
  }
}
