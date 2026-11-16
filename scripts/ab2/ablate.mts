/**
 * 阶段 6 / 7：nextStep 消融、scheduler.brief 变体、discussion guidance 变体。
 *   ABLATE=nextstep|brief|guidance
 * 变体只改写"喂给模型的文本"，World 代码不变；nextStep 变体只删回执字段。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, runSession, lastEventText, ensureEpisode, save, totals, MODEL, readWholeBook } from './core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;

const PHASE = process.env.ABLATE ?? 'nextstep';
const REPS = Number(process.env.ABLATE_REPS ?? 10);
const results: any[] = [];
const record = (row: any) => { results.push(row); save(`ablate/${PHASE}.json`, results); };

const codepoints = (value: string) => Array.from(value).length;

async function readingLoop(label: string, rep: number, options: { dropNextStep?: boolean; brief?: (text: string, opportunityId: string) => string }) {
  const arm = await openArm(`ablate-${label}-${rep}`, {});
  try {
    const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
    const opportunityId = request.opportunityId as string;
    const raw = lastEventText(arm, 'bookfish.reading_opportunity') ?? '';
    const seed = options.brief ? options.brief(raw, opportunityId) : raw;
    const before = (await arm.world.webUi('zh').invoke('status', 'get', []))?.books?.[0]?.confirmedSegments ?? 0;
    const session = await runSession(arm, SYSTEM, seed, { maxRounds: 5, dropNextStep: options.dropNextStep });
    const after = (await arm.world.webUi('zh').invoke('status', 'get', []))?.books?.[0] ?? {};
    const confirmedDelta = Number(after.confirmedSegments ?? 0) - Number(before);
    const readCalls = session.calls.filter((call) => call.name === 'bookfish_read_next');
    const finishCalls = session.calls.filter((call) => call.name === 'bookfish_finish_reading');
    const promptTokens = session.turns.reduce((sum, turn) => sum + turn.promptTokens, 0);
    const row = {
      phase: PHASE, label, rep, eventChars: seed.length,
      readCalls: readCalls.length, readWithOpportunity: readCalls.filter((call) => (call.args as any).opportunityId === opportunityId).length,
      finishCalls: finishCalls.length, finishOk: finishCalls.filter((call) => call.ok).length,
      confirmedDelta, complete: after.complete ?? null,
      rounds: session.turns.length, promptTokens,
      tokensPer10k: confirmedDelta > 0 ? Math.round(promptTokens / ((confirmedDelta * 1200) / 10000)) : null,
      stoppedAfterReading: finishCalls.length === 0,
      settingsTouched: session.calls.some((call) => call.name === 'bookfish_set_paused'),
      calls: session.calls.map((call) => `${call.name}${call.ok ? '' : '!'}`), lastText: session.lastText.slice(0, 300),
    };
    process.stderr.write(`  [${PHASE}/${label}/${rep}] read=${row.readCalls} finish=${row.finishOk}/${row.finishCalls} confirmed=${confirmedDelta} tokens=${promptTokens}\n`);
    return row;
  } catch (error) { return { phase: PHASE, label, rep, error: String((error as Error).message).slice(0, 300) }; }
  finally { await arm.close(); }
}

if (PHASE === 'nextstep') {
  for (let rep = 0; rep < REPS; rep++) record(await readingLoop('A-with', rep, {}));
  for (let rep = 0; rep < REPS; rep++) record(await readingLoop('B-without', rep, { dropNextStep: true }));
}

if (PHASE === 'brief') {
  const short = (text: string, opportunityId: string) => `阅读机会 ${opportunityId}。想读就调 bookfish_read_next（带这个机会号）取下一段，读完用 bookfish_finish_reading 确认；不想读就 bookfish_defer_reading。`;
  const pointer = (text: string, opportunityId: string) => `阅读机会 ${opportunityId}。具体规矩见 bookfish_help("reading")。`;
  for (let rep = 0; rep < REPS; rep++) record(await readingLoop('A-full', rep, {}));
  for (let rep = 0; rep < REPS; rep++) record(await readingLoop('B-short', rep, { brief: short }));
  for (let rep = 0; rep < REPS; rep++) record(await readingLoop('C-pointer', rep, { brief: pointer }));
}

if (PHASE === 'guidance') {
  const rewrite = (text: string, guidance: string) => {
    try { const parsed = JSON.parse(text); parsed.guidance = guidance; return JSON.stringify(parsed); } catch { return text; }
  };
  const short = '这是用户就一条已存感想发起的讨论。按顺序：pet_say 一条 → bookfish_discussion(append) 同一条原文 → 非最后一条先 pace → 最后 reply（delivery:"spoken"，带上全部原文）。失败就 delivery:"unavailable"。';
  const pointer = '这是用户就一条已存感想发起的讨论。做法见 bookfish_help("discussion")。';
  for (const [label, transform] of [['A-full', (text: string) => text], ['B-short', (text: string) => rewrite(text, short)], ['C-pointer', (text: string) => rewrite(text, pointer)]] as const) {
    for (let rep = 0; rep < REPS; rep++) {
      const arm = await openArm(`guide-${label}-${rep}`, {});
      try {
        const episodeId = await ensureEpisode(arm);
        await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？说说你的想法。' }]);
        await new Promise((done) => setTimeout(done, 50));
        const seed = transform(lastEventText(arm, 'bookfish.discussion') ?? '');
        const session = await runSession(arm, SYSTEM, seed, { maxRounds: 12 });
        const discussion = session.calls.filter((call) => call.name === 'bookfish_discussion');
        const reply = discussion.find((call) => (call.args as any).action === 'reply');
        const said = session.said.map((line) => line.replace(/【[^】]{1,40}】/gu, '').replace(/<[^>]{1,40}>/gu, '').trim()).filter(Boolean);
        const segments: string[] = reply?.ok ? (JSON.parse(String(reply.result ?? '{}')).segments ?? []) : [];
        const exact = said.length > 0 && said.length === segments.length && said.every((line, index) => line === segments[index]);
        record({ phase: PHASE, label, rep, eventChars: seed.length, rounds: session.turns.length,
          promptTokens: session.turns.reduce((sum, turn) => sum + turn.promptTokens, 0),
          helpCalls: session.calls.filter((call) => call.name === 'bookfish_help').length,
          said: said.length, append: discussion.filter((call) => (call.args as any).action === 'append').length,
          pace: discussion.filter((call) => (call.args as any).action === 'pace').length,
          replyOk: Boolean(reply?.ok), exact, over120: said.filter((line) => codepoints(line) > 120).length,
          calls: session.calls.map((call) => `${call.name}:${(call.args as any).action ?? ''}${call.ok ? '' : '!'}`) });
        process.stderr.write(`  [guidance/${label}/${rep}] said=${said.length} append=${discussion.filter((c) => (c.args as any).action === 'append').length} reply=${Boolean(reply?.ok)} exact=${exact} help=${session.calls.filter((c) => c.name === 'bookfish_help').length}\n`);
      } catch (error) { record({ phase: PHASE, label, rep, error: String((error as Error).message).slice(0, 300) }); }
      finally { await arm.close(); }
    }
  }
}

const groups = [...new Set(results.map((row) => row.label))];
const summary = {
  model: MODEL,
  phase: PHASE,
  groups: groups.map((label) => {
    const rows = results.filter((row) => row.label === label && !row.error);
    const ok = rows.filter((row) => (row.finishOk ?? 0) > 0 || row.replyOk || row.exact);
    const tokens = rows.map((row) => row.promptTokens).sort((a, b) => a - b);
    return { label, runs: rows.length, successRuns: ok.length,
      avgTokens: rows.length ? Math.round(tokens.reduce((sum, value) => sum + value, 0) / rows.length) : null,
      p50: tokens.length ? tokens[Math.floor(tokens.length / 2)] : null,
      p95: tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * 0.95))] : null,
      avgRounds: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row.rounds ?? 0), 0) / rows.length * 10) / 10 : null,
      helpCalls: rows.reduce((sum, row) => sum + (row.helpCalls ?? 0), 0),
      stoppedAfterReading: rows.filter((row) => row.stoppedAfterReading).length,
      errors: results.filter((row) => row.label === label && row.error).length };
  }),
  spent: totals(),
};
save(`ablate/${PHASE}-summary.json`, summary);
console.log(JSON.stringify(summary, null, 2));
