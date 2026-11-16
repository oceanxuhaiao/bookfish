/**
 * 第三轮：Help 触发、讨论默认轮次、分享链路三组回归。
 *   GROUP=help|discussion|sharing
 * 预算见 docs/prompt-refactor-003/模型实验预算计划.md
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, runSession, ensureEpisode, lastEventText, save, totals, MODEL } from '../ab2/core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;
const GROUP = process.env.GROUP ?? 'help';
const results: any[] = [];
const record = (row: any) => { results.push(row); save(`${GROUP}.json`, results); };

const spoken = (value: string) => value.replace(/【[^】]{1,40}】/gu, '').replace(/<[^>]{1,40}>/gu, '').trim();
const helpCalls = (calls: any[]) => calls.filter((call) => call.name === 'bookfish_help').map((call) => String((call.args as any).topic ?? ''));

if (GROUP === 'help') {
  const plan: Array<{ topic: string; reps: number; ask: (arm: any) => Promise<string> | string }> = [
    { topic: 'journal', reps: 5, ask: '把这段读进手账吧：写清触发的事件和你的解读，再引用原文里的一句话作为证据。' },
    { topic: 'retrieval', reps: 5, ask: '你之前读到灯塔那一段时，是怎么想的？' },
    { topic: 'sharing', reps: 5, ask: '把刚才读到的感想挑一条分享出去吧。' },
    { topic: 'review', reps: 3, ask: '给这本书写一篇整本读后感，保存下来。' },
    { topic: 'selection', reps: 3, ask: '书架快读完了，你自己去找一本新书看看吧。' },
    { topic: 'reading', reps: 3, ask: async () => '' },
    { topic: 'discussion', reps: 3, ask: async (arm) => {
        const episodeId = await ensureEpisode(arm);
        await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？' }]);
        await new Promise((done) => setTimeout(done, 50));
        return lastEventText(arm, 'bookfish.discussion') ?? '';
      } },
  ];
  // 普通聊天 10 次
  for (let index = 0; index < 10; index++) {
    const arm = await openArm(`h-chat-${index}`, {});
    try {
      const session = await runSession(arm, SYSTEM, ['今天下雨，我有点困。', '你在干嘛？', '晚上吃点什么好呢。', '陪我聊两句。', '猫和狗哪个更好？', '记一下明天买牛奶。', '外面好吵。', '今天好累。', '讲个冷笑话。', '我准备睡了，晚安。'][index], { maxRounds: 3 });
      record({ group: 'chat', index, help: helpCalls(session.calls), bookfish: session.calls.filter((call) => call.name.startsWith('bookfish_')).length });
    } finally { await arm.close(); }
  }
  for (const spec of plan) {
    for (let rep = 0; rep < spec.reps; rep++) {
      const arm = await openArm(`h-${spec.topic}-${rep}`, { autonomousAcquisition: true, automaticSharing: true });
      try {
        let seed = typeof spec.ask === 'function' ? await spec.ask(arm) : spec.ask;
        if (spec.topic === 'reading') {
          const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
          seed = lastEventText(arm, 'bookfish.reading_opportunity') ?? '';
          if (!request?.opportunityId) throw new Error('no opportunity');
        }
        if (!seed) { record({ group: 'topic', topic: spec.topic, rep, error: 'no seed' }); continue; }
        const session = await runSession(arm, SYSTEM, seed, { maxRounds: 16 });
        const help = helpCalls(session.calls);
        record({ group: 'topic', topic: spec.topic, rep, help, right: help.filter((topic) => topic === spec.topic).length,
          wrong: help.filter((topic) => topic !== spec.topic), calls: session.calls.map((call) => `${call.name}${call.ok ? '' : '!'}`),
          protocolHintSeen: session.calls.some((call) => JSON.stringify(call.result ?? '').includes('protocolHint')) });
      } catch (error) { record({ group: 'topic', topic: spec.topic, rep, error: String((error as Error).message).slice(0, 200) }); }
      finally { await arm.close(); }
    }
  }
  // 上下文重置 3 次（每次全新 arm，同一任务）
  for (let rep = 0; rep < 3; rep++) {
    const arm = await openArm(`h-reset-${rep}`, {});
    try {
      const session = await runSession(arm, SYSTEM, '你之前读到灯塔那一段时，是怎么想的？', { maxRounds: 6 });
      record({ group: 'reset', rep, help: helpCalls(session.calls) });
    } finally { await arm.close(); }
  }
  const summary = {
    model: MODEL,
    chatHelpCalls: results.filter((row) => row.group === 'chat').reduce((sum, row) => sum + (row.help?.length ?? 0), 0),
    topics: [...new Set(results.filter((row) => row.group === 'topic').map((row) => row.topic))].map((topic) => {
      const rows = results.filter((row) => row.group === 'topic' && row.topic === topic);
      return { topic, runs: rows.length,
        helpRuns: rows.filter((row) => (row.help?.length ?? 0) > 0).length,
        rightRuns: rows.filter((row) => (row.right ?? 0) > 0).length,
        wrongRuns: rows.filter((row) => (row.wrong?.length ?? 0) > 0).length,
        hintRuns: rows.filter((row) => row.protocolHintSeen).length,
        wroteRuns: rows.filter((row) => (row.calls ?? []).some((name) => name.startsWith('bookfish_record_reflection') || name.startsWith('bookfish_finish_reading'))).length };
    }),
    reset: results.filter((row) => row.group === 'reset').map((row) => row.help),
    spent: totals(),
  };
  save('help/summary.json', summary);
  console.log(JSON.stringify(summary, null, 2));
}

if (GROUP === 'discussion') {
  const ROUNDS = Number(process.env.DISC_ROUNDS ?? 12);
  for (let rep = 0; rep < 5; rep++) {
    const arm = await openArm(`d-${rep}`, {});
    try {
      const episodeId = await ensureEpisode(arm);
      await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？说说你的想法。' }]);
      await new Promise((done) => setTimeout(done, 50));
      const seed = lastEventText(arm, 'bookfish.discussion');
      const session = await runSession(arm, SYSTEM, seed ?? '', { maxRounds: ROUNDS });
      const talk = session.calls.filter((call) => call.name === 'bookfish_discussion');
      const reply = talk.find((call) => (call.args as any).action === 'reply');
      const said = session.said.map(spoken).filter(Boolean);
      const segments: string[] = reply?.ok ? (JSON.parse(String(reply.result ?? '{}')).segments ?? []) : [];
      record({ rep, rounds: ROUNDS, said: said.length,
        append: talk.filter((call) => (call.args as any).action === 'append').length,
        pace: talk.filter((call) => (call.args as any).action === 'pace').length,
        replyOk: Boolean(reply?.ok), exact: said.length > 0 && said.length === segments.length && said.every((line, index) => line === segments[index]),
        over120: said.filter((line) => Array.from(line).length > 120).length,
        total: said.reduce((sum, line) => sum + Array.from(line).length, 0),
        promptTokens: session.turns.reduce((sum, turn) => sum + turn.promptTokens, 0),
        calls: session.calls.map((call) => `${call.name}:${(call.args as any).action ?? ''}${call.ok ? '' : '!'}`) });
      process.stderr.write(`  d/${rep}: said=${said.length} reply=${Boolean(reply?.ok)} exact=${said.length > 0 && said.length === segments.length}\n`);
    } catch (error) { record({ rep, error: String((error as Error).message).slice(0, 200) }); }
    finally { await arm.close(); }
  }
  const rows = results.filter((row) => !row.error);
  save('discussion/summary.json', { model: MODEL, rounds: Number(process.env.DISC_ROUNDS ?? 12), runs: rows.length,
    replyOk: rows.filter((row) => row.replyOk).length, exact: rows.filter((row) => row.exact).length, spent: totals() });
  console.log(JSON.stringify({ runs: rows.length, replyOk: rows.filter((row) => row.replyOk).length, exact: rows.filter((row) => row.exact).length, spent: totals() }, null, 2));
}

if (GROUP === 'sharing') {
  // 真实 share_opportunity：开启自动分享、造候选、进入 idle，等 sharing 模块自己投递。
  for (let rep = 0; rep < 5; rep++) {
    const arm = await openArm(`s-${rep}`, { automaticSharing: true, shareCooldownMinutes: 1 });
    try {
      const episodeId = await ensureEpisode(arm);
      const proposed = await arm.world.tools().find((t: any) => t.name === 'bookfish_share')
        .handler({ action: 'propose', episodeId, text: '这一段我读得很慢，像在等一个人开口。' }, {});
      const parsed = JSON.parse(proposed as string);
      // 触发 sharing 的机会投递：进入 idle 并等它自己的计时器。
      arm.world.onRunPhase({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      let event: string | null = null;
      for (let wait = 0; wait < 45; wait++) {
        await new Promise((done) => setTimeout(done, 1000));
        event = lastEventText(arm, 'bookfish.share_opportunity');
        if (event) break;
      }
      if (!event) { record({ rep, proposed: Boolean(parsed.shareId ?? parsed.id), error: 'no share_opportunity within 45s' }); continue; }
      const session = await runSession(arm, SYSTEM, event, { maxRounds: 10 });
      const names = session.calls.map((call) => call.name);
      const claim = session.calls.find((call) => call.name === 'bookfish_claim_share');
      const report = session.calls.find((call) => call.name === 'bookfish_share' && (call.args as any).action === 'report');
      record({ rep, proposed: true, claimCalls: names.filter((name) => name === 'bookfish_claim_share').length,
        claimOk: Boolean(claim?.ok), saidCount: session.said.length,
        reportOutcome: report ? (report.args as any).outcome : null,
        claimBeforeSay: claim ? names.indexOf('bookfish_claim_share') < names.indexOf('pet_say') : null,
        outputsBeforeClaim: names.indexOf('pet_say') >= 0 && names.indexOf('pet_say') < names.indexOf('bookfish_claim_share'),
        calls: names });
      process.stderr.write(`  s/${rep}: claim=${Boolean(claim?.ok)} said=${session.said.length} outcome=${report ? (report.args as any).outcome : null}\n`);
    } catch (error) { record({ rep, error: String((error as Error).message).slice(0, 240) }); }
    finally { await arm.close(); }
  }
  const rows = results.filter((row) => !row.error);
  save('sharing/summary.json', { model: MODEL, runs: rows.length,
    claimOk: rows.filter((row) => row.claimOk).length,
    claimBeforeSay: rows.filter((row) => row.claimBeforeSay === true).length,
    outputsBeforeClaim: rows.filter((row) => row.outputsBeforeClaim).length,
    reportedAccepted: rows.filter((row) => row.reportOutcome === 'accepted').length,
    spent: totals() });
  console.log(JSON.stringify({ runs: rows.length, claimOk: rows.filter((row) => row.claimOk).length,
    claimBeforeSay: rows.filter((row) => row.claimBeforeSay).length,
    outputsBeforeClaim: rows.filter((row) => row.outputsBeforeClaim).length, spent: totals() }, null, 2));
}
