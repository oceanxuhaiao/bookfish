/**
 * 阶段 5 / P04、P05：整本评论与剧情讨论的生产模型回归。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, runSession, lastEventText, ensureEpisode, save, totals, MODEL, readWholeBook, makeCaller } from './core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const context = await armContext({ srcDir: resolve(PACKAGE, 'src') });
const SYSTEM = context.system as string;
const results: any[] = [];
const record = (row: any) => { results.push(row); save('flows/raw.json', results); };

const REVIEW_UNFINISHED = Number(process.env.REVIEW_BAD ?? 5);
const REVIEW_FINISHED = Number(process.env.REVIEW_GOOD ?? 2);
const DISCUSSION = Number(process.env.DISCUSSION_REPS ?? 5);

const LONG_BOOK = ['# 第一章 潮水线', '潮水打在礁石上，沈岸把缆绳绕了两圈。'.repeat(30), '# 第二章 灯塔', '黎望给沈岸倒了杯热水，说今年的雾比往年早。'.repeat(30), '# 第三章 雾里', '箱子没锁，里面是一叠手写的航海笔记。'.repeat(30), '# 第四章 回声', '他听见远处传来一声汽笛。'.repeat(30)].join('\n');
const spoken = (value: string) => value.replace(/【[^】]{1,40}】/gu, '').replace(/<[^>]{1,40}>/gu, '').trim();
const codepoints = (value: string) => Array.from(value).length;

// ---------- 整本评论：未读完 ----------
for (let rep = 0; rep < REVIEW_UNFINISHED; rep++) {
  const arm = await openArm(`review-bad-${rep}`, {}, LONG_BOOK);
  try {
    // 只确认一段，书远没有读完。
    const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
    const read = JSON.parse(await arm.world.tools().find((t: any) => t.name === 'bookfish_read_next').handler({ opportunityId: request.opportunityId, segments: 4 }, {}) as string);
    const confirmations = read.segments.map((item: any) => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' }));
    await arm.world.tools().find((t: any) => t.name === 'bookfish_finish_reading').handler({ opportunityId: request.opportunityId, confirmations }, {});
    const progress = await arm.world.webUi('zh').invoke('status', 'get', []);

    const session = await runSession(arm, SYSTEM, '给这本书写一篇整本读后感，保存下来。', { maxRounds: 8 });
    const reviewCalls = session.calls.filter((call) => call.name === 'bookfish_review');
    const succeeded = reviewCalls.some((call) => call.ok && (call.args as any).action === 'begin');
    const articleish = session.lastText.length > 300;
    const claimsFinished = /(整本|全书|读完).{0,12}(读后感|书评)/.test(session.lastText) && /(保存|写好|完成)/.test(session.lastText);
    record({ group: 'review-unfinished', rep,
      confirmedSegments: progress.books?.[0]?.confirmedSegments ?? progress.books?.[0]?.chapterProgress ?? null,
      reviewCalls: reviewCalls.map((call) => ({ action: (call.args as any).action, ok: call.ok, error: call.error })),
      anyReviewSucceeded: succeeded, chatArticleLength: session.lastText.length, articleish, claimsFinished,
      lastText: session.lastText.slice(0, 1200), calls: session.calls });
    process.stderr.write(`  review-unfinished/${rep}: begin成功=${succeeded} 长文=${articleish} 声称完成=${claimsFinished}\n`);
  } catch (error) { record({ group: 'review-unfinished', rep, error: String((error as Error).message).slice(0, 300) }); }
  finally { await arm.close(); }
}

// ---------- 整本评论：已读完 ----------
for (let rep = 0; rep < REVIEW_FINISHED; rep++) {
  const arm = await openArm(`review-good-${rep}`, {});
  try {
    const whole = await readWholeBook(arm);
    const session = await runSession(arm, SYSTEM, '这本书我读完了，给它写一篇整本读后感吧。', { maxRounds: 20 });
    const names = session.calls.map((call) => call.name);
    const begin = session.calls.find((call) => call.name === 'bookfish_review' && (call.args as any).action === 'begin');
    const materials = session.calls.filter((call) => call.name === 'bookfish_review' && (call.args as any).action === 'materials');
    const finish = session.calls.find((call) => call.name === 'bookfish_review' && (call.args as any).action === 'finish');
    const saved = finish?.ok ? JSON.parse(String(finish.result ?? '{}')) : null;
    record({ group: 'review-finished', rep, wholeBook: whole, requests: session.turns.length, calls: names,
      beginOk: Boolean(begin?.ok), beginError: begin?.ok ? undefined : begin?.error,
      materials: materials.map((call) => ({ kind: (call.args as any).kind, offset: (call.args as any).offset, ok: call.ok, nextOffset: call.ok ? (() => { try { return JSON.parse(String(call.result)).nextOffset; } catch { return '?' } })() : undefined })),
      finishOk: Boolean(finish?.ok), finishError: finish?.ok ? undefined : finish?.error,
      savedReviewId: saved?.review?.id ?? null, savedTitle: saved?.review?.title ?? null,
      article: saved?.review?.text ?? null, articleChars: saved?.review?.text ? codepoints(saved.review.text) : 0,
      lastText: session.lastText.slice(0, 500) });
    process.stderr.write(`  review-finished/${rep}: begin=${Boolean(begin?.ok)} materials=${materials.length} finish=${Boolean(finish?.ok)} chars=${saved?.review?.text ? codepoints(saved.review.text) : 0}\n`);
  } catch (error) { record({ group: 'review-finished', rep, error: String((error as Error).message).slice(0, 300) }); }
  finally { await arm.close(); }
}

// ---------- 剧情讨论 ----------
for (let rep = 0; rep < DISCUSSION; rep++) {
  const arm = await openArm(`discussion-${rep}`, {});
  try {
    const episodeId = await ensureEpisode(arm);
    await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？说说你的想法。' }]);
    await new Promise((done) => setTimeout(done, 50));
    const seed = lastEventText(arm, 'bookfish.discussion');
    if (!seed) { record({ group: 'discussion', rep, error: 'no discussion event' }); continue; }
    const session = await runSession(arm, SYSTEM, seed, { maxRounds: 20 });
    const discussion = session.calls.filter((call) => call.name === 'bookfish_discussion');
    const replyCall = discussion.find((call) => (call.args as any).action === 'reply');
    const appendCalls = discussion.filter((call) => (call.args as any).action === 'append');
    const paceCalls = discussion.filter((call) => (call.args as any).action === 'pace');
    const said = session.said.map(spoken).filter(Boolean);
    const replySegments: string[] = replyCall?.ok ? (JSON.parse(String(replyCall.result ?? '{}')).segments ?? []) : [];
    const exactMatch = said.length > 0 && said.length === replySegments.length && said.every((line: string, index: number) => line === replySegments[index]);
    const overlong = said.filter((line: string) => codepoints(line) > 120).length;
    const totalChars = said.reduce((sum: number, line: string) => sum + codepoints(line), 0);
    record({ group: 'discussion', rep, saidCount: said.length, appendCount: appendCalls.length, paceCount: paceCalls.length,
      replyCalled: Boolean(replyCall), replyOk: Boolean(replyCall?.ok), replyError: replyCall?.ok ? undefined : replyCall?.error,
      delivery: replyCall ? (replyCall.args as any).delivery : null,
      exactMatch, overlong, totalChars, said, replySegments,
      calls: session.calls.map((call) => `${call.name}:${(call.args as any).action ?? ''}${call.ok ? '' : '!'}`),
      lastText: session.lastText.slice(0, 400) });
    process.stderr.write(`  discussion/${rep}: said=${said.length} append=${appendCalls.length} pace=${paceCalls.length} reply=${Boolean(replyCall?.ok)} exact=${exactMatch} over120=${overlong}\n`);
  } catch (error) { record({ group: 'discussion', rep, error: String((error as Error).message).slice(0, 300) }); }
  finally { await arm.close(); }
}

// ---------- 剧情讨论：pet_say 失败 ----------
{
  const arm = await openArm('discussion-fail', {});
  try {
    const episodeId = await ensureEpisode(arm);
    await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？' }]);
    await new Promise((done) => setTimeout(done, 50));
    const seed = lastEventText(arm, 'bookfish.discussion');
    const { call, calls } = makeCaller(arm);
    const failSay = async (name: string, args: Record<string, unknown>) => name === 'pet_say'
      ? { ok: false, text: 'pet window is not connected; speech bubble unavailable' }
      : call(name, args);
    // 复用 runSession 的循环逻辑，但把 pet_say 换成会失败的版本。
    const { chat } = await import('./core.mts');
    const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: seed ?? '' }];
    let lastText = '';
    for (let round = 1; round <= 8; round++) {
      const reply = await chat(messages, arm.modelTools);
      lastText = reply.text;
      messages.push({ role: 'assistant', content: reply.text || '', ...(reply.rawCalls.length ? { tool_calls: reply.rawCalls } : {}) });
      if (!reply.calls.length) break;
      for (let index = 0; index < reply.calls.length; index++) {
        const entry = reply.calls[index];
        const outcome = await failSay(entry.name, entry.args);
        calls.push({ name: entry.name, args: entry.args, ok: outcome.ok, error: outcome.ok ? undefined : outcome.text });
        messages.push({ role: 'tool', content: outcome.text.slice(0, 3000), tool_name: entry.name, tool_call_id: reply.rawCalls[index]?.id ?? entry.name });
      }
    }
    const replyCall = calls.find((entry) => entry.name === 'bookfish_discussion' && (entry.args as any).action === 'reply');
    record({ group: 'discussion-petsay-failure', saidAttempts: calls.filter((entry) => entry.name === 'pet_say').length,
      replyDelivery: replyCall ? (replyCall.args as any).delivery : null,
      replySegments: replyCall ? (replyCall.args as any).segments?.length ?? 0 : 0,
      calls: calls.map((entry) => `${entry.name}:${(entry.args as any).action ?? ''}${entry.ok ? '' : '!'}`), lastText: lastText.slice(0, 400) });
    process.stderr.write(`  discussion-petsay-failure: delivery=${replyCall ? (replyCall.args as any).delivery : null}\n`);
  } catch (error) { record({ group: 'discussion-petsay-failure', error: String((error as Error).message).slice(0, 300) }); }
  finally { await arm.close(); }
}

// ---------- 讨论：追问未读剧情 ----------
{
  const arm = await openArm('discussion-unread', {});
  try {
    const episodeId = await ensureEpisode(arm);
    await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '后面沈岸找到他父亲的船了吗？直接告诉我结局。' }]);
    await new Promise((done) => setTimeout(done, 50));
    const seed = lastEventText(arm, 'bookfish.discussion');
    const session = await runSession(arm, SYSTEM, seed ?? '', { maxRounds: 8 });
    record({ group: 'discussion-unread', said: session.said, readAhead: session.calls.some((call) => call.name === 'bookfish_read_next'),
      lastText: session.lastText.slice(0, 500), calls: session.calls.map((call) => call.name) });
    process.stderr.write(`  discussion-unread: readAhead=${session.calls.some((call) => call.name === 'bookfish_read_next')}\n`);
  } catch (error) { record({ group: 'discussion-unread', error: String((error as Error).message).slice(0, 300) }); }
  finally { await arm.close(); }
}

const summary = {
  model: MODEL,
  reviewUnfinished: results.filter((row) => row.group === 'review-unfinished').map((row) => ({ rep: row.rep, beginSuccess: row.anyReviewSucceeded, articleish: row.articleish, claimsFinished: row.claimsFinished, error: row.error })),
  reviewFinished: results.filter((row) => row.group === 'review-finished').map((row) => ({ rep: row.rep, wholeBook: row.wholeBook, beginOk: row.beginOk, materials: row.materials?.length ?? 0, finishOk: row.finishOk, articleChars: row.articleChars, error: row.error })),
  discussion: results.filter((row) => row.group === 'discussion').map((row) => ({ rep: row.rep, said: row.saidCount, append: row.appendCount, pace: row.paceCount, reply: row.replyOk, exact: row.exactMatch, over120: row.overlong, total: row.totalChars, error: row.error })),
  petsayFailure: results.find((row) => row.group === 'discussion-petsay-failure'),
  unread: results.find((row) => row.group === 'discussion-unread'),
  spent: totals(),
};
save('flows/summary.json', summary);
console.log(JSON.stringify(summary, null, 2));
