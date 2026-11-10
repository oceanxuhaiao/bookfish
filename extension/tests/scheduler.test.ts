import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, RunPhase, WorldHost } from 'cortico/core/types.ts';
import { BOOKFISH_DEFAULTS, readingLimits } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dir: string, time: number, lib: Library, cfg: typeof BOOKFISH_DEFAULTS, host: FakeHost;
let scheduler: ReadingScheduler;
type Deferred = Parameters<WorldHost['pushDeferred']>[0];
let queued: Deferred[];
function phase(state: RunPhase['state']) { scheduler.onRunPhase({ state, running: [], enteredAt: new Date(time).toISOString() }); }
async function advance(ms = 180000) { while(ms>0){const step=Math.min(ms,5000);time+=step;ms-=step;await scheduler.tick();} }
function active() { return scheduler.status().active!.opportunityId; }
function finish(id: string, task: ReturnType<ReadingScheduler['read']>) {
  if (task.complete) throw new Error('Expected an unread segment');
  return scheduler.finish({ opportunityId: id, taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '这是合成测试段落，不是真实模型阅读。' });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-scheduler-')); time = Date.parse('2026-11-07T02:00:00Z');
  cfg = { ...BOOKFISH_DEFAULTS,realRoutineEnabled:false, automaticReading: true };
  lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  const imported = lib.import({ filename: 'sample.txt', title: '合成样本', base64: Buffer.from('海边有鱼。'.repeat(1000)).toString('base64') });
  lib.select(imported.book.key); host = new FakeHost(); queued = [];
  host.pushDeferred = (event, opts) => { expect(opts?.trigger).toBe('flush'); queued.push(event); };
  scheduler = new ReadingScheduler(lib, cfg, 'Asia/Shanghai', () => time); scheduler.start(host); phase('idle');
});
afterEach(() => { scheduler.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('reading opportunities, never timer-based progress', () => {
  it('waits one interval, deduplicates ticks and requires a supplied range plus confirmation', async () => {
    await advance(179999); expect(queued).toHaveLength(0);
    await advance(1); const id = active(); expect(queued).toHaveLength(1);
    expect(await queued[0].render()).toContain(id);
    await scheduler.tick(); expect(queued).toHaveLength(1); expect(lib.status().current!.confirmedSegments).toBe(0);
    expect(() => scheduler.read(undefined)).toThrow(/opportunity/);
    const task = scheduler.read(id); expect(lib.status().current!.confirmedSegments).toBe(0);
    expect(scheduler.read(id)).toEqual(task); expect(scheduler.status().budget).toMatchObject({ tasks: 1, chars: 1200 });
    expect(finish(id, task).duplicate).toBe(false); expect(finish(id, task).duplicate).toBe(true);
    expect(() => scheduler.read(id)).toThrow(/one segment/); expect(lib.status().current!.confirmedSegments).toBe(1);
  });
  it('does not queue during chatting, backoff or handoff and requires 30 seconds idle', async () => {
    for (const state of ['model', 'tools', 'backoff', 'handoff'] as const) { phase(state); await advance(); expect(queued).toHaveLength(0); }
    phase('idle'); await advance(29999); expect(queued).toHaveLength(0); await advance(150001); expect(queued).toHaveLength(1);
  });
  it('waits for an actual host idle observation after mount', async () => {
    scheduler.stop(); scheduler.start(host); await advance(3600000); expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe('bookfish.scheduler_probe'); expect(scheduler.status().active).toBeNull();
    await advance(); expect(queued).toHaveLength(1);
    phase('idle'); await advance(); expect(queued).toHaveLength(2);
  });
  it('expires queued events at delivery instead of accumulating or confirming offline work', async () => {
    await advance(); const event = queued[0]; const id = active();
    await advance(10 * 60000); expect(await event.render()).toBeNull(); expect(() => scheduler.read(id)).toThrow(/stale/);
    expect(lib.status().current!.confirmedSegments).toBe(0);
    time += 24 * 3600000; await scheduler.tick(); expect(queued).toHaveLength(1); // suspended time buys no reading
    await advance(); expect(queued).toHaveLength(2);
  });
  it('invalidates supplied work on pause, switch, disabling and stop', async () => {
    await advance(); const id = active(), task = scheduler.read(id);
    lib.setPaused(true); expect(() => finish(id, task)).toThrow(/stale/); await scheduler.tick();
    lib.setPaused(false); scheduler.changed(); await advance(); const second = active(), task2 = scheduler.read(second);
    cfg.automaticReading = false; expect(() => finish(second, task2)).toThrow(/stale/); await scheduler.tick();
    expect(await queued[1].render()).toBeNull();
    cfg.automaticReading = true; scheduler.changed(); await advance(); const third = active(), task3 = scheduler.read(third);
    const other = lib.import({ filename: 'other.txt', title: '另一本', base64: Buffer.from('别的故事').toString('base64') }); lib.select(other.book.key);
    expect(() => finish(third, task3)).toThrow(/stale/); scheduler.changed(); await advance(); const fourth = active();
    scheduler.stop(); expect(() => scheduler.read(fourth)).toThrow(); expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('does not invent reading time or a long rest when the model declines before reading',async()=>{
    await advance();const id=active();expect(()=>scheduler.defer(id,0)).toThrow(/5/);const result=scheduler.defer(id,60);expect(result.scheduledMs).toBe(0);expect(lib.timeline().rests).toEqual([]);await advance();expect(queued).toHaveLength(2);expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('settles a delivered or discarded main opportunity without immediately generating another', async () => {
    await advance(); const id = active();
    scheduler.onEventsSettled([{ cursor: 1, ts: '', source: 'bookfish', origin: 'internal', text: '', type: 'bookfish.reading_opportunity', meta: { opportunityId: id } } as EventEnvelope], 'delivered');
    phase('model'); const task = scheduler.read(id); finish(id, task); scheduler.onTurnEnded(); phase('idle'); await scheduler.tick();
    expect(scheduler.status().active).toBeNull(); expect(queued).toHaveLength(1);
    await advance(); const id2 = active();
    scheduler.onEventsSettled([{ cursor: 2, ts: '', source: 'bookfish', origin: 'internal', text: '', type: 'bookfish.reading_opportunity', meta: { opportunityId: id2 } } as EventEnvelope], 'discarded');
    await scheduler.tick(); expect(scheduler.status().active).toBeNull();
  });
});

describe('retired daily caps retain audit accounting', () => {
  it('keeps audit counts across restart without enforcing retired task limits', async () => {
    cfg.automaticReading = false; cfg.dailyTasks = 1;
    const task = scheduler.read(undefined); expect(scheduler.read(undefined)).toEqual(task);
    scheduler.stop(); lib.close(); lib.open(); scheduler.start(host);
    expect(scheduler.read(undefined).complete).toBe(false); expect(scheduler.status().budget.tasks).toBe(2);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('ignores legacy character caps while preserving confirmed-progress semantics', async () => {
    cfg.dailyChars = 1199; cfg.automaticReading = false;
    expect(scheduler.read(undefined).complete).toBe(false); expect(lib.status().providedChars).toBe(1200);expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('rolls budgets at deployment midnight without resetting progress, never on a backward clock', async () => {
    cfg.automaticReading = false; cfg.dailyTasks = 1; scheduler.read(undefined);
    time = Date.parse('2026-11-07T16:00:01Z'); lib.cancelPending(); await scheduler.tick();
    expect(scheduler.status().budget).toMatchObject({ tasks: 0, day: '2026-11-08' }); scheduler.read(undefined);
    time = Date.parse('2026-11-07T15:00:00Z'); lib.cancelPending(); await scheduler.tick();
    expect(scheduler.read(undefined).complete).toBe(false);expect(scheduler.status().budget.day).toBe('2026-11-08');
  });
  it('does not reinstate retired caps when old configuration is lowered', async () => {
    cfg.automaticReading = false; const task = scheduler.read(undefined);
    if (task.complete) throw new Error('Missing task');
    scheduler.finish({ ...task, understanding: '合成理解' }); cfg.dailyChars = 1201;
    expect(scheduler.read(undefined).complete).toBe(false); expect(cfg.dailyChars).toBe(1201);
  });
  it('rejects an automatic task after hot disabling even when a caller drops its opportunity id', async () => {
    await advance(); const task = scheduler.read(active()); if (task.complete) throw new Error('Missing task');
    cfg.automaticReading = false;
    expect(() => scheduler.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '旧任务' })).toThrow(/cancelled/);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('does not erase accounting when the library is cleared or a backup restored', async () => {
    const backup = lib.export(); cfg.automaticReading = false; scheduler.read(undefined);
    lib.clear(); lib.restore(backup); expect(scheduler.status().budget.tasks).toBe(1);
  });
  it('fails closed on corrupt budget storage without resetting it', () => {
    scheduler.stop(); writeFileSync(join(lib.dir, 'reading-budget.json'), '{"schema":1,"day":"wrong"}');
    expect(() => scheduler.start(host)).toThrow(/corrupt/);
  });
  it('does not return novel text when the budget reservation cannot be persisted', () => {
    cfg.automaticReading = false;
    const budgetFile = join(lib.dir, 'reading-budget.json'); unlinkSync(budgetFile); mkdirSync(budgetFile);
    expect(() => scheduler.read(undefined)).toThrow();
    expect(lib.status().current!.confirmedSegments).toBe(0); expect(scheduler.status().budget.tasks).toBe(0);
    // The unreturned library lease can be retried after the storage failure is repaired.
    rmdirSync(budgetFile);
    const task = scheduler.read(undefined); expect(task.complete).toBe(false); expect(scheduler.status().budget.tasks).toBe(1);
  });
  it('uses bounded speed preferences and safe fallback for invalid configuration', () => {
    expect(readingLimits({ ...cfg, speed: 'slow' }).intervalMs).toBe(360000);
    expect(readingLimits({ ...cfg, speed: 'fast' }).intervalMs).toBe(120000);
    expect(readingLimits({ ...cfg, dailyTasks: -1, dailyChars: NaN })).toMatchObject({ tasks: null, chars: null,chapterGoal:0,sessionMinutes:10 });
  });
});

describe('Persona cognition capability and late results', () => {
  it('requests only this World tools and does not equate generated text with confirmed reading', async () => {
    const request = vi.fn(async (_req: Parameters<NonNullable<WorldHost['cognition']>['request']>[0]) => ({ text: 'I read everything' }));
    Object.defineProperty(host, 'cognition', { value: { request } });
    await advance(); await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledOnce(); expect(queued).toHaveLength(0);
    expect(request.mock.calls[0][0]).toMatchObject({ tools: ['bookfish_get_status', 'bookfish_read_next', 'bookfish_finish_reading', 'bookfish_defer_reading', 'bookfish_lookup', 'bookfish_share'] });
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('allows the model tool protocol to advance exactly one supplied segment', async () => {
    Object.defineProperty(host, 'cognition', { value: { request: async () => { const id = active(); finish(id, scheduler.read(id)); return { text: 'done' }; } } });
    await advance(); await Promise.resolve(); await Promise.resolve();
    expect(lib.status().current!.confirmedSegments).toBe(1); expect(scheduler.status().budget.tasks).toBe(1);
  });
  it('rejects late background confirmations as soon as the main session becomes busy and does not run overlapping requests', async () => {
    let resolve!: (value: { text: string }) => void;
    const request = vi.fn(() => new Promise<{ text: string }>(r => { resolve = r; }));
    Object.defineProperty(host, 'cognition', { value: { request } }); await advance();
    const id = active(), task = scheduler.read(id); phase('model'); expect(() => finish(id, task)).toThrow(/priority/);
    await scheduler.tick(); phase('idle'); await advance(3600000); expect(request).toHaveBeenCalledOnce();
    expect(lib.status().current!.confirmedSegments).toBe(0);
    resolve({ text: 'late' }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  it('reports cognition errors with backoff rather than producing a wake storm', async () => {
    const request = vi.fn(async () => ({ error: 'Persona refused' })); Object.defineProperty(host, 'cognition', { value: { request } });
    await advance(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scheduler.status().error).toBe('Persona refused'); await advance(10000); expect(request).toHaveBeenCalledOnce();
  });
  it('forces main-session mode when configured even if cognition exists', async () => {
    cfg.readingMode = 'main'; scheduler.changed(); const request = vi.fn(); Object.defineProperty(host, 'cognition', { value: { request } });
    await advance(); expect(request).not.toHaveBeenCalled(); expect(queued).toHaveLength(1);
  });
});


describe('character-paced idle reading', () => {
  it('preserves earned pacing across a speed change and never advances progress by time', async () => {
    await advance(60000); expect(scheduler.status().pacedChars).toBe(400);
    cfg.readingCharsPerMinute=800; await scheduler.tick();
    await advance(59999); expect(queued).toHaveLength(0); await advance(1);
    expect(queued).toHaveLength(1); expect(lib.status().current!.confirmedSegments).toBe(0);
  });
  it('slows only the remaining range, not already earned pacing', async () => {
    await advance(60000); cfg.readingCharsPerMinute=200; await scheduler.tick();
    await advance(239999); expect(queued).toHaveLength(0); await advance(1); expect(queued).toHaveLength(1);
  });
  it('does not cancel an already supplied task merely because speed changed', async () => {
    await advance(); const id=active(),task=scheduler.read(id);
    cfg.readingCharsPerMinute=100; await scheduler.tick();
    expect(finish(id,task).duplicate).toBe(false);expect(lib.status().current!.confirmedSegments).toBe(1);
  });
  it('counts actual short-segment length and still requires idle observation', async () => {
    const book=lib.import({filename:'short.txt',title:'短段',base64:Buffer.from('鱼'.repeat(400)).toString('base64')});
    lib.select(book.book.key);scheduler.changed();await advance(59999);expect(queued).toHaveLength(0);
    await advance(1);expect(queued).toHaveLength(1);
  });
  it('does not count model/chat time or timer gaps as reading', async () => {
    await advance(60000);phase('model');await advance(600000);phase('idle');
    time+=3600000;await scheduler.tick();expect(scheduler.status().pacedChars).toBe(400);
    await advance(119999);expect(queued).toHaveLength(0);await advance(1);expect(queued).toHaveLength(1);
  });
  it('does not restore partial pacing across a restart', async () => {
    await advance(60000);scheduler.stop();time+=3600000;scheduler.start(host);phase('idle');
    await advance(120000);expect(queued).toHaveLength(0);await advance(60000);expect(queued).toHaveLength(1);
  });
  it('bounds custom rates and falls back to legacy preset selection', () => {
    for(const readingCharsPerMinute of [0,99,1201,NaN,Infinity,1.5])expect(readingLimits({...cfg,speed:'slow',readingCharsPerMinute}).charsPerMinute).toBe(200);
    expect(readingLimits({...cfg,readingCharsPerMinute:550}).charsPerMinute).toBe(550);
  });
});

describe('explicit Read now requests',()=>{
 it('bypasses automatic pacing while off, deduplicates clicks, and never advances without confirmation',async()=>{
  cfg.automaticReading=false;phase('model');const key=lib.status().current!.key;const first=await scheduler.requestNow(key);expect(host.events).toHaveLength(1);expect(host.events[0].meta).toMatchObject({manual:true});expect((await scheduler.requestNow(key)).duplicate).toBe(true);expect(host.events).toHaveLength(1);expect(lib.status().current!.confirmedSegments).toBe(0);await scheduler.tick();expect(scheduler.status().manual?.state).toBe('queued');expect(()=>scheduler.read(undefined)).toThrow(/opportunity/);const task=scheduler.read(first.opportunityId);expect(scheduler.status().manual?.state).toBe('reading');expect(lib.status().current!.confirmedSegments).toBe(0);finish(first.opportunityId,task);expect(scheduler.status().manual?.state).toBe('completed');expect(lib.status().current!.confirmedSegments).toBe(1);expect(cfg.automaticReading).toBe(false);expect(()=>scheduler.read(first.opportunityId)).toThrow(/one segment/);
 });
 it('resumes a paused book on an explicit request without changing the automatic switch',async()=>{
  cfg.automaticReading=false;lib.setPaused(true);const r=await scheduler.requestNow(lib.status().current!.key);expect(lib.status().paused).toBe(false);expect(cfg.automaticReading).toBe(false);expect(scheduler.read(r.opportunityId).complete).toBe(false);
 });
 it('allows a single requested passage during rest without clearing the rest period',async()=>{
  await advance();scheduler.defer(active(),30);const rest=scheduler.status().restUntil;const r=await scheduler.requestNow(lib.status().current!.key);expect(scheduler.status().restUntil).toBe(rest);expect(scheduler.read(r.opportunityId).complete).toBe(false);
 });
 it('rejects stale book keys but ignores retired caps for explicit reads',async()=>{
  lib.setPaused(true);await expect(scheduler.requestNow('not-selected')).rejects.toThrow(/改变/);cfg.dailyChars=1;await expect(scheduler.requestNow(lib.status().current!.key)).resolves.toMatchObject({accepted:true});expect(host.events).toHaveLength(1);expect(lib.status().paused).toBe(false);
 });
 it('keeps the original paused state and exposes failure when event persistence fails',async()=>{
  lib.setPaused(true);host.pushEvent=vi.fn().mockRejectedValue(Error('disk unavailable'));await expect(scheduler.requestNow(lib.status().current!.key)).rejects.toThrow(/disk/);expect(lib.status().paused).toBe(true);expect(scheduler.status().manual?.state).toBe('failed');expect(lib.status().current!.confirmedSegments).toBe(0);
 });
 it('rejects late work after pause or expiry and reports requests that end without confirmation',async()=>{
  const first=await scheduler.requestNow(lib.status().current!.key);scheduler.onEventsSettled(host.events,'delivered');scheduler.onTurnEnded();expect(scheduler.status().manual?.state).toBe('failed');expect(()=>scheduler.read(first.opportunityId)).toThrow(/stale/);await scheduler.tick();const second=await scheduler.requestNow(lib.status().current!.key);time+=10*60000;await scheduler.tick();expect(scheduler.status().manual?.state).toBe('expired');expect(()=>scheduler.read(second.opportunityId)).toThrow(/stale/);expect(lib.status().current!.confirmedSegments).toBe(0);
 });
});
