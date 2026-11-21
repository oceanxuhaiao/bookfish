import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOKFISH_DEFAULTS, type BookfishConfigSection } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { SelectionCoordinator } from '../src/selection.ts';
import type { SelectionIntent } from '../src/selection-types.ts';
import type { NovelFetches } from '../src/novel-fetch.ts';
import type { ReadingScheduler } from '../src/scheduler.ts';
import type { WorldHost } from 'cortico/core/types.ts';

const BODY = '她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。';
function novel(chapters = 2): string {
  return Array.from({ length: chapters }, (_, index) => `第${index + 1}章 海风\n\n　　${BODY.repeat(14)}\n`).join('\n');
}

let dir: string;
let library: Library;
let cfg: BookfishConfigSection;
let coordinator: SelectionCoordinator;

const host = { pushEvent: async () => undefined } as unknown as WorldHost;

function seedIntent(overrides: Partial<SelectionIntent> = {}): SelectionIntent {
  const now = Date.now();
  const intent: SelectionIntent = {
    id: randomUUID(), createdAt: now, updatedAt: now,
    title: '海风', author: '小鱼', reason: '想读这本书', status: 'acquiring',
    origin: 'autonomous', candidates: [], queueOnImport: true, ...overrides,
  };
  library.updateSelection((draft) => { draft.intents.push(intent); });
  return intent;
}

function intentOf(id: string): SelectionIntent {
  const found = library.selection().intents.find((intent) => intent.id === id);
  if (!found) throw new Error('intent missing');
  return found;
}

function importBook(title = '海风', author = '小鱼', chapters = 2): string {
  const added = library.importBytes({ filename: `${title}.txt`, title, author }, Buffer.from(novel(chapters), 'utf8'));
  return added.book.key;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-txt-selection-'));
  library = new Library({ dataDir: dir });
  library.open();
  cfg = { ...BOOKFISH_DEFAULTS, autonomousAcquisition: true, allowNetwork: true, realRoutineEnabled: false };
  coordinator = new SelectionCoordinator({
    library,
    novelFetches: {} as NovelFetches,
    scheduler: {} as ReadingScheduler,
    cfg: () => cfg,
    timezone: 'UTC',
  });
  coordinator.start(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await coordinator.stop();
  library.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquisition results entering autonomous selection', () => {
  it.each(['persistence','queue_append'] as const)('can retry %s failure without a second commitment or progress', stage => {
    const intent=seedIntent(),bookKey=importBook(); const original=library.updateSelection.bind(library);
    const fault=vi.spyOn(library,'updateSelection').mockImplementationOnce(fn=>{if(stage==='persistence')throw Error('state write failed');return original(draft=>{fn(draft);if(draft.queue.length)throw Error('queue append interrupted');});});
    expect(()=>coordinator.onExternalImport({id:'fault',intentId:intent.id,bookKey},'exact')).toThrow();expect(library.list()).toHaveLength(1);expect(library.list()[0].confirmedChars).toBe(0);fault.mockRestore();
    coordinator.onExternalImport({id:'fault',intentId:intent.id,bookKey},'exact');coordinator.onExternalImport({id:'fault',intentId:intent.id,bookKey},'exact');expect(library.selection().queue.filter(q=>q.intentId===intent.id)).toHaveLength(1);
  });
  it('keeps the queued fact if announcement fails, and replay does not create a second queue item', () => {
    const intent=seedIntent(),bookKey=importBook(); const fault=vi.spyOn(host,'pushEvent').mockImplementationOnce(()=>{throw Error('announce unavailable');});
    expect(()=>coordinator.onExternalImport({id:'announce',intentId:intent.id,bookKey},'exact')).toThrow();fault.mockRestore();coordinator.onExternalImport({id:'announce',intentId:intent.id,bookKey},'exact');expect(library.selection().queue.filter(q=>q.intentId===intent.id)).toHaveLength(1);expect(library.list()[0].confirmedChars).toBe(0);
  });
  it('queues a matching book exactly once and never claims reading progress', () => {
    const intent = seedIntent();
    const bookKey = importBook();
    coordinator.onExternalImport({ id: 'task-1', intentId: intent.id, bookKey }, 'exact');

    const after = intentOf(intent.id);
    expect(after.status).toBe('reading');
    expect(after.bookKey).toBe(bookKey);
    const queue = library.selection().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ intentId: intent.id, bookKey, source: 'pet', status: 'queued' });

    coordinator.onExternalImport({ id: 'task-1', intentId: intent.id, bookKey }, 'exact');
    expect(library.selection().queue).toHaveLength(1);

    // The book is shelved but unread: no frontier movement, no receipt, no task.
    const entry = library.list().find((book) => book.key === bookKey)!;
    expect(entry.confirmedChars).toBe(0);
    expect(library.status().current).toBeNull();
  });

  it('holds an uncertain edition for confirmation instead of queueing it', () => {
    const intent = seedIntent();
    const bookKey = importBook('海风（修订版）', '小鱼');
    coordinator.onExternalImport({ id: 'task-2', intentId: intent.id, bookKey }, 'partial');

    const after = intentOf(intent.id);
    expect(after.status).toBe('awaiting_choice');
    expect(after.failure?.code).toBe('identity_mismatch');
    expect(library.selection().queue).toEqual([]);
  });

  it('ignores manual imports and cancelled intents', () => {
    const manual = importBook('海边', '小鱼');
    coordinator.onExternalImport({ id: 'task-3', bookKey: manual }, 'exact');
    expect(library.selection().intents).toEqual([]);
    expect(library.selection().queue).toEqual([]);

    const cancelled = seedIntent({ status: 'cancelled' });
    const bookKey = importBook('灯塔', '小鱼');
    coordinator.onExternalImport({ id: 'task-4', intentId: cancelled.id, bookKey }, 'exact');
    const after = intentOf(cancelled.id);
    expect(after.status).toBe('cancelled');
    expect(after.failure?.code).toBe('cancelled');
    expect(after.bookKey).toBe(bookKey);
    expect(library.selection().queue).toEqual([]);
  });

  it('leaves an intent that already points at another revision alone', () => {
    const first = importBook();
    const intent = seedIntent({ status: 'reading', bookKey: first });
    const repaired = importBook('海风', '小鱼', 3);
    expect(repaired).not.toBe(first);
    coordinator.onExternalImport({ id: 'task-5', intentId: intent.id, bookKey: repaired }, 'exact');
    const after = intentOf(intent.id);
    expect(after.bookKey).toBe(first);
    expect(library.selection().queue).toEqual([]);
  });

  it('records a failure when the book is missing from the shelf', () => {
    const intent = seedIntent();
    coordinator.onExternalImport({ id: 'task-6', intentId: intent.id, bookKey: 'missing:revision' }, 'exact');
    const after = intentOf(intent.id);
    expect(after.failure?.code).toBe('import_failed');
    expect(library.selection().queue).toEqual([]);
  });
});

