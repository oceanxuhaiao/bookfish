/**
 * BF-PROMPT-OPT-002 的真实模型实验内核。
 *
 * 与第一轮的 scripts/ab 相比有三点不同：
 *   1. 每一轮请求都记 Token、工具调用、参数、回执、错误与轮次，直接落盘；
 *   2. 事件文本可以按实验组改写（brief / guidance 变体），不改 World 代码；
 *   3. 工具回执可以按实验组改写（nextStep 消融），同样不改 World 代码。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE = resolve(import.meta.dirname, '..', '..');
export const OUT = process.env.AB_OUT ?? 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/prompt-refactor-003';
export const MODEL = process.env.AB_MODEL ?? 'deepseek-flash';
mkdirSync(OUT, { recursive: true });

export interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_name?: string; tool_call_id?: string; tool_calls?: any[] }

export function apiKey(): string {
  const text = readFileSync('E:/zcdfy/Coopanion/data/home/providers/deepseek/.env', 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '').trim();
  }
  throw new Error('DEEPSEEK_API_KEY not found');
}

const KEY = apiKey();
export const spent: Array<{ prompt: number; completion: number }> = [];

export async function chat(messages: Msg[], tools: any[], maxTokens = 4096) {
  const started = Date.now();
  const payload: Record<string, unknown> = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens, stream: false };
  if (tools.length) payload.tools = tools;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`deepseek ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const message = body.choices?.[0]?.message ?? {};
  spent.push({ prompt: Number(body.usage?.prompt_tokens ?? 0), completion: Number(body.usage?.completion_tokens ?? 0) });
  const calls = (message.tool_calls ?? []).map((call: any) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { args = { __raw: call.function?.arguments }; }
    return { id: String(call.id ?? ''), name: String(call.function?.name ?? ''), args };
  });
  return {
    text: String(message.content ?? ''), calls,
    rawCalls: (message.tool_calls ?? []) as any[],
    promptTokens: Number(body.usage?.prompt_tokens ?? 0), completionTokens: Number(body.usage?.completion_tokens ?? 0),
    elapsedMs: Date.now() - started,
  };
}

/** 一本足够短、可以整本确认完的合成书（用于整本评论）。 */
export const SHORT_BOOK = [
  '# 第一章 潮水线',
  '凌晨四点，沈岸把最后一箱书搬上渔船的甲板。他数了三遍箱子，还是少一只。老周在船尾说，别数了，你越数越少。'.repeat(3),
  '# 第二章 灯塔守夜人',
  '灯塔的守夜人姓黎，叫黎望，右眼坏了，看东西总偏左半寸。她给沈岸倒了杯热水，说今年的雾比往年早。'.repeat(3),
].join('\n');

export function shortBook() { return SHORT_BOOK; }

export interface Arm {
  name: string; world: any; ctx: any; host: any; tools: any[]; modelTools: any[]; scratch: string; bookKey: string;
  close(): Promise<void>;
}

export async function openArm(name: string, config: Record<string, unknown> = {}, book = SHORT_BOOK): Promise<Arm> {
  const { BOOKFISH } = await import(pathToFileURL(resolve(PACKAGE, 'src', 'definition.ts')).href);
  const schemas = await import(pathToFileURL(resolve(PACKAGE, 'src', 'tool-schemas.ts')).href);
  const { fakeWorldContext } = await import('cortico/extensions/dry-mount.ts');
  const { FakeHost } = await import(pathToFileURL(resolve(PACKAGE, 'tests', 'helpers', 'fake-host.ts')).href);
  const scratch = mkdtempSync(join(tmpdir(), `bookfish-002-${name}-`));
  const ctx = fakeWorldContext(BOOKFISH, { scratchDir: scratch });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1, sharingEnabled: false, storyMemoryEnabled: false, ...config });
  const world = BOOKFISH.create(ctx);
  const host = new FakeHost();
  await world.start(host);
  const invoke = world.webUi('zh').invoke;
  const imported = await invoke('status', 'import', [{ filename: 'short.txt', title: '潮水线', author: '测试作者', base64: Buffer.from(book, 'utf8').toString('base64') }]);
  await invoke('status', 'select', [imported.book.key]);
  const tools = world.tools();
  const modelTools = [
    ...(schemas.BOOKFISH_TOOL_DECLS as any[]).map((decl) => ({ type: 'function', function: { name: decl.name, description: decl.description, parameters: decl.parameters } })),
    { type: 'function', function: { name: 'pet_say', description: 'Say something in a speech bubble above the pet.', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
    { type: 'function', function: { name: 'end_turn', description: 'End this turn.', parameters: { type: 'object', properties: {}, required: [] } } },
  ];
  return {
    name, world, ctx, host, tools, modelTools, scratch, bookKey: imported.book.key,
    async close() {
      try { await world.stop(); } catch { /* 已停 */ }
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄 */ }
    },
  };
}

export interface CallLog { name: string; args: unknown; ok: boolean; error?: string; result?: string }

/** 一组工具调用的执行与记录。回执改写钩子用于 nextStep 消融。 */
export function makeCaller(arm: Arm, options: { dropNextStep?: boolean } = {}) {
  const calls: CallLog[] = [];
  const said: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === 'pet_say') { said.push(String(args.script ?? '')); calls.push({ name, args, ok: true }); return { ok: true, text: JSON.stringify({ accepted: true }) }; }
    if (name === 'end_turn') { calls.push({ name, args, ok: true }); return { ok: true, text: JSON.stringify({ ended: true }) }; }
    const decl = arm.tools.find((entry: any) => entry.name === name);
    if (!decl) { calls.push({ name, args, ok: false, error: 'unknown tool' }); return { ok: false, text: 'Unknown tool' }; }
    try {
      let text = await decl.handler(args, {}) as string;
      if (options.dropNextStep) {
        try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && 'nextStep' in parsed) { delete parsed.nextStep; text = JSON.stringify(parsed); } } catch { /* 非 JSON 原样返回 */ }
      }
      calls.push({ name, args, ok: true, result: text.slice(0, 400) });
      return { ok: true, text };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      calls.push({ name, args, ok: false, error: message.slice(0, 300) });
      return { ok: false, text: message };
    }
  };
  return { call, calls, said };
}

export interface Turn { round: number; promptTokens: number; completionTokens: number; calls: string[]; text: string }

/**
 * 跑一次会话。`rewriteEvent` 用来做 brief / guidance 变体；`dropNextStep` 用来做消融。
 */
export async function runSession(arm: Arm, system: string, seed: string, options: {
  maxRounds?: number; dropNextStep?: boolean; onSettle?: () => void;
} = {}) {
  const { call, calls, said } = makeCaller(arm, { dropNextStep: options.dropNextStep });
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: seed }];
  const turns: Turn[] = [];
  let lastText = '';
  for (let round = 1; round <= (options.maxRounds ?? 6); round++) {
    let result;
    try { result = await chat(messages, arm.modelTools); }
    catch (error) { turns.push({ round, promptTokens: 0, completionTokens: 0, calls: [], text: `ERROR ${String((error as Error).message).slice(0, 200)}` }); break; }
    turns.push({ round, promptTokens: result.promptTokens, completionTokens: result.completionTokens, calls: result.calls.map((entry) => entry.name), text: result.text.slice(0, 600) });
    lastText = result.text;
    messages.push({ role: 'assistant', content: result.text || '', ...(result.rawCalls.length ? { tool_calls: result.rawCalls } : {}) });
    if (!result.calls.length) break;
    for (let index = 0; index < result.calls.length; index++) {
      const entry = result.calls[index];
      const outcome = await call(entry.name, entry.args);
      messages.push({ role: 'tool', content: outcome.text.slice(0, 6000), tool_name: entry.name, tool_call_id: result.rawCalls[index]?.id ?? entry.name });
    }
    options.onSettle?.();
    if (result.calls.some((entry) => entry.name === 'end_turn')) break;
  }
  return { turns, calls, said, lastText };
}

/** 世界自己写的事件文本（brief / discussion guidance / 机会文本）。 */
export function lastEventText(arm: Arm, type: string): string | null {
  const events = (arm.host.events as any[]).filter((event) => event.type === type);
  const last = events[events.length - 1];
  if (!last) return null;
  const text = typeof last.render === 'function' ? last.render() : last.text;
  return typeof text === 'string' ? text : null;
}

export async function ensureEpisode(arm: Arm) {
  const page = async () => (await arm.world.webUi('zh').invoke('status', 'journal', [{ bookKey: arm.bookKey }]))?.items ?? [];
  const existing = await page();
  if (existing.length) return existing[0].id as string;
  const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
  const read = JSON.parse(await arm.world.tools().find((t: any) => t.name === 'bookfish_read_next').handler({ opportunityId: request.opportunityId }, {}) as string);
  const segment = read.segment;
  const quote = Array.from(segment.text as string).slice(0, 20).join('');
  const confirmed = await arm.world.tools().find((t: any) => t.name === 'bookfish_finish_reading').handler({
    opportunityId: request.opportunityId, bookKey: read.bookKey, taskId: read.taskId, segmentId: read.segmentId,
    understanding: '沈岸去灯塔找一个七年前留下的木箱。',
    episode: { trigger: '黎望说七年前也有人问过同一只木箱', interpretation: '他在追一条连自己都说不清的线。', evidence: [{ segmentId: read.segmentId, quote }] },
  }, {}) as string;
  const parsed = JSON.parse(confirmed);
  if (!parsed.receipt) throw new Error(`episode 创建失败: ${confirmed.slice(0, 200)}`);
  const after = await page();
  return after[0].id as string;
}

/** 把整本书读完（用于整本评论的"已读完"场景）。 */
export async function readWholeBook(arm: Arm) {
  const read = arm.world.tools().find((t: any) => t.name === 'bookfish_read_next');
  const finish = arm.world.tools().find((t: any) => t.name === 'bookfish_finish_reading');
  for (let guard = 0; guard < 40; guard++) {
    const request = await arm.world.webUi('zh').invoke('status', 'read_now', [arm.bookKey]);
    const result = JSON.parse(await read.handler({ opportunityId: request.opportunityId, segments: 4 }, {}) as string);
    if (result.complete) return { complete: true, segments: result.confirmedSegments ?? null };
    const confirmations = result.segments.map((item: any) => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' }));
    await finish.handler({ opportunityId: request.opportunityId, confirmations }, {});
    const status = await arm.world.webUi('zh').invoke('status', 'get', []);
    if (status.books?.[0]?.complete) return { complete: true };
  }
  return { complete: false };
}

export function save(name: string, payload: unknown) {
  const target = join(OUT, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 2));
}

export function totals() {
  return { requests: spent.length, prompt: spent.reduce((sum, row) => sum + row.prompt, 0), completion: spent.reduce((sum, row) => sum + row.completion, 0) };
}
