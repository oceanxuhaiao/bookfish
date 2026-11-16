/**
 * Gate 2 回答层实测（v2）。
 * 数据用 library 直接种，避免工具层的回合/租约干扰；回答既取正文也取 pet_say 台词。
 *   GROUP=retrieval|journal
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, chat, save, totals, MODEL } from '../ab2/core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;
const GROUP = process.env.GROUP ?? 'retrieval';
const results: any[] = [];
const record = (row: any) => { results.push(row); save(`gate2/${GROUP}-v2.json`, results); };

const BOOK = '黎望把灯芯剪短了一点。' + '风从东边来。'.repeat(30) + '沈岸把木箱搬到灯塔下面。' + '雾散了。'.repeat(20);

function lib(arm: any) { return (arm.world as any).library; }

/** 读一段（不写手账），返回 segmentId 与其真实文本。 */
function readOne(arm: any) {
  const library = lib(arm);
  const batch = library.readNext(1);
  const item = batch.segments[0];
  library.finish({ taskId: item.taskId, bookKey: arm.bookKey, segmentId: item.segmentId, understanding: '黎望在雾里剪了灯芯。' });
  const text = String(item.segment.text);
  return { segmentId: item.segmentId as number, text, quote: Array.from(text).slice(0, 18).join('') };
}

function addEpisode(arm: any, reading: { segmentId: number; quote: string }, interpretation: string, revises?: string) {
  const library = lib(arm);
  return library.reflect({
    bookKey: arm.bookKey,
    requestId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...(revises ? { revises } : {}),
    episode: { trigger: '读到这里的时候', interpretation, evidence: [{ segmentId: reading.segmentId, quote: reading.quote }] },
  });
}

async function ask(arm: any, question: string, variant: 'with' | 'without') {
  const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }];
  const calls: any[] = [];
  const spoken: string[] = [];
  let text = '';
  let promptTokens = 0;
  let rounds = 0;
  for (let round = 1; round <= 12; round++) {
    const reply = await chat(messages, arm.modelTools, 1200);
    rounds = round;
    promptTokens += reply.promptTokens;
    if (reply.text) text = reply.text;
    messages.push({ role: 'assistant', content: reply.text || '', ...(reply.rawCalls.length ? { tool_calls: reply.rawCalls } : {}) });
    if (!reply.calls.length) break;
    for (let index = 0; index < reply.calls.length; index++) {
      const entry = reply.calls[index];
      let output = '';
      let ok = true;
      let error: string | undefined;
      if (entry.name === 'pet_say') { spoken.push(String((entry.args as any).script ?? '')); output = '{"accepted":true}'; }
      else if (entry.name === 'end_turn') output = '{"ended":true}';
      else {
        const decl = arm.world.tools().find((t: any) => t.name === entry.name);
        try { output = await decl.handler(entry.args, {}) as string; }
        catch (caught) { ok = false; error = String((caught as Error)?.message ?? caught); output = error; }
        if (variant === 'without' && entry.name === 'bookfish_lookup' && ok) {
          try { const parsed = JSON.parse(output); if (parsed && 'nextStep' in parsed) { delete parsed.nextStep; output = JSON.stringify(parsed); } } catch { /* 非 JSON */ }
        }
      }
      calls.push({ name: entry.name, args: entry.args, ok, error });
      messages.push({ role: 'tool', content: String(output).slice(0, 8000), tool_name: entry.name, tool_call_id: reply.rawCalls[index]?.id ?? entry.name });
    }
    if (reply.calls.some((entry) => entry.name === 'end_turn')) break;
  }
  const answer = [text, ...spoken].filter(Boolean).join('\n');
  return { answer, calls, rounds, promptTokens };
}

if (GROUP === 'retrieval') {
  const FIXTURES: Array<{ id: string; seed: (arm: any) => void; question: string }> = [
    { id: 'A', seed: (arm) => { const reading = readOne(arm); addEpisode(arm, reading, '她不是在等人，是在守夜。'); }, question: '你读到灯塔那一段时是怎么想的？' },
    { id: 'B', seed: (arm) => { readOne(arm); }, question: '你对黎望守夜的看法是什么？这是你读的时候的想法吗？' },
    { id: 'C', seed: (arm) => { const reading = readOne(arm); const first = addEpisode(arm, reading, '她在守夜。'); addEpisode(arm, reading, '不是守夜，是在等一艘不会来的船。', first.id); }, question: '你之前说黎望在守夜，现在还是这个看法吗？' },
    { id: 'D', seed: (arm) => { readOne(arm); }, question: '你当时读到灯塔那一段，对黎望有什么感觉？' },
    { id: 'E', seed: (arm) => { const reading = readOne(arm); const first = addEpisode(arm, reading, '她在守夜。'); addEpisode(arm, reading, '守夜的人也需要有人记得她。'); }, question: '你对黎望守夜的看法，前后有变化吗？' },
  ];
  const only = (process.env.ONLY ?? '').split(',').filter(Boolean);
  for (const variant of ['with', 'without'] as const) {
    for (const fixture of FIXTURES) {
      if (only.length && !only.includes(fixture.id)) continue;
      const arm = await openArm(`g2-${fixture.id}-${variant}`, {}, BOOK);
      try {
        fixture.seed(arm);
        const session = await ask(arm, fixture.question, variant);
        const lookup = session.calls.filter((call) => call.name === 'bookfish_lookup');
        record({ fixture: fixture.id, variant, question: fixture.question, answer: session.answer,
          rounds: session.rounds, promptTokens: session.promptTokens,
          lookupCalls: lookup.length, lookupFailed: lookup.filter((call) => !call.ok).length,
          searchCalls: lookup.filter((call) => String((call.args as any).action) === 'search').length,
          calls: session.calls.map((call) => `${call.name}:${(call.args as any).action ?? ''}${call.ok ? '' : '!'}`) });
        process.stderr.write(`  ${fixture.id}/${variant}: rounds=${session.rounds} lookup=${lookup.length} failed=${lookup.filter((c) => !c.ok).length} answer=${session.answer.length}\n`);
      } catch (error) { record({ fixture: fixture.id, variant, error: String((error as Error).message).slice(0, 240) }); }
      finally { await arm.close(); }
    }
  }
  save('gate2/retrieval-spent.json', totals());
  console.log(JSON.stringify({ group: 'retrieval', rows: results.length, spent: totals() }, null, 2));
}

if (GROUP === 'journal') {
  const state = (arm: any) => ((arm.world.webUi('zh').invoke('status', 'journal', [{ bookKey: arm.bookKey }])) as any);
  for (let index = 1; index <= 5; index++) {
    const arm = await openArm(`g2-j${index}`, {}, BOOK);
    try {
      const session = await ask(arm, '读下一段吧。如果有想记的，就在确认时一起记进手账：写下触发的事和你的解读，再引用原文里的一句话作为证据。', 'with');
      const page = await state(arm);
      const saved = page.items?.[0] ?? null;
      record({ case: `J${index}`, answer: session.answer, calls: session.calls.map((call) => `${call.name}${call.ok ? '' : '!'}`),
        saved: saved ? { kind: saved.kind, segmentIds: (saved.content?.evidence ?? []).map((e: any) => e.segmentId), quote: (saved.content?.evidence ?? [])[0]?.quote ?? null } : null,
        claimsSaved: /(已经?|已)保存|记好了|写进手账|存好了|记进去了/.test(session.answer), promptTokens: session.promptTokens });
      process.stderr.write(`  J${index}: saved=${saved?.kind ?? 'none'} claims=${/(已经?|已)保存|记好了|记进去了/.test(session.answer)}\n`);
    } catch (error) { record({ case: `J${index}`, error: String((error as Error).message).slice(0, 240) }); }
    finally { await arm.close(); }
  }
  for (let index = 6; index <= 7; index++) {
    const arm = await openArm(`g2-j${index}`, {}, BOOK);
    try {
      const reading = readOne(arm);
      const original = addEpisode(arm, reading, '她不是在等人，是在守夜。');
      const session = await ask(arm, '刚才那条手账其实不是读的时候想到的，是后来才想到的。按正确的方式改一下。', 'with');
      const page = await state(arm);
      const items = page.items ?? [];
      const created = items.find((entry: any) => entry.id !== original.id) ?? null;
      const still = items.find((entry: any) => entry.id === original.id) ?? null;
      record({ case: `J${index}`, answer: session.answer, calls: session.calls.map((call) => `${call.name}${call.ok ? '' : '!'}`),
        created: created ? { kind: created.kind, revises: created.revises ?? null } : null,
        originalKind: still?.kind ?? null, historyRewritten: still ? still.kind !== 'reflection' : null,
        claimsSaved: /(已经?|已)保存|改好了|记好了/.test(session.answer), promptTokens: session.promptTokens });
      process.stderr.write(`  J${index}: created=${created?.kind ?? 'none'} revises=${created?.revises ? 'yes' : 'no'} original=${still?.kind}\n`);
    } catch (error) { record({ case: `J${index}`, error: String((error as Error).message).slice(0, 240) }); }
    finally { await arm.close(); }
  }
  {
    const arm = await openArm('g2-j8', {}, BOOK);
    try {
      readOne(arm);
      const session = await ask(arm, '这一段我没什么想记的，不用写手账。', 'with');
      const page = await state(arm);
      record({ case: 'J8', answer: session.answer, calls: session.calls.map((call) => `${call.name}${call.ok ? '' : '!'}`),
        records: (page.items ?? []).length, claimsSaved: /(已经?|已)保存|记好了|写进手账/.test(session.answer), promptTokens: session.promptTokens });
      process.stderr.write(`  J8: records=${(page.items ?? []).length} claims=${/(已经?|已)保存/.test(session.answer)}\n`);
    } catch (error) { record({ case: 'J8', error: String((error as Error).message).slice(0, 240) }); }
    finally { await arm.close(); }
  }
  save('gate2/journal-spent.json', totals());
  console.log(JSON.stringify({ group: 'journal', rows: results.length, spent: totals() }, null, 2));
}
