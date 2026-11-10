import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEnvelope, RunPhase, WorldHost } from 'cortico/core/types.ts';
import { BOOKFISH_DEFAULTS, sharingLimits } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingSharing } from '../src/sharing.ts';
import { FakeHost } from './helpers/fake-host.ts';
let dir: string, time: number, lib: Library, sharing: ReadingSharing, cfg: typeof BOOKFISH_DEFAULTS, host: FakeHost, episodeId: string;
type Deferred = Parameters<WorldHost['pushDeferred']>[0]; let queued: Deferred[];
function phase(state: RunPhase['state']) { sharing.onRunPhase({ state, running: [], enteredAt: new Date(time).toISOString() }); }
function advance(ms = 30000) { time += ms; sharing.tick(); }
function proposal(text = '这句让我想到热闹里也会有远虑。', id = episodeId) { return sharing.propose({ episodeId: id, text }).item; }
async function deliver() {
  const event = [...queued].reverse().find(e => e.type === 'bookfish.share_opportunity')!; expect(await event.render()).not.toBeNull();
  sharing.onEventsSettled([{ type: event.type, meta: event.meta } as EventEnvelope], 'delivered'); return event.meta!.shareId;
}
function moreEpisode() { return lib.reflect({ bookKey: lib.status().current!.key, requestId: `more-${time}`, episode: { trigger: '风', interpretation: '另一条合成看法', evidence: [{ segmentId: 0, quote: '海风。', start: 0 }] } }).episode.id; }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-shares-')); time = Date.parse('2026-11-07T02:00:00Z');
  cfg = { ...BOOKFISH_DEFAULTS, automaticSharing: true }; lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  const b = lib.import({ filename: 'sample.txt', title: '合成样本', base64: Buffer.from('海风。'.repeat(500)).toString('base64') }).book; lib.select(b.key);
  const t = lib.readNext(); if (t.complete) throw new Error('fixture');
  episodeId = lib.finish({ ...t, understanding: '海风', episode: { trigger: '海风', interpretation: '合成感想', reason: '测试注释', evidence: [{ segmentId: 0, quote: '海风。', start: 0 }] } }).receipt.episodeId!;
  host = new FakeHost(); queued = []; host.pushDeferred = (e, o) => { expect(o?.trigger).toBe('flush'); queued.push(e); };
  sharing = new ReadingSharing(lib, cfg, 'Asia/Shanghai', () => time); sharing.start(host); phase('idle');
});
afterEach(() => { sharing.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });
describe('optional bounded sharing, never a fabricated display receipt', () => {
  it('enforces sentence limits before nomination and again before claiming or output', async () => {
    cfg.shareMaxSentenceChars = 10;
    expect(() => proposal('鱼'.repeat(11))).toThrow(/sentence/);
    cfg.shareMaxSentenceChars = 30; const item=proposal('鱼'.repeat(20)); advance(); await deliver();
    cfg.shareMaxSentenceChars = 10; expect(() => sharing.claim({shareId:item.id})).toThrow(/unavailable/);
    cfg.shareMaxSentenceChars = 30; sharing.claim({shareId:item.id}); expect(sharing.status().outputPermit?.allowed).toBe(true);
    cfg.shareMaxSentenceChars = 10; expect(sharing.status().outputPermit?.allowed).toBe(false);
  });
  it('honors minute-precision quiet boundaries across midnight', () => {
    cfg.shareQuietStartMinute=1410;cfg.shareQuietEndMinute=450;
    time=Date.parse('2026-11-07T15:29:00Z');expect(sharing.status().quiet).toBe(false);
    time=Date.parse('2026-11-07T15:30:00Z');expect(sharing.status().quiet).toBe(true);
    time=Date.parse('2026-11-07T23:29:00Z');expect(sharing.status().quiet).toBe(true);
    time=Date.parse('2026-11-07T23:30:00Z');expect(sharing.status().quiet).toBe(false);
  });
  it('proposes without output or progress and never claims before event delivery', async () => {
    const before = lib.export(), item = proposal(); expect(queued).toHaveLength(0); expect(lib.export()).toBe(before);
    expect(() => sharing.claim({ shareId: item.id })).toThrow(/unavailable/); advance();
    expect(() => sharing.claim({ shareId: item.id })).toThrow(/unavailable/);
    const id = await deliver(); const permit = sharing.claim({ shareId: id });
    expect(permit).toMatchObject({ text: item.text, outputTool: 'pet_say', displayConfirmed: false });
    expect(sharing.status().outputPermit?.allowed).toBe(true); expect(sharing.status().budget.attempts).toBe(1);
    expect(() => sharing.claim({ shareId: id })).toThrow(); expect(lib.export()).toBe(before);
  });
  it('is opt-in, respects pause and does not awaken during quiet hours', () => {
    proposal(); cfg.automaticSharing = false; advance(); expect(queued).toHaveLength(0);
    cfg.automaticSharing = true; lib.setPaused(true); advance(); expect(queued).toHaveLength(0);
    lib.setPaused(false); time = Date.parse('2026-11-07T14:00:00Z'); advance(); expect(sharing.status().quiet).toBe(true); expect(queued).toHaveLength(0);
  });
  it('handles same-day and all-day quiet windows and safe defaults', () => {
    cfg.shareQuietStart = 9; cfg.shareQuietEnd = 11; expect(sharing.status().quiet).toBe(true);
    cfg.shareQuietStart = 10; cfg.shareQuietEnd = 10; expect(sharing.status().quiet).toBe(true);
    cfg.shareQuietEnabled = false; expect(sharing.status().quiet).toBe(false);
    expect(sharingLimits({ ...cfg, shareCooldownMinutes: -1 })).toMatchObject({ cooldownMs: 3600000 });
  });
  it('waits while busy and for 30 seconds idle; deferred expiry never accumulates a replay', async () => {
    proposal(); phase('tools'); advance(); expect(queued).toHaveLength(0); phase('idle'); advance(29999); expect(queued).toHaveLength(0); advance(1);
    const event = queued[0]; advance(60000); expect(await event.render()).toBeNull(); advance(3600000); expect(queued).toHaveLength(1);
    expect(sharing.status().items[0].state).toBe('dropped');
  });
  it('cannot claim when quiet starts, settings change or the book generation changes', async () => {
    const item = proposal(); advance(); await deliver(); cfg.shareQuietStart = 10; cfg.shareQuietEnd = 11;
    expect(() => sharing.claim({ shareId: item.id })).toThrow(); cfg.shareQuietEnabled = false;
    lib.setPaused(true); expect(() => sharing.claim({ shareId: item.id })).toThrow(); lib.setPaused(false);
    expect(() => sharing.claim({ shareId: item.id })).toThrow();
  });
  it('invalidates an output permit when disabled, quiet, paused or expired', async () => {
    const item = proposal(); advance(); await deliver(); sharing.claim({ shareId: item.id });
    cfg.automaticSharing = false; expect(sharing.status().outputPermit?.allowed).toBe(false); cfg.automaticSharing = true;
    cfg.shareQuietStart = 10; cfg.shareQuietEnd = 11; expect(sharing.status().outputPermit?.allowed).toBe(false); cfg.shareQuietEnabled = false;
    advance(15000); expect(sharing.status().outputPermit?.allowed).toBe(false);
  });
  it('deduplicates episode/text, retains only the newest waiting candidate and refuses missing episodes', () => {
    const one = proposal(); expect(proposal().id).toBe(one.id); expect(() => proposal('别的内容')).toThrow();
    const id = moreEpisode(); expect(() => proposal(one.text, id)).toThrow(/Already/); proposal('另一条分享', id);
    expect(sharing.status().items.filter(i => i.state === 'candidate')).toHaveLength(1);
    expect(() => proposal('未知', 'missing')).toThrow();
  });
  it('counts failure/unknown once, enforces cooldown, and never retries an unavailable output', async () => {
    const item = proposal(); advance(); await deliver(); const permit = sharing.claim({ shareId: item.id });
    const args = { ...permit, outcome: 'unavailable', receipt: 'pet_say unavailable' };
    sharing.report(args); sharing.report(args); expect(sharing.status().budget.attempts).toBe(1);
    expect(() => sharing.report({ ...args, outcome: 'accepted' })).toThrow();
    proposal('新的候选', moreEpisode()); advance(); expect(sharing.status().reason).toBe('cooldown'); expect(queued).toHaveLength(1);
  });
  it('persists attempt auditing and cooldown through restart and clearing history without a daily cap', async () => {
    const item = proposal(); advance(); await deliver(); sharing.claim({ shareId: item.id });
    sharing.stop(); sharing.start(host); expect(sharing.status().items[0].state).toBe('unknown');
    expect(sharing.status().budget.attempts).toBe(1); sharing.clearHistory(); expect(() => proposal()).toThrow(/Already/);
    proposal('另一个候选', moreEpisode()); advance(); expect(sharing.status().reason).toBe('cooldown');
    time += 86400000; sharing.tick(); expect(sharing.status().budget.attempts).toBe(0); expect(sharing.status().items[0].state).toBe('dropped');
    time -= 86400000; sharing.tick(); expect(sharing.status().budget.day).toBe('2026-11-08');
  });
  it('does not impose a daily attempt cap; cooldown remains the only frequency limit', async () => {
    for (let i = 0; i < 4; i++) {
      const episode = i === 0 ? episodeId : moreEpisode();
      const item = proposal(`第 ${i + 1} 条分享候选，只用于无上限验证。`, episode);
      advance(3_600_001);
      await deliver();
      const permit = sharing.claim({ shareId: item.id });
      sharing.report({ ...permit, outcome: 'accepted', receipt: 'Synthetic transport receipt, not real display' });
    }
    expect(sharing.status().budget.attempts).toBe(4);
  });
  it('requires a receipt for acceptance, separates user visibility, and preserves unknown on timeout', async () => {
    const item = proposal(); advance(); await deliver(); const p = sharing.claim({ shareId: item.id });
    expect(() => sharing.report({ ...p, outcome: 'accepted' })).toThrow();
    advance(60001); expect(sharing.status().items[0].state).toBe('unknown');
    sharing.report({ ...p, outcome: 'accepted', receipt: 'Synthetic transport receipt, not real display' });
    expect(sharing.status().items[0].visibleAt).toBeUndefined(); sharing.visible(item.id); expect(sharing.status().items[0].visibleAt).toBe(time);
  });
  it('drops a declined or discarded opportunity and keeps the original journal', async () => {
    const item = proposal(); advance(); const event = queued[0];
    sharing.onEventsSettled([{ type: event.type, meta: event.meta } as EventEnvelope], 'discarded');
    expect(sharing.status().items[0].state).toBe('dropped'); expect(lib.episode(episodeId).episode.id).toBe(episodeId);
    expect(() => sharing.claim({ shareId: item.id })).toThrow();
  });
  it('drops an unclaimed opportunity after a delivered turn, with no later replay', async () => {
    proposal(); advance(); await deliver(); sharing.onTurnEnded(); advance(3600000);
    expect(sharing.status().items[0].state).toBe('dropped'); expect(queued).toHaveLength(1);
  });
  it('purges share text when its episode is deleted without resetting budget or hashed dedupe', () => {
    proposal(); lib.clear(); expect(sharing.status().items).toEqual([]); expect(sharing.status().total).toBe(0);
  });
  it('rejects a corrupt ledger without replacing it', () => {
    proposal(); sharing.stop(); const file = join(lib.dir, 'sharing.json'); writeFileSync(file, '{bad');
    expect(() => sharing.start(host)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('{bad');
  });
  it('does not reserve an attempt when atomic persistence fails', async () => {
    const item = proposal(); advance(); await deliver();
    const file = join(lib.dir, 'sharing.json'); const saved = readFileSync(file);
    unlinkSync(file); mkdirSync(file);
    expect(() => sharing.claim({ shareId: item.id })).toThrow();
    expect(sharing.status().budget.attempts).toBe(0); expect(sharing.status().items[0].state).toBe('candidate');
    rmSync(file, { recursive: true }); writeFileSync(file, saved);
  });
  it('pages the model-facing share history and bounds each item', () => {
    const first = proposal('第一条分享候选，只用于分页测试。');
    const secondEpisode = moreEpisode();
    proposal('第二条分享候选，用于验证分页游标。', secondEpisode);
    const page1 = sharing.page(1);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(page1.items[0]!.id);
    expect(page1.items[0]!.text.length).toBeLessThanOrEqual(300);
    const page2 = sharing.page(1, page1.nextCursor);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(page1.total).toBeGreaterThanOrEqual(2);
    expect(first.id).toBeTruthy();
    expect(JSON.stringify(page1).length).toBeLessThan(4_000);
  });
  it('keeps the frequent status summary compact and leaves share text to the dedicated tool', () => {
    const item = proposal('海风把远虑吹近了一点，我想起家里那扇窗。');
    const full = sharing.status();
    const summary = sharing.summary();
    expect(full.items[0]!.text).toContain('海风');
    expect(summary).not.toHaveProperty('items');
    expect(summary.candidate?.id).toBe(item.id);
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });
});
