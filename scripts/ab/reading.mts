/**
 * Repeat the reading loop N times per arm, because a single sample of a 9B
 * model's confirmation behaviour is noise. Measures:
 *   - whether the model confirms the supplied range (the product-critical step)
 *   - how many rounds and how many read/finish calls each run needs
 *   - prompt tokens of the first request (the resident cost)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { Arm, OUT, MODEL } = await import(pathToFileURL(resolve(import.meta.dirname, 'runner.mts')).href);
const { armContext } = await import(pathToFileURL(resolve(import.meta.dirname, 'context.mts')).href);
const { ollamaChat } = await import(pathToFileURL(resolve(import.meta.dirname, 'model.mts')).href);

const REPS = Number(process.env.AB_REPS ?? 3);
mkdirSync(OUT, { recursive: true });

async function oneRun(arm: any, system: string) {
  const before = (arm.host.events as any[]).length;
  const request = await arm.world.webUi().invoke('status', 'read_now', [arm.bookKey]);
  await new Promise((done) => setTimeout(done, 50));
  const events = (arm.host.events as any[]).slice(before).filter((event: any) => event.type === 'bookfish.reading_opportunity');
  const event = events[events.length - 1];
  const brief = event ? (typeof event.render === 'function' ? event.render() : event.text) : null;
  if (!brief) return { error: 'no opportunity' };

  const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: brief }];
  const calls: any[] = [];
  const tokens: number[] = [];
  let confirmed = 0;
  for (let round = 0; round < 5; round++) {
    let result;
    try { result = await ollamaChat(MODEL, messages, arm.modelTools); }
    catch (error) { return { error: String((error as Error).message).slice(0, 200), calls, tokens }; }
    tokens.push(result.promptTokens);
    messages.push({ role: 'assistant', content: result.text || '' });
    if (!result.toolCalls.length) break;
    for (const call of result.toolCalls) {
      const outcome = await arm.call(call.name, call.arguments);
      if (call.name === 'bookfish_finish_reading' && outcome.ok) confirmed++;
      calls.push({ name: call.name, ok: outcome.ok, args: call.arguments, ...(outcome.ok ? {} : { error: outcome.text.slice(0, 200) }) });
      messages.push({ role: 'tool', content: outcome.text.slice(0, 4000), tool_name: call.name });
    }
    if (result.toolCalls.some((call: any) => call.name === 'end_turn')) break;
  }
  arm.world.onEventsSettled?.([{ ...event, cursor: 1, ts: '', source: 'bookfish', origin: 'internal', text: 'ab' }], 'delivered');
  return { confirmed, tokens, calls };
}

const rows: any[] = [];
for (const name of ['before', 'after'] as const) {
  const srcDir = name === 'before' ? resolve(PACKAGE, '.old-src') : resolve(PACKAGE, 'src');
  const context = await armContext({ srcDir });
  for (let rep = 1; rep <= REPS; rep++) {
    const arm = await new Arm(name, srcDir).open();
    let result;
    try { result = await oneRun(arm, context.system); }
    finally { await arm.close(); }
    rows.push({ arm: name, rep, firstTokens: context.system.length ? result.tokens?.[0] ?? null : null, ...result });
    process.stderr.write(`${name} rep${rep}: confirmed=${result.confirmed ?? 0} rounds=${(result.tokens ?? []).length}\n`);
  }
}
writeFileSync(join(OUT, 'ab-reading-reps.json'), JSON.stringify(rows, null, 2));
const summary = ['before', 'after'].map((arm) => {
  const mine = rows.filter((row) => row.arm === arm);
  return {
    arm,
    runs: mine.length,
    confirmedRuns: mine.filter((row) => (row.confirmed ?? 0) > 0).length,
    firstTokens: mine.map((row) => row.tokens?.[0] ?? null),
    rounds: mine.map((row) => (row.tokens ?? []).length),
    calls: mine.map((row) => (row.calls ?? []).map((call: any) => call.name).join(',')),
  };
});
console.log(JSON.stringify(summary, null, 2));
