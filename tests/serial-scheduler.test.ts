import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { SerialSync } from '../src/serial-sync.ts';
import { SerialScheduler } from '../src/serial-scheduler.ts';
import { CONTROLLED_BOOK_URL, ControlledAdapter, controlledCatalog, controlledChapter, controlledLink } from './helpers/serial-adapter.ts';

let dir: string, lib: Library, adapter: ControlledAdapter, sync: SerialSync, scheduler: SerialScheduler, now: number, network: boolean;
const links = [1, 2].map((n) => controlledLink(n));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-serial-scheduler-')); now = 1_000_000; network = true;
  lib = new Library({ dataDir: dir, now: () => now }); lib.open();
  adapter = new ControlledAdapter(controlledCatalog(links), links.map((l) => controlledChapter(l, '正文。'.repeat(200))));
  sync = new SerialSync(lib, { allowNetwork: () => network, adapter: () => adapter, now: () => now, jobsFile: join(dir, 'jobs.json') }); sync.start();
  scheduler = new SerialScheduler(lib, sync, { allowNetwork: () => network, now: () => now, random: () => 0.5, intervalMs: 1_000_000 });
});
afterEach(() => { scheduler.stop(); sync.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });
async function subscribed() {
  const preview = await sync.preview(adapter.id, CONTROLLED_BOOK_URL);
  const result = sync.subscribe(preview.token, { intervalMinutes: 30 });
  await sync.wait(result.jobId);
  return result.bookKey;
}
async function awaitLast(bookKey: string) {
  const job = sync.jobsFor(bookKey).at(-1);
  if (!job) throw new Error('no job');
  return sync.wait(job.jobId);
}
describe('serial check scheduling', () => {
  it('waits for startup jitter, then checks a due subscription once', async () => {
    const key = await subscribed();
    lib.setSerialSubscription(key, true, 30);
    now += 31 * 60000;
    const before = adapter.catalogCalls;
    scheduler.start();
    await scheduler.tick();
    expect(adapter.catalogCalls).toBe(before);
    now += 61_000;
    await scheduler.tick();
    await awaitLast(key);
    expect(adapter.catalogCalls).toBeGreaterThan(before);
    expect(lib.serialSubscription(key)!.subscription.lastSuccessfulCheckAt).toBeTruthy();
  });
  it('does not check while the global network switch is off', async () => {
    const key = await subscribed(); lib.setSerialSubscription(key, true, 30); now += 31 * 60000;
    network = false;
    const before = adapter.catalogCalls;
    scheduler.start(); await scheduler.tick(); now += 200_000; await scheduler.tick();
    expect(adapter.catalogCalls).toBe(before);
  });
  it('does not replay missed offline intervals after restart', async () => {
    const key = await subscribed(); lib.setSerialSubscription(key, true, 30); now += 24 * 3600_000;
    const before = adapter.catalogCalls;
    scheduler.start(); await scheduler.tick(); now += 61_000; await scheduler.tick(); await awaitLast(key);
    expect(adapter.catalogCalls - before).toBeGreaterThan(0);
    const afterFirst = adapter.catalogCalls;
    await scheduler.tick();
    expect(adapter.catalogCalls).toBe(afterFirst);
  });
  it('does not schedule a disabled subscription', async () => {
    const key = await subscribed(); lib.setSerialSubscription(key, false, 30); now += 3600_000;
    const calls = adapter.catalogCalls;
    scheduler.start(); await scheduler.tick();
    expect(adapter.catalogCalls).toBe(calls);
  });
});
