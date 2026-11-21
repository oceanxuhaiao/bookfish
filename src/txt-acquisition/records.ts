/** Durable acquisition task records, kept apart from the library and its book bodies. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactMessage, sourceReference } from './privacy.ts';
import {
  MAX_HISTORY, MAX_TASKS, isTerminal, validateAcquisitionState,
  type AcquisitionState, type AcquisitionStatus, type AcquisitionTask,
} from './types.ts';

export class AcquisitionRecords {
  private state: AcquisitionState = { schema: 1, tasks: [] };
  private loaded = false;
  readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'tasks.json');
  }

  load(now = Date.now()): void {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        this.state = validateAcquisitionState(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch {
        // Keep the damaged file for inspection instead of silently discarding tasks.
        try { renameSync(this.file, `${this.file}.corrupt-${now}`); } catch { /* best effort */ }
        this.state = { schema: 1, tasks: [] };
      }
    }
    this.loaded = true;
    this.save();
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  save(): void {
    for (const task of this.state.tasks) {
      if (task.pageUrl) {
        try { const source = sourceReference(task.pageUrl); task.pageUrlHash ??= source.sha256; task.requiresRediscovery ||= source.requiresRediscovery; task.pageUrl = source.url; }
        catch { delete task.pageUrl; task.requiresRediscovery = true; }
      }
      if (task.selection?.message) task.selection.message = redactMessage(task.selection.message);
      if (task.failure) task.failure.message = redactMessage(task.failure.message);
      if (task.rejection) task.rejection.message = redactMessage(task.rejection.message);
      for (const entry of task.history) if (entry.note) entry.note = redactMessage(entry.note);
    }
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, 'utf8');
    renameSync(temporary, this.file);
  }

  list(): AcquisitionTask[] {
    this.ensureLoaded();
    return this.state.tasks.map((task) => structuredClone(task));
  }

  get(id: string): AcquisitionTask | undefined {
    this.ensureLoaded();
    const task = this.state.tasks.find((entry) => entry.id === id);
    return task ? structuredClone(task) : undefined;
  }

  latest(): AcquisitionTask | undefined {
    this.ensureLoaded();
    const task = [...this.state.tasks].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return task ? structuredClone(task) : undefined;
  }

  put(task: AcquisitionTask): AcquisitionTask {
    this.ensureLoaded();
    const next = structuredClone(task);
    const index = this.state.tasks.findIndex((entry) => entry.id === next.id);
    if (index >= 0) this.state.tasks[index] = next; else this.state.tasks.push(next);
    this.trim(next.id);
    this.save();
    return this.get(next.id)!;
  }

  /** Mutate a task, recording history and the update time, then persist once. */
  update(id: string, mutate: (task: AcquisitionTask) => void, options: { status?: AcquisitionStatus; note?: string; now?: number } = {}): AcquisitionTask {
    this.ensureLoaded();
    const task = this.state.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error(`Unknown acquisition task ${id}`);
    const now = options.now ?? Date.now();
    mutate(task);
    if (options.status && options.status !== task.status) {
      task.status = options.status;
      task.history = [...task.history, { at: now, status: options.status, ...(options.note ? { note: options.note } : {}) }].slice(-MAX_HISTORY);
    }
    task.updatedAt = now;
    this.trim(id);
    this.save();
    return structuredClone(task);
  }

  /** Drop the oldest finished tasks once the cap is exceeded; never drop a running one. */
  private trim(preserveId?: string): void {
    if (this.state.tasks.length <= MAX_TASKS) return;
    const overflow = this.state.tasks.length - MAX_TASKS;
    const removable = this.state.tasks
      .map((task, index) => ({ task, index }))
      .filter((entry) => isTerminal(entry.task.status) && !entry.task.file?.retained && entry.task.id !== preserveId)
      .sort((left, right) => left.task.updatedAt - right.task.updatedAt)
      .slice(0, overflow);
    for (const entry of removable.sort((a, b) => b.index - a.index)) this.state.tasks.splice(entry.index, 1);
  }

  /** True while any task still owns staged bytes that must not be deleted. */
  hasActive(): boolean {
    this.ensureLoaded();
    return this.state.tasks.some((task) => !isTerminal(task.status));
  }
}
