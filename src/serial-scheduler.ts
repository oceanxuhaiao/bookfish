import type { Library } from './library.ts';
import type { SerialSync } from './serial-sync.ts';

export interface SerialSchedulerOptions { allowNetwork: () => boolean; now?: () => number; random?: () => number; intervalMs?: number }
/** Only schedules catalog checks while the World is mounted; it never calls a model or replays missed offline runs. */
export class SerialScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly bootDelayUntil = new Map<string, number>();
  private running = false;
  private started = false;
  constructor(private readonly library: Library, private readonly sync: SerialSync, private readonly options: SerialSchedulerOptions) {
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    for (const book of this.library.list()) {
      const subscription = book.serial?.subscription;
      if (!subscription?.enabled || !subscription.nextCheckAt) continue;
      if (Date.parse(subscription.nextCheckAt) <= now) this.bootDelayUntil.set(book.key, now + Math.floor(this.random() * 120000));
    }
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 30000); this.timer.unref?.();
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.started = false; this.bootDelayUntil.clear(); }
  /** Public for deterministic tests; the timer calls it with the real clock. */
  async tick(): Promise<void> {
    if (this.running || !this.options.allowNetwork()) return;
    this.running = true;
    try {
      const now = this.now();
      for (const book of this.library.list()) {
        const serial = book.serial;
        if (!serial?.subscription.enabled || !serial.subscription.nextCheckAt) continue;
        const delayedUntil = this.bootDelayUntil.get(book.key);
        if (delayedUntil !== undefined) { if (now < delayedUntil) continue; this.bootDelayUntil.delete(book.key); }
        if (Date.parse(serial.subscription.nextCheckAt) > now) continue;
        try { this.sync.check(book.key, 'auto'); } catch { /* a missing adapter or deleted book must not stop other subscriptions */ }
      }
    } finally { this.running = false; }
  }
}
