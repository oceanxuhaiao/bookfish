import type { Library } from './library.ts';

export interface PlanSchedulerView {
  routine: unknown;
  restUntil?: number | null;
  active?: unknown;
}

/**
 * Cross-book hand-off for the single reading plan.
 *
 * It never reads, confirms or writes progress. It decides *which book* the
 * existing per-book machinery should continue with, and it ends the plan entry
 * of a genuinely finished book.
 *
 * Ending the entry and switching the selected revision happen inside ONE
 * `Library.completeCurrentPlanned()` commit, so the plan can never claim a book
 * is "still waiting" while the shelf says "finished", and a finished entry can
 * never survive as a queued row.
 *
 * Every gate that used to protect the pet's own queue is re-checked here,
 * because a switched book must never look like a finished one.
 */
export type PlanAdvanceResult =
  | { advanced: true; from: string | null; to: string; itemId: string }
  | { advanced: false; reason: string };

export class PlanCoordinator {
  private readonly now: () => number;
  constructor(private readonly library: Library, now: () => number = Date.now) {
    this.now = now;
  }

  /** Called only at a real idle reading opportunity by the scheduler. */
  advance(scheduler: PlanSchedulerView): boolean {
    return this.attempt(scheduler).advanced;
  }

  attempt(scheduler: PlanSchedulerView): PlanAdvanceResult {
    const library = this.library;
    const status = library.status();
    if (!status.mounted) return { advanced: false, reason: 'not_mounted' };
    const current = status.current;
    // 1–2: only a real completion, never an inference, and never while text is offered.
    if (current && !current.complete) return { advanced: false, reason: 'current_incomplete' };
    if (status.pending) return { advanced: false, reason: 'pending_text' };
    const plan = library.plan();
    // Everything that can block *switching* — never the bookkeeping below.
    const blocked = status.paused ? 'paused'
      : scheduler.routine ? 'routine'
        : scheduler.restUntil && scheduler.restUntil > this.now() ? 'resting'
          : current && current.complete && library.hasPendingReviewJob(current.key) ? 'review_pending'
            : null;
    const allowSwitch = blocked === null && plan.enabled;

    if (current?.complete) {
      // Archive first, switch only when every gate is open. A repeated completion
      // callback finds nothing left to archive and is therefore a no-op.
      const handoff = library.completeCurrentPlanned(current.key, { switch: allowSwitch });
      if (handoff.to && handoff.itemId) return { advanced: true, from: current.key, to: handoff.to, itemId: handoff.itemId };
      if (blocked) return { advanced: false, reason: blocked };
      if (!plan.enabled) return { advanced: false, reason: 'plan_disabled' };
      return { advanced: false, reason: handoff.deferred ? 'deferred' : 'plan_exhausted' };
    }

    if (blocked) return { advanced: false, reason: blocked };
    if (!plan.enabled) return { advanced: false, reason: 'plan_disabled' };
    // Nothing is being read: following the plan starts the first readable entry.
    const start = library.startPlanned();
    if (start.to && start.itemId) return { advanced: true, from: null, to: start.to, itemId: start.itemId };
    return { advanced: false, reason: start.deferred ? 'deferred' : 'plan_empty' };
  }
}
