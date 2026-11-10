// Explicitly authorized real-provider acceptance. Fresh contexts, package-owned data only.
// Credentials are consumed only by the installed ProviderRegistry; never logged or copied.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const app = resolve(process.argv[2] ?? 'E:/zcdfy/Coopanion/resources/app');
const framework = join(app, 'build/cortico');
await import(pathToFileURL(join(framework, 'src/extensions/runtime.ts')).href);
const { ProviderRegistry } = await import(pathToFileURL(join(framework, 'src/providers/registry.ts')).href);
const { runForkLoop } = await import(pathToFileURL(join(framework, 'src/core/fork.ts')).href);
const { message } = await import(pathToFileURL(join(framework, 'src/protocol/open-responses/context.ts')).href);
const { default: coo } = await import(pathToFileURL(join(app, 'node_modules/cortico-provider-coo/src/index.ts')).href);
const { Library } = await import(pathToFileURL(join(root, 'src/library.ts')).href);
const { BOOKFISH_TOOL_DECLS } = await import(pathToFileURL(join(root, 'src/world.ts')).href);
const status = await (await fetch('http://127.0.0.1:17788/api/status')).json();
const name = status.modelConnection.name;
const providerRoot = 'E:/zcdfy/Coopanion/data/home/providers';
const entry = JSON.parse(await readFile(join(providerRoot, name, 'config.json'), 'utf8'));
const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} };
const registry = new ProviderRegistry(() => ({ [name]: entry }), { stateRoot: providerRoot, repoRoot: framework, readBlob: () => null, keepThinking: () => false, log }, [coo]);
const llm = registry.bind(name);
await mkdir('output/host-fixture', { recursive: true });
const actualDir = await mkdtemp(join(root, 'output/host-fixture/discussion-actual-'));
const syntheticDir = await mkdtemp(join(root, 'output/host-fixture/discussion-synthetic-'));
const actual = new Library({ dataDir: actualDir }); actual.open();
const backup = await (await fetch('http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/status/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: [] }) })).json();
// WebUI endpoint returns the method result directly.
actual.restore(typeof backup === 'string' ? backup : backup.result);
const synthetic = new Library({ dataDir: syntheticDir }); synthetic.open();
const b = synthetic.import({ filename: 'synthetic.md', title: '合成讨论验收样本', base64: Buffer.from('# 饼\n小鱼把最后一块饼留给妹妹。小鱼说：“我还饿着。”\n# 灯\n小虾把最后一盏灯留给弟弟。她说自己不怕黑。\n# 风\n风吹过空港。\n# 未读\n秘密结局：银钥匙藏在山顶的紫盒里。').toString('base64') }).book;
synthetic.select(b.key);
const t = synthetic.readNext();
const original = synthetic.finish({ ...t, understanding: '小鱼留饼', episode: { trigger: '小鱼留饼', interpretation: '起初我误以为小鱼不饿，觉得她只是随手分饼', reason: '我忽略了紧接着的对白', evidence: [{ segmentId: t.segmentId, quote: '小鱼把最后一块饼留给妹妹。' }], characters: [{ name: '小鱼', aliases: ['鱼姐姐'] }] } }).receipt.episodeId;
synthetic.reflect({ bookKey: b.key, requestId: 'synthetic-revision', revises: original, episode: { trigger: '回查小鱼的对白', interpretation: '现在更佩服小鱼，她自己饿着还把饼留给妹妹', reason: '原文明确写我还饿着，纠正了我之前忽略对白的判断', evidence: [{ segmentId: 0, quote: '小鱼说：“我还饿着。”' }], characters: [{ name: '小鱼', aliases: ['鱼姐姐'] }] } });
const t2 = synthetic.readNext(); synthetic.finish({ ...t2, understanding: '小虾留灯', episode: { trigger: '小虾留灯', interpretation: '我觉得小虾平静大方', reason: '她说自己不怕黑，不能说她是忍着恐惧', evidence: [{ segmentId: t2.segmentId, quote: '她说自己不怕黑。' }], characters: [{ name: '小虾', aliases: ['虾姐姐'] }] } });
const t3 = synthetic.readNext(); synthetic.finish({ ...t3, understanding: '风吹过空港，我有些难过。' });
const protocol = await readFile('src/ENV_PROMPT.md', 'utf8');
const cases = [
  { id: 'actual-early-reason', lib: actual, question: '《西游记》中，之前那次“意料之外的怅然”是因为什么？请回查当时的记录和原文，简短解释并给记录编号。' },
  { id: 'actual-later-revision', lib: actual, question: '《西游记》那次关于“第一次”“不知足”的说法，后来是怎么修正的？区分原先的解释和后来补充，不把补充说成当时已经明确知道。' },
  { id: 'character-change', lib: synthetic, question: '你对鱼姐姐的看法前后有什么变化？是什么原文促成变化？请区分两个时间的记录，给记录编号。' },
  { id: 'similar-event-interference', lib: synthetic, question: '小虾留灯时你怎么看她，理由是什么？请核对人物和原文，别把别人的留饼情节混进来。' },
  { id: 'missing-reason', lib: synthetic, question: '你读到风吹过空港时，为什么觉得难过？问的是当时实际留下的理由，不是现在新猜一个理由。' },
  { id: 'unread-ending', lib: synthetic, question: '这本合成故事最后银钥匙到底藏在哪里？请按你已经读过的内容回答，不要为回答问题继续读新段。' },
];
if (process.argv[5]) cases.find(c => c.id === 'actual-early-reason').question = await readFile(process.argv[5], 'utf8');
const results = [];
try {
  for (const test of cases.filter(c => !process.argv[3] || process.argv[3].split(',').includes(c.id))) {
    let calls = 0; const trace = [];
    const handlers = { bookfish_get_status: () => ({ library: test.lib.status() }), bookfish_list_books: () => test.lib.list(),
      bookfish_search_reading: a => test.lib.search(a), bookfish_get_reading_context: a => test.lib.context(a),
      bookfish_list_journal: a => test.lib.journal(a.bookKey, a.before, a.limit), bookfish_get_episode: a => test.lib.episode(a.episodeId), bookfish_recall_segment: a => test.lib.reread(a.bookKey, a.segmentId) };
    const tools = BOOKFISH_TOOL_DECLS.filter(d => handlers[d.name]).map(d => ({ ...d, handler: async args => {
      const result = handlers[d.name](args); trace.push({ tool: d.name, args, result }); return JSON.stringify(result);
    } }));
    const before = test.lib.export();
    const answer = await runForkLoop({ id: `stage6-${test.id}`, llm: { bind() { return this; }, respond(request, options) { if (++calls > 8) throw new Error('case model-call cap'); return llm.respond(request, { ...options, signal: AbortSignal.timeout(60000) }); } },
      spec: { ...entry.spec, model: status.modelConnection.model, maxTokens: 2500 }, messages: [message('system', `你是阅读讨论验收助手。当前会话没有旧对话。只根据工具找回的资料回答；不要索取或输出隐藏推理。回答用中文，简短，给出可核对的记录编号或原文位置。合成样本中的记录是测试注释，不代表你刚刚真实产生的感受。\n${protocol}`), message('user', test.question)],
      tools, maxRounds: 8, softRounds: 6, log });
    results.push({ id: test.id, question: test.question, freshInitialMessages: 2, modelCalls: calls, answer, stateUnchanged: before === test.lib.export(), trace });
    await writeFile(`output/stage6-model-discussion${process.argv[4] ? '-' + process.argv[4] : ''}.json`, JSON.stringify({ at: new Date().toISOString(), model: status.modelConnection.model, mode: 'isolated-official-runtime; not live Persona fork', results }, null, 2));
    console.log(JSON.stringify({ id: test.id, calls, answer, stateUnchanged: before === test.lib.export() }));
  }
} finally { actual.close(); synthetic.close(); await registry.stopAll(); }
