/**
 * 阶段 2 / P02：bookfish_help 的真实模型按需加载验证。
 *
 * 八个主题各跑若干次，另加普通聊天、同任务重复、上下文重置、Help 失败四组对照。
 * 判据只看模型实际调用了什么，不看它说了什么。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, runSession, lastEventText, ensureEpisode, save, totals, MODEL, OUT, chat, makeCaller } from './core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const context = await armContext({ srcDir: resolve(PACKAGE, 'src') });
const SYSTEM = context.system as string;

const REPEAT = Number(process.env.HELP_REPS ?? 3);
const DEEP_REPS = Number(process.env.HELP_DEEP ?? 5);

type Spec = { topic: string; asked: string; seed?: (arm: any) => Promise<string>; expectTools: string[] };

const SPECS: Spec[] = [
  { topic: 'reading', asked: '读一段给我听听吧，就从现在的位置继续。', seed: async (arm) => (await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey])).opportunityId ? (lastEventText(arm, 'bookfish.reading_opportunity') ?? '') : '', expectTools: ['bookfish_read_next'] },
  { topic: 'journal', asked: '你刚读的那段，有什么值得记下来的吗？想记就写一条。', expectTools: ['bookfish_record_reflection', 'bookfish_finish_reading'] },
  { topic: 'retrieval', asked: '你之前读到灯塔那一段时，是怎么想的？', expectTools: ['bookfish_lookup'] },
  { topic: 'sharing', asked: '把你刚才读到的感想挑一条分享出去吧。', expectTools: ['bookfish_share', 'bookfish_claim_share'] },
  { topic: 'review', asked: '给这本书写一篇整本读后感，保存下来。', expectTools: ['bookfish_review'] },
  { topic: 'selection', asked: '书架快读完了，你自己去找一本新书看看吧。', expectTools: ['bookfish_acquire', 'bookfish_select_book'] },
  { topic: 'discussion', asked: '', seed: async (arm) => {
      const episodeId = await ensureEpisode(arm);
      await arm.world.webUi('zh').invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？说说你的想法。' }]);
      await new Promise((done) => setTimeout(done, 50));
      return lastEventText(arm, 'bookfish.discussion') ?? '';
    }, expectTools: ['pet_say', 'bookfish_discussion'] },
  { topic: 'story', asked: '这本书里出现过哪些人物？你还记得他们的关系吗？', expectTools: ['bookfish_lookup'] },
];

const results: any[] = [];
function record(row: any) { results.push(row); save('help-ab/raw.json', results); }

function judge(topic: string, calls: any[], expectTools: string[]) {
  const helpCalls = calls.filter((call) => call.name === 'bookfish_help');
  const topics = helpCalls.map((call) => String((call.args as any).topic ?? ''));
  const followUp = calls.filter((call) => call.name !== 'bookfish_help' && call.name !== 'end_turn').map((call) => call.name);
  return {
    helpCalls: helpCalls.length,
    topics,
    rightTopic: topics.filter((value) => value === topic).length,
    wrongTopics: topics.filter((value) => value !== topic),
    helpFailed: helpCalls.filter((call) => !call.ok).length,
    followUp,
    followUpHit: expectTools.some((name) => followUp.includes(name)),
    rounds: calls.length,
  };
}

async function oneRun(spec: Spec, label: string) {
  const arm = await openArm(`help-${spec.topic}-${label}`, { autonomousAcquisition: true, automaticSharing: true });
  try {
    const seed = spec.seed ? await spec.seed(arm) : spec.asked;
    if (!seed) return { topic: spec.topic, label, error: 'no event text' };
    const session = await runSession(arm, SYSTEM, seed, { maxRounds: 6 });
    const verdict = judge(spec.topic, session.calls, spec.expectTools);
    const row = { topic: spec.topic, label, seed: seed.slice(0, 400), ...verdict, turns: session.turns.length,
      promptTokens: session.turns.reduce((sum, turn) => sum + turn.promptTokens, 0),
      completionTokens: session.turns.reduce((sum, turn) => sum + turn.completionTokens, 0),
      calls: session.calls, said: session.said };
    process.stderr.write(`  ${spec.topic}/${label}: help=${verdict.helpCalls} topics=[${verdict.topics}] followUp=[${verdict.followUp}]\n`);
    return row;
  } finally { await arm.close(); }
}

// 场景 A：普通聊天 10 次，Help 无意义调用必须为 0。
const CHAT = [
  '今天下雨，我有点困。', '你在干嘛？', '晚上吃点什么好呢。', '我有点烦，陪我聊两句。',
  '你觉得猫和狗哪个更好？', '帮我记一下明天要买牛奶。', '外面好吵。', '今天工作好累。',
  '说个冷笑话吧。', '我准备睡了，晚安。',
];
for (let index = 0; index < CHAT.length; index++) {
  const arm = await openArm(`chat-${index}`, {});
  try {
    const session = await runSession(arm, SYSTEM, CHAT[index], { maxRounds: 3 });
    record({ group: 'chat', index, asked: CHAT[index], ...judge('__none__', session.calls, []),
      bookfishCalls: session.calls.filter((call) => call.name.startsWith('bookfish_')).length,
      promptTokens: session.turns[0]?.promptTokens ?? 0, calls: session.calls });
    process.stderr.write(`  chat/${index}: bookfish=${session.calls.filter((call) => call.name.startsWith('bookfish_')).length}\n`);
  } finally { await arm.close(); }
}

// 场景 B：八个主题。
for (const spec of SPECS) {
  const reps = ['reading', 'sharing', 'review', 'discussion'].includes(spec.topic) ? DEEP_REPS : REPEAT;
  for (let rep = 0; rep < reps; rep++) { try { record({ group: 'topic', ...(await oneRun(spec, `r${rep + 1}`)) }); } catch (error) { record({ group: 'topic', topic: spec.topic, rep, error: String((error as Error).message).slice(0, 300) }); } }
}

// 场景 C：同一任务重复——同一会话里连续两次问感想，第二次不应再取 journal。
{
  const arm = await openArm('help-repeat', {});
  try {
    const first = await runSession(arm, SYSTEM, '你刚读的那段，有什么想记下来的？', { maxRounds: 4 });
    const messages: any[] = [];
    const second = await (async () => {
      const { call, calls } = makeCaller(arm);
      // 在同一个上下文里追加第二轮：模拟"同一任务继续"。
      const seed = '那就把它记下来吧，用你刚才的想法。';
      const session = await runSession(arm, SYSTEM, `${first.lastText}\n\n用户：${seed}`, { maxRounds: 4 });
      return session;
    })();
    record({ group: 'repeat', firstHelp: first.calls.filter((call) => call.name === 'bookfish_help').length,
      secondHelp: second.calls.filter((call) => call.name === 'bookfish_help').length,
      firstCalls: first.calls.map((call) => call.name), secondCalls: second.calls.map((call) => call.name) });
    process.stderr.write(`  repeat: first=${first.calls.filter((call) => call.name === 'bookfish_help').length} second=${second.calls.filter((call) => call.name === 'bookfish_help').length}\n`);
  } finally { await arm.close(); }
}

// 场景 D：上下文重置——同一任务换一个全新会话，应当重新取协议。
{
  for (let rep = 0; rep < 2; rep++) {
    const arm = await openArm(`help-reset-${rep}`, {});
    try {
      const session = await runSession(arm, SYSTEM, '你之前读到灯塔那一段时，是怎么想的？', { maxRounds: 4 });
      record({ group: 'reset', rep, ...judge('retrieval', session.calls, ['bookfish_lookup']) });
      process.stderr.write(`  reset/${rep}: help=${session.calls.filter((call) => call.name === 'bookfish_help').length}\n`);
    } finally { await arm.close(); }
  }
}

// 场景 E：Help 读取失败——把 bookfish_help 变成永远报错，看模型会不会假装拿到了协议。
{
  for (let rep = 0; rep < 2; rep++) {
    const arm = await openArm(`help-fail-${rep}`, {});
    try {
      const { call, calls } = makeCaller(arm);
      const fake = async (name: string, args: Record<string, unknown>) => name === 'bookfish_help'
        ? { ok: false, text: 'Protocol document is temporarily unavailable' }
        : call(name, args);
      const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: '给这本书写一篇整本读后感，保存下来。' }];
      let lastText = '';
      for (let round = 1; round <= 4; round++) {
        const reply = await chat(messages, arm.modelTools);
        lastText = reply.text;
        messages.push({ role: 'assistant', content: reply.text || '', ...(reply.rawCalls.length ? { tool_calls: reply.rawCalls } : {}) });
        if (!reply.calls.length) break;
        for (let index = 0; index < reply.calls.length; index++) {
          const entry = reply.calls[index];
          const outcome = await fake(entry.name, entry.args);
          calls.push({ name: entry.name, args: entry.args, ok: outcome.ok, error: outcome.ok ? undefined : outcome.text });
          messages.push({ role: 'tool', content: outcome.text.slice(0, 3000), tool_name: entry.name, tool_call_id: reply.rawCalls[index]?.id ?? entry.name });
        }
      }
      const claims = /已经(获得|读到|加载).{0,6}协议|我已(经)?读(过|了).{0,4}(协议|规则)/.test(lastText);
      record({ group: 'help-failure', rep, calls, lastText: lastText.slice(0, 500), pretendedToHaveProtocol: claims,
        reviewAttempted: calls.some((call) => call.name === 'bookfish_review') });
      process.stderr.write(`  help-failure/${rep}: calls=[${calls.map((c) => c.name)}] pretended=${claims}\n`);
    } finally { await arm.close(); }
  }
}

const summary = {
  model: MODEL,
  system: SYSTEM.length,
  chat: { runs: results.filter((row) => row.group === 'chat').length,
    helpCalls: results.filter((row) => row.group === 'chat').reduce((sum, row) => sum + (row.helpCalls ?? 0), 0),
    bookfishCalls: results.filter((row) => row.group === 'chat').reduce((sum, row) => sum + (row.bookfishCalls ?? 0), 0) },
  topics: SPECS.map((spec) => {
    const rows = results.filter((row) => row.group === 'topic' && row.topic === spec.topic);
    return { topic: spec.topic, runs: rows.length,
      helpRuns: rows.filter((row) => (row.helpCalls ?? 0) > 0).length,
      rightTopicRuns: rows.filter((row) => (row.rightTopic ?? 0) > 0).length,
      wrongTopicRuns: rows.filter((row) => (row.wrongTopics?.length ?? 0) > 0).length,
      followUpRuns: rows.filter((row) => row.followUpHit).length,
      avgPrompt: Math.round(rows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0) / Math.max(1, rows.length)) };
  }),
  repeat: results.filter((row) => row.group === 'repeat'),
  reset: results.filter((row) => row.group === 'reset').map((row) => ({ rep: row.rep, helpCalls: row.helpCalls, topics: row.topics })),
  helpFailure: results.filter((row) => row.group === 'help-failure').map((row) => ({ rep: row.rep, pretended: row.pretendedToHaveProtocol, reviewAttempted: row.reviewAttempted })),
  spent: totals(),
};
save('help-ab/summary.json', summary);
save('help-ab/raw.json', results);
console.log(JSON.stringify(summary, null, 2));
