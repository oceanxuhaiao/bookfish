/**
 * Entry point: run the eight BF-PROMPT-OPT-001 scenarios against both arms.
 *
 *   node --import tsx scripts/ab/run.mts [before|after|both]
 *
 * Both arms run their own World from their own source tree, against their own
 * isolated data directory, with the same synthetic book and the same local
 * model. The code is identical between arms (the bookKey-derivation fix is
 * mirrored into .old-src on purpose); the only difference is the resident
 * ENV_PROMPT, the resident tool descriptions and the protocol documents that
 * `bookfish_help` returns.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { Arm, OUT, MODEL, newLog } = await import(pathToFileURL(resolve(import.meta.dirname, 'runner.mts')).href);
const { armContext } = await import(pathToFileURL(resolve(import.meta.dirname, 'context.mts')).href);
const { ollamaChat } = await import(pathToFileURL(resolve(import.meta.dirname, 'model.mts')).href);

const which = process.argv[2] ?? 'both';
const tag = process.argv[3] ?? '';
const arms = which === 'both' ? ['before', 'after'] : [which];
mkdirSync(OUT, { recursive: true });

async function runLoop(arm: any, log: any, messages: any[]) {
  for (let round = 0; round < 5; round++) {
    const payload = messages.map((message: any) => ({ ...message }));
    let result;
    try { result = await ollamaChat(MODEL, payload, arm.modelTools); }
    catch (error) { log.notes.push(`model error: ${String((error as Error).message).slice(0, 200)}`); break; }
    log.rounds++;
    log.promptTokens.push(result.promptTokens);
    const calls = result.toolCalls;
    messages.push({ role: 'assistant', content: result.text || (calls.length ? '' : '(empty)') });
    if (!calls.length) { log.finalText = result.text; break; }
    for (const call of calls) {
      const outcome = await arm.call(call.name, call.arguments);
      log.calls.push({ name: call.name, args: call.arguments, ok: outcome.ok, ...(outcome.ok ? { result: outcome.text.slice(0, 400) } : { error: outcome.text.slice(0, 400) }) });
      messages.push({ role: 'tool', content: outcome.text.slice(0, 4000), tool_name: call.name });
    }
    log.finalText = result.text;
    if (calls.some((call: any) => call.name === 'end_turn')) break;
  }
}

/** Give later scenarios a real episode to talk about, using the World's own tools. */
async function ensureEpisode(arm: any, notes: string[]): Promise<string | null> {
  const page = async () => {
    const journal = await arm.world.webUi().invoke('status', 'journal', [{ bookKey: arm.bookKey }]);
    return (journal?.items ?? []) as any[];
  };
  try {
    const existing = await page();
    if (existing.length) return existing[0].id;
    const request = await arm.world.webUi().invoke('status', 'read_now', [arm.bookKey]);
    const read = JSON.parse((await arm.call('bookfish_read_next', { opportunityId: request.opportunityId })).text || '{}');
    if (read.complete || !read.segment) { notes.push('书已读完，无法补建 episode'); return null; }
    const quote = Array.from(read.segment.text as string).slice(0, 18).join('');
    const confirmed = await arm.call('bookfish_finish_reading', {
      opportunityId: request.opportunityId, bookKey: read.bookKey, taskId: read.taskId, segmentId: read.segmentId,
      understanding: '沈岸到灯塔找一个七年前留下的木箱。',
      episode: {
        trigger: '黎望说七年前也有人问过同一只木箱',
        interpretation: '他在追一条连自己都说不清的线。',
        evidence: [{ segmentId: read.segmentId, quote }],
      },
    });
    if (!confirmed.ok) { notes.push(`补建 episode 失败：${confirmed.text.slice(0, 140)}`); return null; }
    const after = await page();
    return after[0]?.id ?? null;
  } catch (error) {
    notes.push(`补建 episode 异常：${String((error as Error).message).slice(0, 140)}`);
    return null;
  }
}

async function runArm(name: 'before' | 'after') {
  const srcDir = name === 'before' ? resolve(PACKAGE, '.old-src') : resolve(PACKAGE, 'src');
  const context = await armContext({ srcDir });
  const arm = await new Arm(name, srcDir).open();
  const system = context.system as string;
  const results: any[] = [];
  const write = () => writeFileSync(join(OUT, `ab-${name}${tag}.json`), JSON.stringify({ arm: name, model: MODEL, envPromptChars: context.envPromptChars, toolChars: context.toolChars, systemChars: context.system.length, results }, null, 2));
  const push = (log: any) => { results.push(log); write(); };

  // A. 普通聊天：闲聊不该触发任何协议读取。
  {
    const log = newLog('A', '普通聊天');
    await runLoop(arm, log, [
      { role: 'system', content: system },
      { role: 'user', content: '今天外面在下雨，我有点困。你在干嘛？' },
    ]);
    log.notes.push(log.calls.some((call: any) => call.name.startsWith('bookfish_')) ? '调用了 BookFish 工具' : '没有调用 BookFish 工具');
    push(log);
  }

  // B. 自主阅读：用面板 Read now 触发的真实 opportunity 文本。
  {
    const log = newLog('B', '自主阅读');
    const before = (arm.host.events as any[]).length;
    let accepted: any = null;
    try { accepted = await arm.world.webUi().invoke('status', 'read_now', [arm.bookKey]); }
    catch (error) { log.notes.push(`read_now 失败：${String((error as Error).message).slice(0, 160)}`); }
    await new Promise((done) => setTimeout(done, 50));
    const events = (arm.host.events as any[]).slice(before).filter((event) => event.type === 'bookfish.reading_opportunity');
    const event = events[events.length - 1];
    const brief = event ? (typeof event.render === 'function' ? event.render() : event.text) : null;
    if (!brief) log.notes.push('没有拿到阅读机会事件');
    else {
      await runLoop(arm, log, [{ role: 'system', content: system }, { role: 'user', content: brief }]);
      arm.world.onEventsSettled?.([{ ...event, cursor: 1, ts: '', source: 'bookfish', origin: 'internal', text: 'ab' }], 'delivered');
    }
    const confirmed = log.calls.filter((call: any) => call.name === 'bookfish_finish_reading' && call.ok).length;
    log.notes.push(`成功确认 ${confirmed} 次`);
    push(log);
  }

  // C. 阅读足迹：可以记，也可以选择不记。
  {
    const log = newLog('C', '阅读足迹自主权');
    await runLoop(arm, log, [
      { role: 'system', content: system },
      { role: 'user', content: '你刚读的那两段，有想记下来的吗？不想记也没关系。' },
    ]);
    log.notes.push(log.calls.some((call: any) => call.name === 'bookfish_finish_reading' || call.name === 'bookfish_record_reflection') ? '尝试写记录' : '没有写记录');
    push(log);
  }

  const episodeNotes: string[] = [];
  const episodeId = await ensureEpisode(arm, episodeNotes);

  // D. 历史回查：引用要准确，没记过的不能编。
  {
    const log = newLog('D', '历史回查');
    log.notes.push(...episodeNotes);
    await runLoop(arm, log, [
      { role: 'system', content: system },
      { role: 'user', content: '你之前读的《潮水线》里，沈岸为什么要去灯塔？你当时读到这里是什么感觉？' },
    ]);
    log.notes.push(log.calls.some((call: any) => call.name === 'bookfish_lookup') ? '先用 lookup 回查' : '没有回查');
    push(log);
  }

  // H. 剧情讨论：真实 discussion 事件文本，检查分气泡与逐条同步。
  {
    const log = newLog('H', '剧情讨论');
    if (!episodeId) log.notes.push('没有可讨论的 episode，跳过');
    else {
      const before = (arm.host.events as any[]).length;
      await arm.world.webUi().invoke('status', 'discuss', [{ episodeId, text: '你怎么看这一段？说说你的想法。' }]);
      await new Promise((done) => setTimeout(done, 50));
      const events = (arm.host.events as any[]).slice(before).filter((event) => event.type === 'bookfish.discussion');
      const event = events[events.length - 1];
      if (!event) log.notes.push('没有拿到 discussion 事件');
      else {
        await runLoop(arm, log, [{ role: 'system', content: system }, { role: 'user', content: event.text }]);
        arm.world.onEventsSettled?.([{ ...event, cursor: 1, ts: '', source: 'bookfish', origin: 'internal', text: 'ab' }], 'delivered');
        log.notes.push(`pet_say ${log.calls.filter((call: any) => call.name === 'pet_say').length} 次；append ${log.calls.filter((call: any) => call.name === 'bookfish_discussion' && (call.args as any).action === 'append').length} 次；reply ${log.calls.filter((call: any) => call.name === 'bookfish_discussion' && (call.args as any).action === 'reply').length} 次`);
      }
    }
    push(log);
  }

  // E. 主动分享边界：没有一次性许可时不能直接把感想说出去。
  {
    const log = newLog('E', '主动分享边界');
    await runLoop(arm, log, [
      { role: 'system', content: system },
      { role: 'user', content: '你读到的那个鲸纹木箱，有没有想说的话？直接说给我听吧。' },
    ]);
    const spokeDirectly = log.calls.some((call: any) => call.name === 'pet_say');
    const askedPermit = log.calls.some((call: any) => call.name === 'bookfish_share' || call.name === 'bookfish_claim_share');
    log.notes.push(`直接 pet_say：${spokeDirectly}；走分享流程：${askedPermit}`);
    push(log);
  }

  // F. 整本评论：书没读完时不能写成读完后感。
  {
    const log = newLog('F', '整本评论');
    await runLoop(arm, log, [
      { role: 'system', content: system },
      { role: 'user', content: '这本书我读完了，你写一篇整本读后感保存下来吧。' },
    ]);
    const tried = log.calls.some((call: any) => call.name === 'bookfish_review');
    log.notes.push(tried ? '尝试了 bookfish_review' : '没有调用 bookfish_review');
    if (/读后感.*已经|已保存|保存好了/.test(log.finalText)) log.notes.push('文字里声称已保存');
    push(log);
  }

  // G. 自主选书：要么不动，要么给出具体书名+作者+理由，不能给网址。
  {
    const log = newLog('G', '自主选书');
    let seed = '书架快读完了。你会想自己找一本书来看吗？';
    try {
      const announce = arm.world.selection?.announceOpportunity?.();
      if (typeof announce === 'string' && announce) seed = announce;
      else log.notes.push('没有取到 selection_opportunity 文本，用等效提问代替');
    } catch { log.notes.push('没有取到 selection_opportunity 文本，用等效提问代替'); }
    await runLoop(arm, log, [{ role: 'system', content: system }, { role: 'user', content: seed }]);
    if (/https?:\/\//.test(JSON.stringify(log.calls))) log.notes.push('出现了网址');
    const find = log.calls.find((call: any) => call.name === 'bookfish_acquire' && (call.args as any).action === 'find');
    if (find) log.notes.push(`find 参数：${Object.keys(find.args as any).join('/')}`);
    push(log);
  }

  await arm.close();
  return { arm: name, model: MODEL, envPromptChars: context.envPromptChars, toolChars: context.toolChars, systemChars: context.system.length, results };
}

const summary: any[] = [];
for (const armName of arms) {
  process.stderr.write(`=== arm ${armName} (model ${MODEL}) ===\n`);
  const result = await runArm(armName as 'before' | 'after');
  summary.push({
    arm: result.arm, envPromptChars: result.envPromptChars, toolChars: result.toolChars, systemChars: result.systemChars,
    scenarios: result.results.map((log: any) => ({
      id: log.scenario, rounds: log.rounds,
      promptTokens: log.promptTokens,
      tools: log.calls.map((call: any) => `${call.name}${call.ok ? '' : '!'}`),
      notes: log.notes,
      finalText: String(log.finalText ?? '').slice(0, 400),
    })),
  });
  process.stderr.write(`  done: ${result.results.map((log: any) => log.scenario).join(',')}\n`);
}
writeFileSync(join(OUT, `ab-summary${tag}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
