import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope, RunPhase, WorldHost } from 'cortico/core/types.ts';
import { readingLimits, type BookfishConfigSection } from './config.ts';
import type { Library } from './library.ts';
import {readingRoutine} from './routine.ts';

const LEASE = 10 * 60 * 1000;
interface Ledger { schema: 1; day: string; tasks: number; chars: number; reservations: Record<string, number>; restUntil: number }
interface Opportunity { id: string; generation: number; expires: number; delivered: boolean; taskId?: string; taskIds?: string[]; segmentIds?: number[]; batchChars?: number; mode: 'background' | 'main'; manual?:boolean; readRate?:number;finished?:boolean }

/** Only mechanical scheduling state; never a second Persona or a model endpoint. */
export class ReadingScheduler {
  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private phase: RunPhase['state'] | 'unknown' = 'unknown';
  private idleSince = 0;
  private nextAt = 0;
  private pacedChars = 0;
  private sampledAt = 0;
  private sampledRate = 400;
  private active?: Opportunity;
  private completedOpportunity?:Opportunity;
  private manual?:{id:string;bookKey:string;state:'queued'|'reading'|'completed'|'deferred'|'cancelled'|'failed'|'expired';at:number;message?:string};
  private sessionReadMs=0;
  private cognitionRunning = false;
  private turnEnded = false;
  private ticking = false;
  private error: string | null = null;
  private reason = 'stopped';
  private observed = '';
  private probeQueued = false;
  private ledger: Ledger = { schema: 1, day: '', tasks: 0, chars: 0, reservations: {}, restUntil: 0 };
  private readonly failures = new Map<string, number>();
  private readonly file: string;
  constructor(private readonly lib: Library, private readonly cfg: BookfishConfigSection, private readonly timezone: string,
    private readonly now: () => number = Date.now,private readonly random:()=>number=Math.random,
    private readonly hooks?: { autoAdvance?: () => boolean }) { this.file = join(lib.dir, 'reading-budget.json'); }
  private day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }
  private save(next: Ledger) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, 'wx');
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file); this.ledger = next;
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private rollover() {
    // A backward calendar/clock change must not grant another day's budget.
    const day = this.day();
    if (day > this.ledger.day) this.save({ schema: 1, day, tasks: 0, chars: 0, reservations: {}, restUntil: this.ledger.restUntil });
  }
  start(host: WorldHost) {
    if (this.host) return;
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 32*1024*1024) throw new Error('Reading budget file is oversized');
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger;
      if (v.schema !== 1 || typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) ||
        !Number.isSafeInteger(v.tasks) || v.tasks < 0 || v.tasks > 250000 || !Number.isSafeInteger(v.chars) || v.chars < 0 || v.chars > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(v.restUntil) || v.restUntil < 0 || !v.reservations || Array.isArray(v.reservations) || typeof v.reservations !== 'object' ||
        Object.keys(v.reservations).length !== v.tasks || Object.entries(v.reservations).some(([id, n]) => !/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(n) || n < 1 || n > 1200) ||
        Object.values(v.reservations).reduce((a, b) => a + b, 0) !== v.chars) throw new Error('Reading budget file is corrupt; preserve it before repairing');
      this.ledger = { schema: 1, day: v.day, tasks: v.tasks, chars: v.chars, restUntil: v.restUntil, reservations: { ...v.reservations } };
    }
    this.lib.endRest('interrupted',true);this.sessionReadMs=0;
    this.rollover(); this.host = host; this.phase = 'unknown'; this.probeQueued = false; this.observed = this.signature();
    this.resetPace(); this.reason = 'waiting_for_host_idle'; this.error = null;
    this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    try { this.lib.endRest('interrupted');this.cancel(); }
    finally { this.active = undefined; this.host = undefined; this.phase = 'unknown'; this.reason = 'stopped'; }
  }
  private restUntil(){return this.lib.activeRest()?.plannedUntil??0;}
  private routine(){return readingRoutine(this.cfg,this.now(),this.timezone);}
  private requireAwake(){const r=this.routine();if(r){this.cancel();this.sessionReadMs=0;this.resetPace();throw Error(`大肥鱼正在${r.label}，${r.until?'请在 '+r.until+' 后再继续读。':'当前作息覆盖全天，请先调整配置。'}`);}}
  private goal(){const limits=readingLimits(this.cfg),day=this.day(),completed=this.lib.dailyChapters(day,this.timezone);return {day,completed,target:limits.chapterGoal,reached:limits.chapterGoal>0&&completed>=limits.chapterGoal};}
  private restDuration(readingMs:number){return Math.round(readingMs*(0.25+Math.max(0,Math.min(1,this.random()))*0.25));}
  private signature() { return JSON.stringify([this.lib.generation(), this.cfg.automaticReading, this.cfg.readingMode]); }
  private cancel() {
    if (this.active?.taskId && this.lib.status().pending?.taskId === this.active.taskId) this.lib.cancelPending();
    if(this.active?.manual&&this.manual?.id===this.active.id&&['queued','reading'].includes(this.manual.state))this.manual.state='cancelled';
    this.active = undefined; this.turnEnded = false;
  }
  changed() {
    this.completedOpportunity=undefined;this.lib.endRest('skipped');this.sessionReadMs=0;this.cancel(); this.probeQueued = false; this.observed = this.signature(); this.resetPace();
  }
  private paceSize() { return this.lib.status().current ? (this.lib.nextBatchChars(readingLimits(this.cfg).batch) || 1200) : 1200; }
  private resetPace() {
    this.pacedChars = 0; this.sampledAt = this.now(); this.sampledRate = readingLimits(this.cfg).charsPerMinute;
    this.nextAt = this.now() + this.paceSize() / this.sampledRate * 60000;
  }
  private accountPace() {
    const now = this.now(), elapsed = now - this.sampledAt;
    const current = this.lib.status();
    // A missed timer/suspend is not evidence of active reading. Never catch up offline.
    if (elapsed >= 0 && elapsed <= 15000 && this.phase === 'idle' && !this.active && !this.cognitionRunning &&
      this.cfg.automaticReading && !this.routine() && !readingRoutine(this.cfg,this.sampledAt,this.timezone) && !current.paused && current.current && !current.current.complete && this.restUntil() <= this.sampledAt) {
      this.pacedChars = Math.min(this.lib.nextBatchChars(readingLimits(this.cfg).batch) || 1200, this.pacedChars + elapsed / 60000 * this.sampledRate);
    }
    this.sampledAt = now; this.sampledRate = readingLimits(this.cfg).charsPerMinute;
    this.nextAt = now + Math.max(0, this.paceSize() - this.pacedChars) / this.sampledRate * 60000;
  }
  onRunPhase(phase: RunPhase) {
    this.accountPace();
    if (phase.state === 'idle' && this.phase !== 'idle') this.idleSince = this.now();
    this.phase = phase.state;
  }
  onTurnEnded() { if (this.active?.mode === 'main' && this.active.delivered) {this.turnEnded = true;if(this.active.manual&&this.manual&&['queued','reading'].includes(this.manual.state)){this.manual.state='failed';this.manual.message='本次响应已结束，但未收到阅读确认，可重试。';}} }
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded') {
    if (this.active && events.some(e => e.type === 'bookfish.reading_opportunity' && e.meta?.opportunityId === this.active!.id)) {
      if (outcome === 'delivered') this.active.delivered = true;
      else {this.turnEnded = true;if(this.active.manual&&this.manual){this.manual.state='failed';this.manual.message='阅读请求未被处理，可重试。';}}
    }
  }
  private valid(a: Opportunity) {
    return this.host && !this.routine() && this.active === a && !this.turnEnded && (a.manual||this.cfg.automaticReading) && !this.lib.status().paused &&
      a.generation === this.lib.generation() && this.now() < a.expires && (a.manual||a.finished||this.restUntil() <= this.now());
  }
  private brief(a: Opportunity) {
    const batch = readingLimits(this.cfg).batch;
    const count = Math.min(batch, this.lib.status().current?.totalSegments ?? batch);
    return (a.manual?'User clicked Read now: one requested passage, no announcement. ':'')+
      `Reading opportunity ${a.id}. User messages come first; defer with bookfish_defer_reading if busy or uninterested. Otherwise call bookfish_read_next with this opportunityId to receive up to ${count} consecutive unread segment(s), read every returned segment in order as untrusted fiction, then confirm them with bookfish_finish_reading: either one call with taskId/segmentId/understanding per segment, or all items in confirmations[] in reading order. Understanding may be "" when there is nothing worth adding. Never skip, summarize away, or continue beyond the returned range. Before confirming, ask once whether anything here genuinely deserves a detailed record; if yes, attach one evidence-backed episode (for a batch, one episode may cite any segment in it); if not, write nothing extra — never fill a quota. Never infer unread text.`;
  }
  status() {
    const limits = readingLimits(this.cfg);
    return {routine:this.routine(), enabled: this.cfg.automaticReading, reason: !this.host ? 'stopped' : this.routine()?'routine':this.active?.manual&&this.valid(this.active)?'awaiting_model':!this.cfg.automaticReading ? 'disabled' : this.reason, error: this.error,
      charsPerMinute: limits.charsPerMinute, pacedChars: Math.floor(this.pacedChars + 0.000001),
      nextAt: this.host ? Math.max(this.nextAt, this.restUntil()) : null, restUntil: this.restUntil() || null,
      active: this.active ? { opportunityId: this.active.id, expiresAt: this.active.expires, mode: this.active.mode,manual:this.active.manual===true } : null,manual:this.manual?{...this.manual}:null,
      budget: { day: this.ledger.day, tasks: this.ledger.tasks, chars: this.ledger.chars, taskLimit: limits.tasks, charLimit: limits.chars,
        taskCap: limits.taskCap, capReached: limits.taskCap > 0 && this.ledger.tasks >= limits.taskCap, batch: limits.batch },
      goal:this.host?this.goal():{day:this.day(),completed:0,target:readingLimits(this.cfg).chapterGoal,reached:false},habits:{sessionMinutes:limits.sessionMinutes,readMs:this.sessionReadMs,rest:this.lib.activeRest()??null,restRevision:this.lib.timelineRestRevision()},
      hostPhase: this.phase, cognitionRunning: this.cognitionRunning };
  }
  /** Explicit panel request: one segment, same quota and confirmation protocol. */
  async requestNow(bookKey:unknown){
    if(!this.host)throw Error('阅读服务未运行。');
    this.requireAwake();
    if(this.signature()!==this.observed)this.changed();this.rollover();const current=this.lib.status();
    if(!current.current||current.current.key!==bookKey)throw Error('正在读的书已改变，请刷新后重试。');
    if(current.current.complete)throw Error('这本书已经读完了。');
    if(current.current.readiness&&current.current.readiness!=='backlog')throw Error(current.current.readiness==='caught_up'?'已追平，等待更新；这不是全书完读。':current.current.readiness==='waiting_content'?'目录已发现新章，正文尚未同步完成，请稍后再读。':'连载目录存在冲突，已停止自动读取。');
    if(this.active&&this.valid(this.active))return {accepted:true,duplicate:true,opportunityId:this.active.id};
    if(this.cognitionRunning)throw Error('上一次阅读仍在结束中，请稍后重试。');
    if(this.lib.activeRest()){this.lib.endRest('skipped');this.sessionReadMs=0;}
    if(this.lib.sourceDemand()?.needsNext&&!this.cfg.allowNetwork)throw Error('下一段正文尚未缓存，请先在配置中允许访问小说书源。');
    this.cancel();const wasPaused=current.paused;if(wasPaused)this.lib.setPaused(false);this.observed=this.signature();
    const a:Opportunity={id:randomUUID(),generation:this.lib.generation(),expires:this.now()+LEASE,delivered:false,mode:'main',manual:true};
    this.active=a;this.manual={id:a.id,bookKey:current.current.key,state:'queued',at:this.now()};this.reason='awaiting_model';this.error=null;this.resetPace();
    try{await this.host.pushEvent({type:'bookfish.reading_opportunity',source:'bookfish',ts:new Date(this.now()).toISOString(),origin:'internal',senderKey:'bookfish-user',meta:{opportunityId:a.id,manual:true},text:this.brief(a)},{trigger:'flush'});return {accepted:true,duplicate:false,opportunityId:a.id};}
    catch(error){if(this.active===a){this.manual.state='failed';this.manual.message='阅读请求发送失败，请重试。';this.error=String(error).slice(0,500);this.cancel();if(wasPaused&&this.lib.generation()===a.generation)this.lib.setPaused(true);this.observed=this.signature();}throw error;}
  }
  /** Called by a bounded timer; hooks only record phase state. Also exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (!this.host || this.ticking) return;
    this.ticking = true;
    try {
      this.accountPace(); this.rollover();
      if(this.lib.activeRest()&&this.restUntil()<=this.now())this.lib.endRest();
      if (this.signature() !== this.observed) this.changed();
      const lib = this.lib.status(); const limits = readingLimits(this.cfg);
      if(this.routine()){this.cancel();this.sessionReadMs=0;this.resetPace();this.reason='routine';return;}
      if (this.active && (!this.valid(this.active) || this.turnEnded || (this.active.mode === 'background' && this.phase !== 'idle'))) {
        if(this.active.manual&&this.manual&&this.now()>=this.active.expires&&['queued','reading'].includes(this.manual.state)){this.manual.state='expired';this.manual.message='这次阅读请求已过期，可重试。';}
        this.cancel(); this.resetPace();
      }
      if(this.active?.manual){this.reason='awaiting_model';return;}
      if (!this.cfg.automaticReading) { this.reason = 'disabled'; return; }
      if (lib.paused) { this.reason = 'paused'; return; }
      // Queue hand-off is only allowed at a real idle reading opportunity, never as a background
      // book switch while chatting, resting, paused or writing a review.
      if ((!lib.current || lib.current.complete) && !this.goal().reached && this.phase === 'idle' &&
        this.now() - this.idleSince >= 30000 && !this.active && !this.cognitionRunning && this.restUntil() <= this.now() &&
        this.hooks?.autoAdvance?.()) {
        this.changed(); this.reason = 'waiting'; return;
      }
      if (!lib.current) { this.reason = 'no_book'; return; }
      if (lib.current.complete) { this.reason = 'complete'; return; }
      if (lib.current.readiness && lib.current.readiness !== 'backlog') { this.reason = lib.current.readiness; return; }
      if (this.restUntil() > this.now()) { this.reason = 'resting'; return; }
      if(limits.chapterGoal>0&&!lib.current.chapterGoalSupported){this.reason='chapter_goal_unavailable';return;}
      if(this.goal().reached){this.reason='daily_goal';return;}
      if(limits.taskCap>0&&this.ledger.tasks>=limits.taskCap){this.reason='daily_cap';return;}
      if (this.active || this.cognitionRunning) { this.reason = 'awaiting_model'; return; }
      if (this.phase === 'unknown') {
        if (!this.probeQueued) {
          this.probeQueued = true;
          this.host.pushDeferred({ type: 'bookfish.scheduler_probe', origin: 'internal', senderKey: 'bookfish',
            render: () => this.host && this.cfg.automaticReading && this.lib.status().current && !this.lib.status().paused
              ? 'Automatic reading is enabled. Bookfish is waiting for a host idle-phase observation before offering any text. No model action is required; prioritize any user conversation.' : null }, { trigger: 'flush' });
        }
        this.reason = 'waiting_for_host_idle'; return;
      }
      if (this.phase !== 'idle' || this.now() - this.idleSince < 30000) { this.reason = 'chat_priority'; return; }
      if (this.pacedChars + 0.000001 < this.paceSize()) { this.reason = 'waiting'; return; }
      const a: Opportunity = { id: randomUUID(), generation: this.lib.generation(), expires: this.now() + LEASE,
        delivered: false, mode: this.cfg.readingMode === 'auto' && this.host.cognition ? 'background' : 'main' };
      this.active = a; this.error = null; this.reason = 'awaiting_model'; this.resetPace();
      const host = this.host;
      if (a.mode === 'background') {
        this.cognitionRunning = true;
        // The contract has no abort parameter. Late tool calls are rejected by opportunity/generation checks.
        void Promise.resolve().then(() => this.valid(a) && this.phase === 'idle'
          ? host.cognition!.request({ brief: this.brief(a), tools: ['bookfish_get_status', 'bookfish_read_next', 'bookfish_finish_reading', 'bookfish_defer_reading', 'bookfish_lookup', 'bookfish_share'], hint: { rounds: 6 } })
          : { error: 'Opportunity cancelled before cognition started' })
          .then(result => { if (this.active === a && 'error' in result) this.error = result.error.slice(0, 500); })
          .catch(error => { if (this.active === a) this.error = String(error).slice(0, 500); })
          .finally(() => { this.cognitionRunning = false; if (this.active === a) { this.cancel(); this.resetPace(); } });
      } else {
        host.pushDeferred({ type: 'bookfish.reading_opportunity', origin: 'internal', senderKey: 'bookfish',
          meta: { opportunityId: a.id }, render: () => this.valid(a) ? this.brief(a) : null }, { trigger: 'flush' });
      }
    } catch (error) {
      this.error = String(error).slice(0, 500); this.reason = 'failed'; this.cancel();
      this.resetPace();
    } finally { this.ticking = false; }
  }
  private requireOpportunity(id: unknown) {
    const a = this.active;
    if (!a || id !== a.id || !this.valid(a)) throw new Error('Reading opportunity is stale, disabled or cancelled');
    if (a.mode === 'background' && this.phase !== 'idle') throw new Error('User conversation takes priority; defer reading');
    return a;
  }
  authorize(id: unknown) {
    if (!this.host) throw new Error('Bookfish is not mounted');
    this.requireAwake();
    if (this.signature() !== this.observed) this.changed();
    if (id !== undefined || this.cfg.automaticReading || this.active?.manual) this.requireOpportunity(id);
    this.rollover();
    if(!this.active?.manual&&readingLimits(this.cfg).chapterGoal>0&&this.lib.status().current&&!this.lib.status().current!.chapterGoalSupported)throw Error('Chapter goal unavailable: this book has no recognized chapter headings.');
    if(!this.active?.manual&&this.goal().reached)throw Error('Daily chapter goal reached; use an explicit Read now request to read another passage.');
    const cap=readingLimits(this.cfg).taskCap;
    if(!this.active?.manual&&cap>0&&this.ledger.tasks>=cap)throw Error('Daily reading task cap reached. An explicit Read now request can add one passage; you cannot raise the user\'s configured limit.');
  }
  /** Reserve before exposing text. Disk failure cannot return an uncharged range. */
  read(id: unknown, requested?: unknown) {
    if(id!==undefined&&id===this.completedOpportunity?.id)throw Error('Only one segment batch is allowed per opportunity');
    this.authorize(id);
    const a = id !== undefined ? this.requireOpportunity(id) : undefined;
    const limits=readingLimits(this.cfg);
    // A repeated call inside the same lease returns the already supplied batch
    // unchanged; it must not extend the run after text was exposed.
    const count = a?.taskIds?.length ?? (Number.isSafeInteger(requested) ? Math.max(1, Math.min(limits.batch, requested as number)) : limits.batch);
    const result = this.lib.readNext(count);
    if (!result.complete) {
      for (const item of result.segments) {
        const size = item.segment.end - item.segment.start;
        if (!this.ledger.reservations[item.taskId]) this.save({ ...this.ledger, tasks: this.ledger.tasks + 1, chars: this.ledger.chars + size,
          reservations: { ...this.ledger.reservations, [item.taskId]: size } });
      }
      if (a){a.taskIds=result.segments.map(item=>item.taskId);a.segmentIds=result.segments.map(item=>item.segmentId);a.taskId=result.taskId;a.batchChars=result.batch.chars;a.readRate??=limits.charsPerMinute;}
      if(a?.manual&&this.manual?.id===a.id)this.manual.state='reading';
    }
    return result;
  }
  /** Give a repeated malformed confirmation a bounded, self-correcting path instead of a retry storm. */
  private noteFailure(taskId: string, error: unknown): void {
    if (!taskId) return;
    const count = (this.failures.get(taskId) ?? 0) + 1;
    this.failures.set(taskId, count);
    if (this.failures.size > 200) { const first = this.failures.keys().next().value; if (first) this.failures.delete(first); }
    if (count >= 2 && error instanceof Error) throw new Error(`${error.message}. This exact range already failed twice: confirm it with taskId, segmentId and an empty understanding, no episode; record any reflection separately with bookfish_record_reflection.`);
  }
  finish(args: Record<string, unknown>) {
    if (this.signature() !== this.observed) this.changed();
    const done=this.completedOpportunity;if(args.opportunityId!==undefined&&done&&args.opportunityId===done.id){if(done.generation!==this.lib.generation()||this.now()>=done.expires||done.taskId!==args.taskId)throw Error('Completed reading opportunity is stale');return this.lib.finish(args);}
    this.requireAwake();
    let opportunity: Opportunity | undefined;
    if (args.opportunityId !== undefined || this.cfg.automaticReading || this.active?.taskId === args.taskId || this.active?.taskIds?.includes(String(args.taskId))) {
      const a = this.requireOpportunity(args.opportunityId);
      opportunity = a;
      if (a.taskIds ? !a.taskIds.includes(String(args.taskId)) : a.taskId !== args.taskId) throw new Error(`Task does not belong to this opportunity; use the taskId from this opportunity's read_next (${(a.taskIds ?? [a.taskId]).join(', ')})`);
    }
    if (opportunity?.segmentIds && !opportunity.segmentIds.includes(Number(args.segmentId))) {
      throw new Error(`segmentId ${String(args.segmentId)} was not supplied by this opportunity; read_next returned segmentIds ${opportunity.segmentIds.join(', ')}. Use the exact segmentId from that result, not a guessed one.`);
    }
    const ms=this.lib.segmentSize(args.bookKey,args.segmentId)/(this.active?.readRate??readingLimits(this.cfg).charsPerMinute)*60000;
    const accrued=this.sessionReadMs+ms;const rest=accrued>=readingLimits(this.cfg).sessionMinutes*60000?this.lib.planRest(this.restDuration(accrued),accrued,'session'):undefined;
    let result;
    try { result = this.lib.finish(args,rest); this.failures.delete(String(args.taskId)); }
    catch (error) { this.noteFailure(String(args.taskId ?? ''), error); throw error; }
    if(this.active)this.active.finished=true;
    if(!result.duplicate)this.sessionReadMs=rest?0:accrued;
    if(this.active?.manual&&this.manual?.id===this.active.id&&!this.active.taskIds?.some(id=>!this.lib.isCommitted(id))){this.manual.state='completed';this.manual.at=this.now();}
    // A multi-segment batch may be confirmed one segment per call inside the same
    // opportunity: keep it alive until every supplied task is committed.
    if(this.active){
      const remaining=(this.active.taskIds??[]).filter(id=>!this.lib.isCommitted(id));
      if(remaining.length){this.active.taskIds=remaining;this.active.taskId=remaining[0];this.reason='awaiting_model';}
      else{this.completedOpportunity={...this.active};this.active=undefined;this.turnEnded=false;
        if(args.opportunityId!==undefined){this.reason='waiting';this.resetPace();}}
    }
    return result;
  }
  /**
   * Confirm an ordered run of segments in one call. Only the reliably processed
   * contiguous prefix advances; the remainder stays unread. A replay after
   * completion returns the original receipts instead of counting twice.
   */
  finishBatch(opportunityId: unknown, rawSegments: unknown, batchEpisode?: unknown) {
    if (!Array.isArray(rawSegments) || rawSegments.length < 1 || rawSegments.length > 4) throw new Error('segments must contain 1–4 confirmations in reading order');
    const items = rawSegments.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each confirmation must be an object');
      return item as Record<string, unknown>;
    });
    const episodeOptions = batchEpisode === undefined ? undefined : { episode: batchEpisode };
    if (this.signature() !== this.observed) this.changed();
    const ids = items.map(item => String(item.taskId ?? ''));
    const done = this.completedOpportunity;
    // Replay after completion is idempotent only when every range is already
    // committed; a partially failed batch still needs a live opportunity, so an
    // opportunity that ended can never confirm its leftover pending slots.
    if (done?.taskIds && ids.every(id => done.taskIds!.includes(id) && this.lib.isCommitted(id))) return this.lib.finishMany(items, undefined, episodeOptions);
    this.requireAwake();
    const a = this.requireOpportunity(opportunityId);
    if (a.taskIds ? ids.some(id => !a.taskIds!.includes(id)) : ids.some(id => id !== a.taskId)) throw new Error(`Task does not belong to this opportunity; use the taskId from this opportunity's read_next (${(a.taskIds ?? [a.taskId]).join(', ')})`);
    if (a.segmentIds) {
      const invalid = items.find(item => !a.segmentIds!.includes(Number(item.segmentId)));
      if (invalid) throw new Error(`segmentId ${String(invalid.segmentId)} was not supplied by this opportunity; read_next returned segmentIds ${a.segmentIds.join(', ')}. Use the exact segmentIds from that result, not guessed ones.`);
    }
    const key = this.lib.status().current?.key;
    let chars = 0;
    for (const item of items) chars += this.lib.segmentSize(item.bookKey ?? key, item.segmentId);
    const ms = chars / (a.readRate ?? readingLimits(this.cfg).charsPerMinute) * 60000;
    const accrued = this.sessionReadMs + ms;
    const rest = accrued >= readingLimits(this.cfg).sessionMinutes * 60000 ? this.lib.planRest(this.restDuration(accrued), accrued, 'session') : undefined;
    const result = this.lib.finishMany(items, rest, episodeOptions);
    if (result.confirmed > 0) {
      a.finished = true;
      this.sessionReadMs = rest ? 0 : accrued;
      if (a.manual && this.manual?.id === a.id) { this.manual.state = result.stoppedAt ? 'failed' : 'completed'; this.manual.at = this.now();
        if (result.stoppedAt) this.manual.message = `已确认 ${result.confirmed} 段，其余段落失败：${result.stoppedAt.error}`; }
      this.completedOpportunity = { ...a }; this.active = undefined; this.turnEnded = false; this.reason = 'waiting'; this.resetPace();
    }
    return result;
  }
  defer(id: unknown, minutes: unknown) {
    this.requireOpportunity(id);
    if (!Number.isSafeInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 1440) throw new Error('Rest must be 5–1440 whole minutes');
    const duration=this.sessionReadMs?this.restDuration(this.sessionReadMs):0;
    if(duration){this.lib.endRest('skipped');this.lib.recordRest(this.lib.planRest(duration,this.sessionReadMs,'model'));}
    this.sessionReadMs=0;
    if(this.active?.manual&&this.manual){this.manual.state='deferred';this.manual.message='大肥鱼这次选择先休息，稍后可再次请求。';}
    this.cancel(); this.reason = duration?'resting':'waiting'; return {restUntil:this.restUntil(),requestedMinutes:minutes,scheduledMs:duration};
  }
  resume() { this.lib.endRest('skipped');this.changed(); return this.status(); }
}
