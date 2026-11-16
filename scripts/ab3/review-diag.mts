/**
 * G02 根因定位：完整记录 begin → materials → finish 的每一次调用（参数与回执全文）。
 *   node --import tsx scripts/ab3/review-diag.mts [scenario]
 * scenario: finished | unfinished
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, chat, readWholeBook, save, totals, MODEL, ensureEpisode } from '../ab2/core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;

const scenario = process.argv[2] ?? 'finished';
const arm = await openArm(`diag-${scenario}`, {});
const trace: any[] = [];
try {
  if (scenario === 'finished') {
    const whole = await readWholeBook(arm);
    trace.push({ step: 'readWholeBook', whole });
  } else {
    const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
    const read = JSON.parse(await arm.world.tools().find((t: any) => t.name === 'bookfish_read_next').handler({ opportunityId: request.opportunityId, segments: 4 }, {}) as string);
    await arm.world.tools().find((t: any) => t.name === 'bookfish_finish_reading').handler({ opportunityId: request.opportunityId, confirmations: read.segments.map((s: any) => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' })) }, {});
    trace.push({ step: 'partialRead', segments: read.segments.length });
  }
  if (process.env.WITH_EPISODE === '1') { const id = await ensureEpisode(arm); trace.push({ step: 'episode', id }); }

  const state = await arm.world.webUi('zh').invoke('status', 'get', []);
  trace.push({ step: 'status', book: { confirmed: state.books?.[0]?.confirmedSegments, complete: state.books?.[0]?.complete, total: state.books?.[0]?.totalSegments } });

  const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: '这本书我读完了，给它写一篇整本读后感吧。' }];
  for (let round = 1; round <= 20; round++) {
    const reply = await chat(messages, arm.modelTools, Number(process.env.AB_MAX_TOKENS ?? 1600));
    trace.push({ step: 'model', round, text: reply.text, calls: reply.calls.map((c) => c.name), promptTokens: reply.promptTokens });
    messages.push({ role: 'assistant', content: reply.text || '', ...(reply.rawCalls.length ? { tool_calls: reply.rawCalls } : {}) });
    if (!reply.calls.length) break;
    for (let index = 0; index < reply.calls.length; index++) {
      const entry = reply.calls[index];
      const decl = arm.tools.find((t: any) => t.name === entry.name);
      let text = '', ok = true, error: string | undefined;
      if (entry.name === 'pet_say') { text = '{"accepted":true}'; }
      else if (entry.name === 'end_turn') { text = '{"ended":true}'; }
      else if (!decl) { ok = false; error = 'unknown tool'; text = error; }
      else {
        try { text = await decl.handler(entry.args, {}) as string; }
        catch (e) { ok = false; error = String((e as Error)?.message ?? e); text = error; }
      }
      trace.push({ step: 'tool', round, name: entry.name, args: entry.args, ok, error, result: text.slice(0, 4000) });
      messages.push({ role: 'tool', content: text.slice(0, 6000), tool_name: entry.name, tool_call_id: reply.rawCalls[index]?.id ?? entry.name });
    }
    if (reply.calls.some((c) => c.name === 'end_turn')) break;
  }
} finally {
  save(`review/diag-${scenario}.json`, { model: MODEL, scenario, trace, spent: totals() });
  await arm.close();
}
const summary = trace.filter((row) => row.step === 'tool').map((row) => `${row.round}:${row.name}${row.ok ? '' : '!'}`);
console.log(JSON.stringify({ scenario, tools: summary, spent: totals() }, null, 2));
