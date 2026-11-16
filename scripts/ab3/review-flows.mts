/**
 * 阶段 2 / G02：整本评论 5 本书的完整闭环（生产模型）。
 * A 短书无 Episode；B 多页 ranges + Episode；C 两类都多页；D 有修订记录；E 取材料期间任务失效。
 *   ONLY=A node --import tsx scripts/ab3/review-flows.mts
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, chat, save, totals, MODEL } from '../ab2/core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;
const MAX_TOKENS = Number(process.env.AB_MAX_TOKENS ?? 4096);

const repeat = (text: string, times: number) => text.repeat(times);
const chapter = (index: number, body: string) => `# 第${index + 1}章\n${body}`;
const BOOKS: Record<string, string> = {
  A: [chapter(0, repeat('潮水打在礁石上，沈岸把缆绳绕了两圈。', 5)), chapter(1, repeat('黎望给沈岸倒了杯热水。', 5))].join('\n'),
  B: Array.from({ length: 5 }, (_, i) => chapter(i, repeat('沈岸数着箱子，海面泛着铁灰色。', 8))).join('\n'),
  C: Array.from({ length: 8 }, (_, i) => chapter(i, repeat('灯塔的光扫过雾面，黎望没有说话。', 8))).join('\n'),
  D: Array.from({ length: 5 }, (_, i) => chapter(i, repeat('他把航海笔记摊在膝上，字迹很抖。', 8))).join('\n'),
  E: Array.from({ length: 5 }, (_, i) => chapter(i, repeat('汽笛在三点四十响起。', 8))).join('\n'),
};

const results: any[] = [];
const record = (row: any) => { results.push(row); save('review/flows.json', results); };
const tool = (arm: any, name: string) => arm.world.tools().find((entry: any) => entry.name === name);

async function status(arm: any) { return arm.world.webUi('zh').invoke('status', 'get', []); }

async function confirmAll(arm: any) {
  for (let guard = 0; guard < 80; guard++) {
    const state = await status(arm);
    if (state.books?.[0]?.complete) return true;
    let request: any;
    try { request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]); } catch { return false; }
    let batch: any;
    try { batch = JSON.parse(await tool(arm, 'bookfish_read_next').handler({ opportunityId: request.opportunityId, segments: 4 }, {}) as string); } catch { return false; }
    if (batch.complete) return true;
    await tool(arm, 'bookfish_finish_reading').handler({
      opportunityId: request.opportunityId,
      confirmations: batch.segments.map((item: any) => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' })),
    }, {});
  }
  return false;
}

/** 造 count 条 Episode；返回实际条数。 */
async function makeEpisodes(arm: any, count: number) {
  let made = 0;
  for (let index = 0; index < count; index++) {
    let request: any;
    try { request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]); } catch { break; }
    let batch: any;
    try { batch = JSON.parse(await tool(arm, 'bookfish_read_next').handler({ opportunityId: request.opportunityId, segments: 1 }, {}) as string); } catch { break; }
    if (batch.complete) break;
    const item = batch.segments[0];
    const raw = item.segment.text as string;
    const quote = Array.from(raw.split('\n').map((line: string) => line.trim()).find((line: string) => line.length >= 12) ?? raw).slice(0, 12).join('');
    const created = JSON.parse(await tool(arm, 'bookfish_finish_reading').handler({
      opportunityId: request.opportunityId, bookKey: batch.bookKey, taskId: item.taskId, segmentId: item.segmentId,
      understanding: '这一段有值得记下的东西。',
      episode: { trigger: '读到一段有画面感的叙述', interpretation: '他把注意力放在别人的旧物上。', evidence: [{ segmentId: item.segmentId, quote }] },
    }, {}) as string);
    if (created.receipt) made++;
  }
  return made;
}

const plan: Array<[string, { episodes: number; invalidate?: boolean }]> = [
  ['A', { episodes: 0 }],
  ['B', { episodes: 2 }],
  ['C', { episodes: 3 }],
  ['D', { episodes: 2 }],
  ['E', { episodes: 1, invalidate: true }],
];

async function runBook(label: string, options: { episodes: number; invalidate?: boolean }) {
  const arm = await openArm(`rv-${label}`, {}, BOOKS[label]);
  const trace: any[] = [];
  let finishReceipt: any = null;
  try {
    await confirmAll(arm);
    if (options.episodes) { await makeEpisodes(arm, options.episodes); await confirmAll(arm); }
    const before = await status(arm);
    const book = before.books?.[0] ?? {};

    const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: '这本书我读完了，给它写一篇整本读后感吧。' }];
    let invalidated = false;
    for (let round = 1; round <= 24; round++) {
      const reply = await chat(messages, arm.modelTools, MAX_TOKENS);
      trace.push({ round, text: reply.text.slice(0, 600), calls: reply.calls.map((entry) => entry.name), promptTokens: reply.promptTokens });
      messages.push({ role: 'assistant', content: reply.text || '', ...(reply.rawCalls.length ? { tool_calls: reply.rawCalls } : {}) });
      if (!reply.calls.length) break;
      for (let index = 0; index < reply.calls.length; index++) {
        const entry = reply.calls[index];
        let text = '', ok = true, error: string | undefined;
        if (entry.name === 'pet_say') text = '{"accepted":true}';
        else if (entry.name === 'end_turn') text = '{"ended":true}';
        else {
          try { text = await tool(arm, entry.name).handler(entry.args, {}) as string; }
          catch (e) { ok = false; error = String((e as Error)?.message ?? e); text = error; }
        }
        const isFinish = entry.name === 'bookfish_review' && (entry.args as any).action === 'finish';
        trace.push({ round, name: entry.name, args: entry.args, ok, error, result: ok ? text.slice(0, 400) : undefined });
        if (isFinish && ok) finishReceipt = JSON.parse(text);
        messages.push({ role: 'tool', content: text.slice(0, 8000), tool_name: entry.name, tool_call_id: reply.rawCalls[index]?.id ?? entry.name });
        // E：begin 成功后新写一条手账，让 job 的快照失效。
        if (options.invalidate && !invalidated && entry.name === 'bookfish_review' && String((entry.args as any).action) === 'begin' && ok) {
          invalidated = true;
          await makeEpisodes(arm, 1);
        }
      }
      if (reply.calls.some((entry) => entry.name === 'end_turn')) break;
    }

    const calls = trace.filter((row) => row.name === 'bookfish_review');
    const finishes = calls.filter((row) => String((row.args as any).action) === 'finish');
    record({
      book: label, segments: book.totalSegments ?? null, complete: book.complete ?? null, episodesPlanned: options.episodes,
      invalidate: Boolean(options.invalidate),
      modelRounds: trace.filter((row) => row.round).length,
      promptTokens: trace.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0),
      beginOk: calls.filter((row) => String((row.args as any).action) === 'begin' && row.ok).length,
      materialsRanges: calls.filter((row) => String((row.args as any).action) === 'materials' && (row.args as any).kind === 'ranges').length,
      materialsEpisodes: calls.filter((row) => String((row.args as any).action) === 'materials' && (row.args as any).kind === 'episodes').length,
      finishAttempts: finishes.length,
      finishOk: finishes.filter((row) => row.ok).length,
      finishErrors: finishes.filter((row) => !row.ok).map((row) => row.error),
      title: finishReceipt?.review?.title ?? null,
      version: finishReceipt?.review?.version ?? null,
      article: finishReceipt?.review?.text ?? null,
      articleChars: finishReceipt?.review?.text ? Array.from(finishReceipt.review.text as string).length : 0,
      trace,
    });
    process.stderr.write(`  ${label}: segments=${book.totalSegments} complete=${book.complete} finish=${finishes.filter((row) => row.ok).length}/${finishes.length} chars=${finishReceipt?.review?.text ? Array.from(finishReceipt.review.text as string).length : 0}\n`);
  } catch (error) {
    record({ book: label, error: String((error as Error).message).slice(0, 300), trace });
  } finally { await arm.close(); }
}

const only = process.env.ONLY;
for (const [label, options] of plan) { if (only && label !== only) continue; await runBook(label, options); }

const summary = {
  model: MODEL, maxTokens: MAX_TOKENS,
  books: results.map((row) => ({
    book: row.book, segments: row.segments, complete: row.complete, beginOk: row.beginOk,
    rangesPages: row.materialsRanges, episodePages: row.materialsEpisodes,
    finishOk: row.finishOk, finishAttempts: row.finishAttempts, version: row.version,
    articleChars: row.articleChars, finishErrors: row.finishErrors, error: row.error,
  })),
  spent: totals(),
};
save('review/summary.json', summary);
console.log(JSON.stringify(summary, null, 2));
