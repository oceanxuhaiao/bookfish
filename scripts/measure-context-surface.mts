/**
 * Measure the model-visible BookFish surface that is resent on every request:
 * env prompt, tool schema JSON, the reading opportunity brief and the compact
 * status tool receipt. Read-only, synthetic sample text, no model calls.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { BOOKFISH_TOOL_DECLS } from '../src/tool-schemas.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const baselinePath = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : undefined;
const scratch = mkdtempSync(join(tmpdir(), 'bookfish-surface-'));
const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), kind: 'deterministic-surface-measurement', modelCalls: 0 };
try {
  const envPrompt = readFileSync(join(import.meta.dirname, '..', 'src', 'ENV_PROMPT.md'), 'utf8');
  const toolSchema = JSON.stringify(BOOKFISH_TOOL_DECLS);
  result.resident = { envPromptChars: envPrompt.length, toolSchemaChars: toolSchema.length, totalChars: envPrompt.length + toolSchema.length };

  const lib = new Library({ dataDir: join(scratch, 'lib') }); lib.open();
  const imported = lib.import({ filename: 'sample.txt', title: '合成样本', base64: Buffer.from('海边有鱼。'.repeat(4000)).toString('base64') });
  lib.select(imported.book.key);
  const scheduler = new ReadingScheduler(lib, { ...BOOKFISH_DEFAULTS, realRoutineEnabled: false, readingBatchSegments: 3 }, 'Asia/Shanghai');
  const scheduler1 = new ReadingScheduler(lib, { ...BOOKFISH_DEFAULTS, realRoutineEnabled: false, readingBatchSegments: 1 }, 'Asia/Shanghai');
  const brief = (scheduler as unknown as { brief: (a: unknown) => string }).brief({ id: '00000000-0000-4000-8000-000000000000', generation: 0, expires: Date.now() + 600000, delivered: false, mode: 'main' });
  const brief1 = (scheduler1 as unknown as { brief: (a: unknown) => string }).brief({ id: '00000000-0000-4000-8000-000000000000', generation: 0, expires: Date.now() + 600000, delivered: false, mode: 'main' });
  const manualBrief = (scheduler as unknown as { brief: (a: unknown) => string }).brief({ id: '00000000-0000-4000-8000-000000000000', generation: 0, expires: Date.now() + 600000, delivered: false, mode: 'main', manual: true });
  result.opportunityBrief = { batch1Chars: Array.from(brief1).length, batch3Chars: Array.from(brief).length, batch3ManualChars: Array.from(manualBrief).length };
  lib.close();

  const ctx = fakeWorldContext(BOOKFISH, { scratchDir: join(scratch, 'world') });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false });
  const world = BOOKFISH.create(ctx);
  await world.start(new FakeHost());
  try {
    const invoke = world.webUi!().invoke!;
    const book = await invoke('status', 'import', [{ filename: 's.txt', title: '状态样本', base64: Buffer.from('海边有鱼。'.repeat(20)).toString('base64') }]) as { book: { key: string } };
    if (!book?.book?.key) throw new Error(`unexpected import result: ${JSON.stringify(book)?.slice(0, 300)}`);
    await invoke('status', 'select', [book.book.key]);
    const text = await world.tools().find(t => t.name === 'bookfish_get_status')!.handler({}, {});
    result.statusReceipt = { chars: typeof text === 'string' ? text.length : 0 };
  } finally { await world.stop(); }

  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8')) as {
      opportunityBriefChars: { median: number; mean: number; max: number };
      statusReceiptChars: { median: number; mean: number; p95: number; max: number; over8000: number };
    };
    const briefNew = result.opportunityBrief as { batch1Chars: number; batch3Chars: number };
    const statusNew = result.statusReceipt as { chars: number };
    result.comparison = {
      opportunityBrief: { baselineMedian: baseline.opportunityBriefChars.median, optimizedBatch1: briefNew.batch1Chars, optimizedBatch3: briefNew.batch3Chars,
        reductionVsBaseline: 1 - briefNew.batch1Chars / baseline.opportunityBriefChars.median,
        note: 'Old briefs were measured from stored real host events; the optimized brief is rendered by the current code without any model call. Batch 3 shows the largest projection; batch 1 text is the same shape with a smaller segment count.' },
      statusReceipt: { baselineMedian: baseline.statusReceiptChars.median, baselineP95: baseline.statusReceiptChars.p95, optimized: statusNew.chars,
        reductionVsBaselineMedian: 1 - statusNew.chars / baseline.statusReceiptChars.median, baselineOver8000: baseline.statusReceiptChars.over8000 },
      resident: { before: null, after: result.resident, note: '0.31.0 measured 22,934 chars for prompt + tool schema; current total is measured below.' },
    };
  }
  mkdirSync(out ? dirname(resolve(out)) : scratch, { recursive: true });
  if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
