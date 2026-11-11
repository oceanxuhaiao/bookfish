import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope, RunPhase, WorldHost } from 'cortico/core/types.ts';
import { digest, requiredText } from './books.ts';
import type { Library } from './library.ts';
import { sharingLimits, type BookfishConfigSection } from './config.ts';

type State = 'candidate' | 'reserved' | 'accepted' | 'unknown' | 'unavailable' | 'dropped';
interface Share { id: string; episodeId: string; bookKey: string; text: string; createdAt: number; expiresAt: number; state: State;
  note: string; claimId?: string; claimedAt?: number; resultAt?: number; receipt?: string; visibleAt?: number }
interface Ledger { schema: 1; day: string; attempts: number; lastAttempt: number; seen: string[]; items: Share[] }
const states: State[] = ['candidate', 'reserved', 'accepted', 'unknown', 'unavailable', 'dropped'];
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const num = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export class ReadingSharing {
  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private phase: RunPhase['state'] | 'unknown' = 'unknown';
  private idleSince = 0;
  private queued?: { id: string; delivered: boolean; deadline: number; generation: number };
  private probe = false;
  private error: string | null = null;
  private reason = 'stopped';
  private ledger: Ledger = { schema: 1, day: '', attempts: 0, lastAttempt: 0, seen: [], items: [] };
  private readonly file: string;
  constructor(private lib: Library, private cfg: BookfishConfigSection, private timezone: string, private now = Date.now) { this.file = join(lib.dir, 'sharing.json'); }
  private day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }
  private quiet() {
    const limits = sharingLimits(this.cfg);
    if (!limits.quiet) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: this.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(this.now());
    const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
    return limits.startMinute === limits.endMinute || (limits.startMinute < limits.endMinute ? minute >= limits.startMinute && minute < limits.endMinute : minute >= limits.startMinute || minute < limits.endMinute);
  }
  private save(next: Ledger) {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 3 * 1024 * 1024) throw new Error('Sharing ledger full; clear share history without resetting the budget');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { const fd = openSync(temp, 'wx'); try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file); this.ledger = next;
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private change<T>(edit: (draft: Ledger) => T): T { const draft = structuredClone(this.ledger); const result = edit(draft); this.save(draft); return result; }
  start(host: WorldHost) {
    if (this.host) return;
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 3 * 1024 * 1024) throw new Error('Sharing ledger oversized');
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger;
      if (!v || v.schema !== 1 || typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || !num(v.attempts) || v.attempts > 100000 || !num(v.lastAttempt) ||
        !Array.isArray(v.seen) || v.seen.length > 10000 || new Set(v.seen).size !== v.seen.length || v.seen.some(s => typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s)) ||
        !Array.isArray(v.items) || v.items.length > 1000 || new Set(v.items.map(i => i.id)).size !== v.items.length || v.items.some(i => !i || !uuid(i.id) || !uuid(i.episodeId) || typeof i.bookKey !== 'string' || i.bookKey.length > 150 ||
          typeof i.text !== 'string' || !i.text.trim() || Array.from(i.text).length > 300 || !states.includes(i.state) || !num(i.createdAt) || !num(i.expiresAt) || typeof i.note !== 'string' || i.note.length > 300 ||
          (i.claimId !== undefined && !uuid(i.claimId)) || (i.claimedAt !== undefined && !num(i.claimedAt)) || (i.resultAt !== undefined && !num(i.resultAt)) || (i.visibleAt !== undefined && !num(i.visibleAt)) ||
          (i.receipt !== undefined && (typeof i.receipt !== 'string' || i.receipt.length > 2000)) || (['reserved', 'accepted', 'unknown', 'unavailable'].includes(i.state) && (!i.claimId || !num(i.claimedAt))))) throw new Error('Sharing ledger corrupt; preserve before repair');
      this.ledger = v;
    }
    this.host = host; this.phase = 'unknown'; this.probe = false;
    try { this.maintain(true); this.timer = setInterval(() => this.tick(), 5000); this.timer.unref?.(); }
    catch (error) { this.host = undefined; throw error; }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.host = undefined; this.queued = undefined; this.phase = 'unknown'; }
  private maintain(remount = false) {
    const draft = structuredClone(this.ledger); const day = this.day();
    if (day > draft.day) { draft.day = day; draft.attempts = 0; }
    draft.items = draft.items.filter(i => { try { this.lib.episode(i.episodeId); return true; } catch { return false; } });
    for (const item of draft.items) {
      if (item.state === 'reserved' && (remount || this.now() - item.claimedAt! > 60000)) { item.state = 'unknown'; item.note = 'No reliable result after reservation; never automatically retry'; }
      if (item.state === 'candidate' && item.expiresAt <= this.now()) { item.state = 'dropped'; item.note = 'Expired; no catch-up delivery'; }
    }
    if (JSON.stringify(draft) !== JSON.stringify(this.ledger)) this.save(draft);
    if (this.queued && this.now() >= this.queued.deadline) {
      const id = this.queued.id;
      if (this.ledger.items.some(i => i.id === id && i.state === 'candidate')) this.change(d => { const i = d.items.find(i => i.id === id)!; i.state = 'dropped'; i.note = 'Expired delivery opportunity; no replay'; });
      this.queued = undefined;
    }
  }
  private fits(text: string) { return text.split(/(?<=[。！？!?；;.\n])/u).every(sentence => Array.from(sentence.trim()).length <= sharingLimits(this.cfg).maxSentenceChars); }
  propose(args: Record<string, unknown>) {
    if (!this.host) throw new Error('Sharing not mounted'); this.maintain();
    const episodeId = requiredText(args.episodeId, 'episodeId', 80); const text = requiredText(args.text, 'text', 600);
    if (Array.from(text).length > 300) throw new Error('Share total exceeds 300 code points');
    if (!this.fits(text)) throw new Error('Share sentence exceeds configured character limit; shorten it before proposing');
    const { episode } = this.lib.episode(episodeId);
    const existing = this.ledger.items.find(i => i.episodeId === episodeId);
    if (existing) { if (existing.text !== text) throw new Error('Episode already nominated; do not replace or repeat it'); return { duplicate: true, item: structuredClone(existing) }; }
    const keys = [digest(episodeId), digest(episode.bookKey + text.normalize('NFKC').replace(/\s+/g, ''))];
    if (keys.some(k => this.ledger.seen.includes(k))) throw new Error('Already nominated or attempted; do not repeat');
    if (this.ledger.items.length >= 1000 || this.ledger.seen.length + 2 > 10000) throw new Error('Sharing history full; no new candidates');
    return this.change(d => {
      for (const old of d.items) if (old.state === 'candidate') { old.state = 'dropped'; old.note = 'Replaced by a newer candidate; no backlog'; }
      const item: Share = { id: randomUUID(), episodeId, bookKey: episode.bookKey, text, createdAt: this.now(), expiresAt: this.now() + 2 * 3600000, state: 'candidate', note: 'Model-nominated; not yet output' };
      d.items.push(item); d.seen.push(...keys); return { duplicate: false, item: structuredClone(item) };
    });
  }
  private gate() {
    if (!this.host) return 'stopped'; if (!this.cfg.automaticSharing) return 'disabled'; if (this.quiet()) return 'quiet_hours';
    const status = this.lib.status(); if (status.paused) return 'paused';
    const candidate = this.ledger.items.find(i => i.state === 'candidate'); if (!candidate) return 'no_candidate';
    if (!this.fits(candidate.text)) return 'text_limit';
    if (candidate.bookKey !== status.current?.key) return 'different_book';
    if (this.ledger.lastAttempt && this.now() < this.ledger.lastAttempt + sharingLimits(this.cfg).cooldownMs) return 'cooldown';
    return null;
  }
  onRunPhase(phase: RunPhase) { if (phase.state === 'idle' && this.phase !== 'idle') this.idleSince = this.now(); this.phase = phase.state; }
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded') {
    if (this.queued && events.some(e => e.type === 'bookfish.share_opportunity' && e.meta?.shareId === this.queued!.id)) {
      if (outcome === 'delivered') this.queued.delivered = true; else { const id = this.queued.id; this.drop(id); this.queued = undefined; }
    }
  }
  onTurnEnded() {
    if (!this.queued?.delivered) return;
    const item = this.ledger.items.find(i => i.id === this.queued!.id);
    if (item?.state === 'candidate') this.change(d => { const i = d.items.find(i => i.id === item.id)!; i.state = 'dropped'; i.note = 'Opportunity ended without output; no replay'; });
    this.queued = undefined;
  }
  tick() {
    if (!this.host) return;
    try {
      this.maintain(); const reason = this.gate(); this.reason = reason ?? 'waiting_idle'; if (reason || this.queued) return;
      if (this.phase === 'unknown') {
        if (!this.probe) { this.probe = true; this.host.pushDeferred({ type: 'bookfish.sharing_probe', origin: 'internal', senderKey: 'bookfish', render: () => this.host && this.cfg.automaticSharing && !this.quiet() ? 'Bookfish sharing enabled; waiting for an idle-phase observation. No output is requested.' : null }, { trigger: 'flush' }); }
        return;
      }
      if (this.phase !== 'idle' || this.now() - this.idleSince < 30000) { this.reason = 'chat_priority'; return; }
      const item = this.ledger.items.find(i => i.state === 'candidate')!;
      const queued = { id: item.id, delivered: false, deadline: this.now() + 60000, generation: this.lib.generation() }; this.queued = queued;
      this.host.pushDeferred({ type: 'bookfish.share_opportunity', origin: 'internal', senderKey: 'bookfish', meta: { shareId: item.id }, render: () => {
        if (this.queued !== queued || this.now() >= queued.deadline || this.lib.generation() !== queued.generation || this.gate()) return null;
        return `Optional reading share opportunity shareId=${item.id}. User conversation takes priority. Call bookfish_claim_share and WAIT for its success before any desktop output. If granted, use the exact returned text once with pet_say, then bookfish_share(action="report") with the actual receipt/outcome. If unavailable, report unavailable; never fall back to voice, console or another channel. Do not read ahead or write feelings. The event contains no book text. You may instead bookfish_share(action="drop"). Do not output during quiet hours or after the permit expires.`;
      } }, { trigger: 'flush' }); this.reason = 'awaiting_model'; this.error = null;
    } catch (error) { this.error = String(error).slice(0, 500); this.reason = 'error'; }
  }
  claim(args: Record<string, unknown>) {
    this.maintain(); const id = requiredText(args.shareId, 'shareId', 80);
    const q = this.queued; const item = this.ledger.items.find(i => i.id === id);
    if (!q || q.id !== id || !q.delivered || this.now() >= q.deadline || q.generation !== this.lib.generation() || this.gate() || item?.state !== 'candidate') throw new Error('Share permit unavailable or stale; do not output');
    const claimId = randomUUID();
    this.change(d => { const i = d.items.find(i => i.id === id)!; i.state = 'reserved'; i.claimId = claimId; i.claimedAt = this.now(); i.note = 'One attempt reserved; output not yet known'; d.attempts++; d.lastAttempt = this.now(); });
    return { shareId: id, claimId, text: item.text, outputTool: 'pet_say', expiresAt: Math.min(q.deadline, item.expiresAt, this.now() + 15000),
      instruction: 'Only use this exact text once with pet_say before expiresAt and while settings still permit sharing. Report the actual receipt. No tool available means unavailable; never use another channel.', displayConfirmed: false };
  }
  report(args: Record<string, unknown>) {
    const id = requiredText(args.shareId, 'shareId', 80), claimId = requiredText(args.claimId, 'claimId', 80);
    if (!['accepted', 'unknown', 'unavailable'].includes(args.outcome as string)) throw new Error('Invalid output outcome');
    const receipt = args.receipt === undefined ? '' : requiredText(args.receipt, 'receipt', 2000);
    if (args.outcome === 'accepted' && !receipt) throw new Error('Accepted requires an actual tool receipt');
    const item = this.ledger.items.find(i => i.id === id && i.claimId === claimId); if (!item) throw new Error('No matching reserved attempt');
    if (item.resultAt !== undefined) { if (item.state !== args.outcome || item.receipt !== receipt) throw new Error('Output retry differs'); return structuredClone(item); }
    return this.change(d => { const i = d.items.find(i => i.id === id)!; i.state = args.outcome as State; i.receipt = receipt; i.resultAt = this.now(); i.note = 'Model-reported tool result; not independently verified display'; return structuredClone(i); });
  }
  drop(id: unknown) { const shareId = requiredText(id, 'shareId', 80); const item = this.ledger.items.find(i => i.id === shareId); if (!item || item.state !== 'candidate') throw new Error('No pending candidate');
    return this.change(d => { const i = d.items.find(i => i.id === shareId)!; i.state = 'dropped'; i.note = 'Declined or dismissed'; return structuredClone(i); }); }
  visible(id: unknown) { const item = this.ledger.items.find(i => i.id === id); if (!item?.claimId) throw new Error('No output attempt');
    return this.change(d => { const i = d.items.find(i => i.id === id)!; i.visibleAt ??= this.now(); return structuredClone(i); }); }
  clearHistory() { if (!this.host) throw new Error('Sharing not mounted'); this.change(d => { d.items = []; }); this.queued = undefined; return 'Share text/history cleared; attempt budget and hashed deduplication retained'; }
  exportHistory() { if (!this.host) throw new Error('Sharing not mounted'); this.maintain();
    const payload = JSON.stringify({ items: this.ledger.items, budget: { day: this.ledger.day, attempts: this.ledger.attempts }, purpose: 'Archive only; never restore output permits or reset budgets' });
    return JSON.stringify({ format: 'bookfish-share-archive-v1', checksum: digest(payload), payload }); }
  /** Bounded page for the model-facing share tool: no unbounded text/receipt dump. */
  page(limit?: unknown, cursor?: unknown) {
    if (this.host) this.maintain();
    const max = typeof limit === 'number' && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 10) : 5;
    const all = this.ledger.items.slice().sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    let start = 0;
    if (typeof cursor === 'string' && cursor) { const at = all.findIndex(i => i.id === cursor); if (at >= 0) start = at + 1; }
    const items = all.slice(start, start + max).map(i => ({
      id: i.id, episodeId: i.episodeId, bookKey: i.bookKey, state: i.state,
      text: i.text.slice(0, 300), createdAt: i.createdAt, expiresAt: i.expiresAt,
      claimId: i.claimId, visibleAt: i.visibleAt, receipt: i.receipt?.slice(0, 300), note: i.note,
    }));
    const nextCursor = start + max < all.length ? all[start + max - 1]?.id ?? null : null;
    const full = this.status();
    return { enabled: full.enabled, reason: full.reason, error: full.error, quiet: full.quiet, timezone: full.timezone,
      limits: full.limits, budget: full.budget, outputPermit: full.outputPermit, total: full.total,
      items, nextCursor, displayEvidence: full.displayEvidence };
  }
  status() { if (this.host) this.maintain();
    const reserved = this.ledger.items.find(i => i.state === 'reserved');
    const outputPermit = reserved ? { shareId: reserved.id, claimId: reserved.claimId!, expiresAt: Math.min(reserved.claimedAt! + 15000, this.queued?.deadline ?? 0),
      allowed: this.fits(reserved.text) && !!this.host && !!this.cfg.automaticSharing && !this.quiet() && !this.lib.status().paused && this.lib.status().current?.key === reserved.bookKey && this.queued?.id === reserved.id &&
        this.queued.generation === this.lib.generation() && this.now() < Math.min(reserved.claimedAt! + 15000, this.queued.deadline) } : null;
    return { enabled: !!this.cfg.automaticSharing, reason: this.gate() ?? this.reason, error: this.error, outputPermit,
    quiet: this.quiet(), timezone: this.timezone, limits: sharingLimits(this.cfg), budget: { day: this.ledger.day, attempts: this.ledger.attempts, lastAttempt: this.ledger.lastAttempt },
    items: structuredClone(this.ledger.items.slice(-20).reverse()), total: this.ledger.items.length, displayEvidence: 'tool results are model-reported; visibleAt is user confirmation only' }; }
  /** Compact sharing state for the frequently-called status tool; full text stays in bookfish_get_sharing and the panel. */
  summary() { const full = this.status(); const candidate = this.ledger.items.find(i => i.state === 'candidate');
    return { enabled: full.enabled, reason: full.reason, error: full.error, quiet: full.quiet, timezone: full.timezone,
      limits: full.limits, budget: full.budget, outputPermit: full.outputPermit,
      candidate: candidate ? { id: candidate.id, createdAt: candidate.createdAt } : null,
      total: full.total, displayEvidence: full.displayEvidence }; }
}
