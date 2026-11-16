/**
 * Same reading-loop repetitions, but on the production model the deployment
 * actually runs (DeepSeek). The key is read from the live deployment's provider
 * .env and is never printed or written anywhere.
 *
 *   AB_PROVIDER=deepseek AB_REPS=2 node --import tsx scripts/ab/reading.mts
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { Arm, OUT, MODEL } = await import(pathToFileURL(resolve(import.meta.dirname, 'runner.mts')).href);
const { armContext } = await import(pathToFileURL(resolve(import.meta.dirname, 'context.mts')).href);
const model = await import(pathToFileURL(resolve(import.meta.dirname, 'model.mts')).href);

const REPS = Number(process.env.AB_REPS ?? 2);
const DEEPSEEK_MODEL = process.env.AB_DEEPSEEK_MODEL ?? 'deepseek-flash';
const ENV_FILE = 'E:/zcdfy/Coopanion/data/home/providers/deepseek/.env';
mkdirSync(OUT, { recursive: true });

function apiKey(): string {
  const text = readFileSync(ENV_FILE, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '').trim();
  }
  throw new Error('DEEPSEEK_API_KEY not found in the deployment env file');
}

const key = apiKey();
const spent: Array<{ prompt: number; completion: number }> = [];

async function oneRun(arm: any, system: string) {
  const before = (arm.host.events as any[]).length;
  await arm.world.webUi().invoke('status', 'read_now', [arm.bookKey]);
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
    try { result = await model.deepseekChat(key, DEEPSEEK_MODEL, messages, arm.modelTools, { maxTokens: 1200 }); }
    catch (error) { return { error: String((error as Error).message).slice(0, 300), calls, tokens }; }
    spent.push({ prompt: result.promptTokens, completion: result.completionTokens });
    tokens.push(result.promptTokens);
    const rawCalls = (((result.raw as any)?.choices?.[0]?.message?.tool_calls) ?? []) as any[];
    messages.push({ role: 'assistant', content: result.text || '', ...(rawCalls.length ? { tool_calls: rawCalls } : {}) });
    if (!result.toolCalls.length) break;
    for (let index = 0; index < result.toolCalls.length; index++) {
      const call = result.toolCalls[index];
      const outcome = await arm.call(call.name, call.arguments);
      if (call.name === 'bookfish_finish_reading' && outcome.ok) confirmed++;
      calls.push({ name: call.name, ok: outcome.ok, args: call.arguments, ...(outcome.ok ? {} : { error: outcome.text.slice(0, 240) }) });
      messages.push({ role: 'tool', content: outcome.text.slice(0, 4000), tool_name: call.name, tool_call_id: rawCalls[index]?.id ?? call.name });
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
    rows.push({ arm: name, rep, ...result });
    process.stderr.write(`${name} rep${rep}: confirmed=${result.confirmed ?? 0} rounds=${(result.tokens ?? []).length} ${result.error ?? ''}\n`);
  }
}
writeFileSync(join(OUT, 'ab-reading-deepseek.json'), JSON.stringify({ model: DEEPSEEK_MODEL, rows, spent }, null, 2));
const summary = ['before', 'after'].map((arm) => {
  const mine = rows.filter((row) => row.arm === arm);
  return {
    arm, runs: mine.length,
    confirmedRuns: mine.filter((row) => (row.confirmed ?? 0) > 0).length,
    firstTokens: mine.map((row) => row.tokens?.[0] ?? null),
    calls: mine.map((row) => (row.calls ?? []).map((call: any) => call.name).join(',')),
    errors: mine.map((row) => row.error ?? null),
  };
});
console.log(JSON.stringify({ model: DEEPSEEK_MODEL, summary, tokensSpent: {
  requests: spent.length,
  prompt: spent.reduce((sum, row) => sum + row.prompt, 0),
  completion: spent.reduce((sum, row) => sum + row.completion, 0),
} }, null, 2));
