/**
 * Real-model A/B runner for BF-PROMPT-OPT-001.
 *
 * Both arms run the actual World from their own source tree, against an isolated
 * data directory and the same synthetic book, and talk to the same local model
 * with the same tool set. The only difference is the resident ENV_PROMPT (and
 * the tool descriptions in the resident schema).
 *
 * What it measures:
 *   - prompt tokens per request (the resident cost actually paid)
 *   - which tools the model chose, whether they succeeded, and how many rounds
 *   - whether the removed rules still hold in behaviour
 *
 * It never touches the live Coopanion deployment, a real bookshelf, or the
 * network.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const OUT = 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/prompt-refactor';
const MODEL = process.env.AB_MODEL ?? 'qwen3.5:9b';
const MAX_ROUNDS = Number(process.env.AB_ROUNDS ?? 5);

interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_name?: string }

const STORY = [
  '第一章 潮水线',
  '凌晨四点，沈岸把最后一箱书搬上渔船的甲板时，海面正泛着铁灰色的光。他数了三遍箱子，还是少一只。',
  '“别数了。”老周在船尾说，“你越数越少，海会笑你。”沈岸没接话，他从小就不信海会笑。',
  '他记得父亲最后一次出海也是这样，数箱子，数到天亮，然后船就再没回来。',
  '',
  '第二章 灯塔守夜人',
  '灯塔的守夜人姓黎，叫黎望，右眼坏了，看东西总偏左半寸。她给沈岸倒了杯热水，说今年的雾比往年早。',
  '沈岸问她见过一只刻着鲸纹的木箱没有。黎望想了很久，说她只记得有人在雾里问过一样的话，那是七年前。',
  '“七年前我父亲也来过？”沈岸问。黎望摇头：“我不知道那是谁。我只记得他把箱子留在灯塔下面，然后走了。”',
  '',
  '第三章 箱子里的声音',
  '灯塔下面的石缝里果然卡着一只木箱，鲸纹被盐蚀得只剩半边。箱子没锁，里面是一叠手写的航海笔记，和一个空的铁盒。',
  '最后一页写着：“如果沈岸看到这里，告诉他，我没有沉在海里，我是在雾里走错了方向。”字迹很抖，但确实是父亲的。',
  '沈岸把笔记抱在怀里，忽然听见远处传来一声汽笛。黎望站在他身后，说：“那是三点四十的渡船，几十年都是这个点。”',
].join('\n');

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type AnyWorld = any;

async function loadArm(srcDir: string) {
  const mod = await import(pathToFileURL(resolve(srcDir, 'definition.ts')).href);
  const schemas = await import(pathToFileURL(resolve(srcDir, 'tool-schemas.ts')).href);
  return { BOOKFISH: mod.BOOKFISH, decls: schemas.BOOKFISH_TOOL_DECLS as Array<{ name: string; description: string; parameters: unknown }> };
}

const PET_SAY = {
  type: 'function' as const,
  function: {
    name: 'pet_say',
    description: 'Say something in a speech bubble above the pet. Returns roughly how long it stays on screen.',
    parameters: { type: 'object', properties: { script: { type: 'string', description: 'What to say.' } }, required: ['script'] },
  },
};
const END_TURN = {
  type: 'function' as const,
  function: {
    name: 'end_turn',
    description: 'End this turn: nothing more to say or do right now.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

interface RunLog {
  scenario: string;
  title: string;
  promptTokens: number[];
  rounds: number;
  calls: Array<{ name: string; args: unknown; ok: boolean; error?: string; result?: string }>;
  finalText: string;
  notes: string[];
}

class Arm {
  constructor(readonly name: string, readonly srcDir: string) {}
  world!: AnyWorld;
  ctx!: AnyWorld;
  host!: AnyWorld;
  tools!: Array<{ name: string; handler: (args: any, call: any) => Promise<unknown> }>;
  modelTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> = [];
  bookKey = '';
  scratch = '';
  petSaid: string[] = [];

  async open(options: { withEnv?: boolean } = {}) {
    const { BOOKFISH, decls } = await loadArm(this.srcDir);
    const { fakeWorldContext } = await import('cortico/extensions/dry-mount.ts');
    const { FakeHost } = await import(pathToFileURL(resolve(PACKAGE, 'tests', 'helpers', 'fake-host.ts')).href);
    this.scratch = mkdtempSync(join(tmpdir(), `bookfish-ab-${this.name}-`));
    this.ctx = fakeWorldContext(BOOKFISH, { scratchDir: this.scratch });
    this.ctx.persist({
      automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 2,
      sharingEnabled: false, autonomousAcquisition: false, storyMemoryEnabled: false,
    });
    this.world = BOOKFISH.create(this.ctx);
    this.host = new FakeHost();
    await this.world.start(this.host);
    this.tools = this.world.tools();
    const imported = await this.world.webUi().invoke('status', 'import', [{
      filename: 'tide.txt', title: '潮水线', author: '测试作者',
      base64: Buffer.from(STORY, 'utf8').toString('base64'),
    }]);
    this.bookKey = imported.book.key;
    await this.world.webUi().invoke('status', 'select', [this.bookKey]);
    this.modelTools = [
      ...decls.map((decl) => ({ type: 'function' as const, function: { name: decl.name, description: decl.description, parameters: decl.parameters } })),
      PET_SAY, END_TURN,
    ];
    return this;
  }

  async close() {
    try { await this.world?.stop?.(); } catch { /* isolated teardown */ }
    // SQLite sidecars can still be held for a moment after stop(); a leftover
    // temp directory must never fail an A/B run.
    try { rmSync(this.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }

  /** Collect the text the World would have delivered to the model for one event type. */
  lastEventText(type: string): string | null {
    const events = (this.host.events as any[]).filter((event) => event.type === type);
    const last = events[events.length - 1];
    if (!last) return null;
    const text = typeof last.render === 'function' ? last.render() : last.text;
    return typeof text === 'string' ? text : null;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (name === 'pet_say') { this.petSaid.push(String(args.script ?? '')); return { ok: true, text: JSON.stringify({ accepted: true, note: 'bubble shown (harness stub)' }) }; }
    if (name === 'end_turn') return { ok: true, text: JSON.stringify({ ended: true }) };
    const tool = this.tools.find((entry) => entry.name === name);
    if (!tool) return { ok: false, text: `Unknown tool: ${name}` };
    try {
      const result = await tool.handler(args, {});
      return { ok: true, text: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (error) {
      return { ok: false, text: String((error as Error)?.message ?? error) };
    }
  }
}

async function chat(messages: Msg[], tools: Arm['modelTools']) {
  const { ollamaChat } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'model.mts')).href);
  return ollamaChat(MODEL, messages as any, tools as any);
}

interface Scenario { id: string; title: string; run: (arm: Arm, options: { freshPrompt: (text: string) => Msg[] }) => Promise<RunLog> }

function newLog(scenario: string, title: string): RunLog {
  return { scenario, title, promptTokens: [], rounds: 0, calls: [], finalText: '', notes: [] };
}

/** One agent loop: model -> tool calls -> tool results, until it stops or hits the round cap. */
async function loop(arm: Arm, log: RunLog, messages: Msg[]) {
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) throw new Error('scenario needs a system message');
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let result;
    try { result = await chat(messages, arm.modelTools); }
    catch (error) { log.notes.push(`model error: ${String((error as Error).message).slice(0, 200)}`); break; }
    log.rounds++;
    log.promptTokens.push(result.promptTokens);
    const calls = result.toolCalls;
    messages.push({ role: 'assistant', content: result.text || (calls.length ? '' : '(no content)') });
    if (!calls.length) { log.finalText = result.text; break; }
    for (const call of calls) {
      const outcome = await arm.call(call.name, call.arguments);
      log.calls.push({ name: call.name, args: call.arguments, ok: outcome.ok, ...(outcome.ok ? { result: outcome.text.slice(0, 300) } : { error: outcome.text.slice(0, 300) }) });
      messages.push({ role: 'tool', content: outcome.text.slice(0, 4000), tool_name: call.name });
    }
    log.finalText = result.text;
    if (calls.some((call) => call.name === 'end_turn')) break;
    await sleep(200);
  }
  return log;
}

export async function runScenario(arm: Arm, system: string, scenario: { id: string; title: string; seed: (arm: Arm) => Promise<string[]>; then?: (arm: Arm, log: RunLog) => Promise<string[]> }): Promise<RunLog> {
  const log = newLog(scenario.id, scenario.title);
  const messages: Msg[] = [{ role: 'system', content: system }];
  for (const text of await scenario.seed(arm)) messages.push({ role: 'user', content: text });
  await loop(arm, log, messages);
  if (scenario.then) {
    for (const text of await scenario.then(arm, log)) messages.push({ role: 'user', content: text });
    if (scenario.then) await loop(arm, log, messages);
  }
  return log;
}

export { Arm, STORY, OUT, MODEL, newLog };
