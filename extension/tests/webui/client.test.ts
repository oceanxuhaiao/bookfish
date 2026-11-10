// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import type { BookfishConfigSection } from '../../src/config.ts';
import bundle from '../../src/webui/client.ts';
import { FakeHost } from '../helpers/fake-host.ts';
import { SourceHttp } from '../../src/source-http.ts';
import { fixture, ROOT } from '../fixtures/biquge.ts';
let dir: string;
let persist: (values: Partial<BookfishConfigSection>) => void;
let world: ReturnType<typeof BOOKFISH.create>;
let controller: AbortController;
let dispose: (() => void) | undefined;
let confirmAnswer = false;
let lastConfirm: { title: string; body?: string; danger?: boolean } | undefined;
let toasts: string[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-ui-'));
  confirmAnswer = false; lastConfirm = undefined; toasts = [];
  const context = fakeWorldContext(BOOKFISH, { scratchDir: dir }); persist = context.persist; persist({automaticReading:false,realRoutineEnabled:false}); world = BOOKFISH.create(context);
  await world.start(new FakeHost()); controller = new AbortController();
});
afterEach(async () => { vi.restoreAllMocks(); dispose?.(); dispose = undefined; controller.abort(); await world.stop(); document.body.replaceChildren(); rmSync(dir, { recursive: true, force: true }); });
async function mount(panelId='status') {
  const root = document.createElement('div'); document.body.append(root);
  const intervals: Array<() => Promise<void>> = [];
  const ctx = { root, panelId, language: 'zh', signal: controller.signal,
    invoke: async (method: string, args: unknown[]) => world.webUi!('zh').invoke!(panelId, method, args),
    setConfig: async (_group: string, values: Record<string, unknown>) => { persist(Object.fromEntries(Object.entries(values).map(([key,value]) => [key.replace('worlds.bookfish.',''),value]))); return 'Saved'; },
    interval: (callback: () => Promise<void>) => { intervals.push(callback); }, timeout: () => {}, own: () => {},
    ui: {
      confirm: async (options: { title: string; body?: string; danger?: boolean }) => { lastConfirm = options; return confirmAnswer; },
      toast: (text: string) => { toasts.push(text); return { dispose() {} }; },
    },
  } as unknown as WebUiPanelContext;
  const panel = (bundle.panels as Record<string, typeof bundle.panels.status>)[panelId] ?? bundle.panels.status;
  const handle = await panel.mount(ctx); dispose = () => handle.dispose();
  return { root, poll: async () => { for (const callback of intervals) await callback(); } };
}
function action(root: HTMLElement, label: string) { return [...root.querySelectorAll('button')].find(b => b.textContent === label)!; }
async function settle() { await new Promise(resolve => setTimeout(resolve, 25)); }
describe('library panel with real World data plane', () => {
  it('opens unconfirmed local text with a directory without changing pet selection or progress',async()=>{
    const invoke=world.webUi!().invoke!;const imported:any=await invoke('status','import',[{filename:'reader.md',title:'用户阅读样本',base64:Buffer.from('# 第一章 海边\n'+'风吹过海面。\n'.repeat(1800)+'\n# 第二章 回家\n小鱼回来了。').toString('base64')}]);
    const before=await invoke('status','get',[]);const {root}=await mount();root.querySelector('.bf')!.dispatchEvent(new CustomEvent('bookfish-book',{bubbles:true,detail:{key:imported.book.key}}));await settle();action(root,'阅读正文').click();await settle();
    const reader=root.querySelector<HTMLElement>('[data-page=reader]')!;expect(reader.hidden).toBe(false);expect(reader.textContent).toContain('风吹过海面');expect(reader.textContent).toContain('第二章 回家');expect(reader.querySelector('script')).toBeNull();
    const first=reader.querySelector('article')!.textContent;action(reader,'下一节').click();await settle();expect(reader.querySelector('article')!.textContent).not.toEqual(first);action(reader,'第二章 回家').click();await settle();expect(reader.querySelector('article')!.textContent).toContain('小鱼回来了。');
    const after:any=await invoke('status','get',[]);expect(after.books).toEqual((before as any).books);expect(after.status.library).toEqual((before as any).status.library);
    await expect(invoke('status','reader',[{bookKey:imported.book.key,segment:-1}])).rejects.toThrow();
  });
  it('shows an immediate in-flight source state and a failure result while preserving the URL',async()=>{
    let reject!:(e:Error)=>void;vi.spyOn(SourceHttp.prototype,'get').mockImplementation(()=>new Promise((_resolve,r)=>{reject=r;}));
    const {root}=await mount();const form=action(root,'检测链接能否获取正文').closest('form')!;action(root,'填入示例').click();expect(form.querySelector('input')!.value).toBe('https://www.02345.cc/xiyouji/');form.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(form.querySelector('.source-result')!.textContent).toContain('正在连接书源');expect(form.querySelector('progress')).not.toBeNull();expect(action(root,'正在检测…').disabled).toBe(true);
    reject(Error('offline'));await settle();expect(form.querySelector('.source-result')!.textContent).toContain('检测失败');expect(form.querySelector('input')!.value).toBe('https://www.02345.cc/xiyouji/');expect(action(root,'检测链接能否获取正文').disabled).toBe(false);
  });
  it('shows the single recommendation entry and explains a missing engine instead of enabling a fake download', async () => {
    const { root } = await mount('shelf');
    const entry = action(root, '＋ 推荐一本书');
    expect(entry).toBeTruthy();
    entry.click(); await settle();
    expect(root.textContent).toContain('目前仅支持笔趣阁');
    expect(root.querySelector<HTMLAnchorElement>('a.source-site')?.href).toBe('https://www.02345.cc/');
    const picker = root.querySelector<HTMLSelectElement>('#bf-recommend-panel select[aria-label="导入方式"]')!;
    picker.value = 'title'; picker.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    const novel = root.querySelector<HTMLElement>('#bf-novel-fetch')!;
    expect(novel.hidden).toBe(false);
    expect(novel.textContent).toContain('小说引擎未安装');
    expect(novel.querySelector<HTMLInputElement>('form input[type=text]')!.disabled).toBe(true);
    expect([...novel.querySelectorAll('button')].find(button => button.textContent === '搜索候选版本')!.disabled).toBe(true);
  });
  it('displays a reported mood, evidence and stated reason without executing annotation text', async () => {
    const invoke = world.webUi!().invoke!;
    const imported = await invoke('status', 'import', [{ filename: 'journal.txt', title: '手账样本', base64: Buffer.from('小鱼把饼留给妹妹。').toString('base64') }]) as { book: { key: string } };
    await invoke('status', 'select', [imported.book.key]);
    const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(await world.tools().find(t => t.name === name)!.handler(args, {} as ToolCallContext) as string);
    const task = await tool('bookfish_read_next', {});
    await tool('bookfish_finish_reading', { taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '她留了饼。', episode: {
      trigger: '她留下食物', interpretation: '<img src=x onerror=alert(1)>', reason: '她先顾着妹妹。', mood: { label: '替他不平' },
      evidence: [{ segmentId: 0, quote: '小鱼把饼留给妹妹。' }], characters: [{ name: '小鱼', aliases: ['姐姐'] }],
    } });
    const { root, poll } = await mount();
    expect(root.textContent).toContain('最近一次自报心情: 替他不平'); expect(root.textContent).toContain('不是实时心理状态');
    expect(root.querySelector('.timeline')!.textContent).toContain('大肥鱼当时的阅读心情：😠 替他不平');
    expect(root.querySelector('.mood')!.textContent).toBe('😠 替他不平');
    expect(root.querySelector('.thought')!.textContent).toBe('😠 <img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull(); action(root, '查看原文依据与理由').click(); await settle();
    expect(root.textContent).toContain('她先顾着妹妹。'); expect(root.querySelector('blockquote')!.textContent).toBe('小鱼把饼留给妹妹。');
    expect(root.textContent).toContain('仅校验引用与原文字面一致'); expect(root.textContent).toContain('小鱼 (姐姐)');
    const search = action(root, '检索已读记录').closest('form')!;
    search.querySelector('input')!.value = '妹妹';
    search.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    expect(root.textContent).toContain('零匹配不证明没有相关内容');
    action(root, '查看完整记录与已读原文').click(); await settle();
    expect(root.textContent).toContain('她先顾着妹妹。'); expect(root.querySelector('img')).toBeNull();
    await tool('bookfish_share', { action: 'propose', episodeId: (await tool('bookfish_lookup', { action: 'journal' })).items[0].id, text: '<img src=x onerror=alert(1)>这段值得分享。' });
    await action(root, '刷新').click(); await settle();
    expect(root.textContent).toContain('工具报告已接收不等于已显示'); expect(root.querySelector('img')).toBeNull();
    action(root, '放弃这条分享').click(); await settle();
    expect((await tool('bookfish_share', { action: 'status' })).items[0].state).toBe('dropped');
    const state = await invoke('status', 'get', []) as { status: { library: { current: { confirmedSegments: number } } } };
    expect(state.status.library.current.confirmedSegments).toBe(1);
    action(root,'聊聊这一段').click();await settle();const question=root.querySelector('textarea')!;question.value='你怎么看？';action(root,'发送给大肥鱼').click();await settle();
    const panel=await invoke('status','get',[]) as {discussions:Array<{id:string}>};const saved=await tool('bookfish_discussion',{action:'reply',discussionId:panel.discussions[0].id,delivery:'spoken',segments:['她先顾着妹妹。','这个动作让我在意。']});expect(saved).toMatchObject({delivery:'spoken'});const fresh=await invoke('status','get',[]) as any;expect(fresh.discussions.find((d:any)=>d.id===panel.discussions[0].id)).toMatchObject({delivery:'spoken'});await poll();await settle();expect(root.textContent).toContain('你：你怎么看？');expect(root.textContent).toContain('🐟：她先顾着妹妹。');expect(root.textContent).toContain('🐟：这个动作让我在意。');expect(root.querySelectorAll('.chat-line.pet')).toHaveLength(2);
    const job = (await tool('bookfish_review', { action: 'begin', bookKey: task.bookKey, requestId: 'ui-review' })).job;
    await tool('bookfish_review', { action: 'materials', jobId: job.id, kind: 'ranges' }); await tool('bookfish_review', { action: 'materials', jobId: job.id, kind: 'episodes' });
    await tool('bookfish_review', { action: 'finish', jobId: job.id, title: '<img src=x onerror=alert(1)>读后感', text: '这是一篇合成界面测试文章，不代表真实模型阅读。她把饼留给妹妹，这个小动作在先前记录里被解释为先顾着妹妹。现在回看，我仍觉得这个细节值得保留，不过原文没有交代更多动机，我不应该把新的推测当成过去的记忆。文章和证据分别展示，也不会因为标题含有标记就执行网页代码。', episodeIds: [(await tool('bookfish_lookup', { action: 'journal' })).items[0].id], evidence: [{ segmentId: 0, quote: '小鱼把饼留给妹妹。' }] });
    action(root, '刷新').click(); await settle(); action(root, 'v1 · <img src=x onerror=alert(1)>读后感').click(); await settle();
    expect(root.textContent).toContain('这是一篇合成界面测试文章'); expect(root.querySelector('img')).toBeNull();
    const sources = action(root, '导出写作依据（JSON）').closest('details')!;
    expect(sources.open).toBe(false);
    expect(sources.textContent).toContain('感想编号');
    expect(sources.contains(action(root, '导出这版读后感'))).toBe(false);
  });
  it('keeps configuration solely in the host group and preserves explicit reading preference',async()=>{
    const {root}=await mount();expect([...root.querySelectorAll('nav button')].map(x=>x.textContent)).toEqual(['正在读','书架','阅读足迹','反馈']);
    expect(root.querySelector('#bf-speed')).toBeNull();expect(root.textContent).not.toContain('开启自主阅读');
    expect(BOOKFISH.defaults().automaticReading).toBe(true);
    expect(world.webUi!('zh').config).toBeUndefined();expect(world.webUi!('zh').panels?.map(p=>p.id)).toEqual(['status','shelf','trail','support','settings']);
    expect((await world.webUi!().invoke!('status','get',[]) as any).config.automaticReading).toBe(false);
  });
  it('shows that old confirmations have no recorded mood instead of synthesizing one', async () => {
    const invoke = world.webUi!().invoke!;
    const imported = await invoke('status', 'import', [{ filename: 'old.txt', title: '旧记录', base64: Buffer.from('只是海边风景。').toString('base64') }]) as { book: { key: string } };
    await invoke('status', 'select', [imported.book.key]);
    const read = world.tools().find(t => t.name === 'bookfish_read_next')!;
    const t = JSON.parse(await read.handler({}, {} as ToolCallContext) as string);
    await world.tools().find(t => t.name === 'bookfish_finish_reading')!.handler({ ...t, understanding: '只有风景记录。' }, {} as ToolCallContext);
    const { root } = await mount();
    expect(root.querySelector('.timeline')!.textContent).toContain('大肥鱼当时未记录阅读心情');expect(root.querySelector('.timeline')!.textContent).not.toContain('读到第');expect(root.textContent).toContain('1 个已读段落未记录阅读当时的感想'); expect(root.textContent).toContain('尚未报告心情');
  });
  it('imports a UTF-8 file, selects it, shows confirmed progress, pauses and resumes', async () => {
    const { root, poll } = await mount();
    const importForm=action(root,'导入书架').closest('form')!;const file = importForm.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(importForm.querySelectorAll('input:not([type=file])')).toHaveLength(0);expect(action(root,'导入书架').disabled).toBe(true);
    const sampleText='书名：样本\n作者：小鱼\n海边的小鱼回家了。';const sample = { name: '上传文件.txt', size: new TextEncoder().encode(sampleText).length, slice:()=>({arrayBuffer:async()=>new TextEncoder().encode(sampleText).buffer}), arrayBuffer: async () => new TextEncoder().encode(sampleText).buffer };
    Object.defineProperty(file, 'files', { value: [sample] }); file.dispatchEvent(new Event('change'));
    importForm.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    await vi.waitFor(async()=>{await poll();expect(root.textContent).toContain('导入完成，已加入书架。');expect(root.textContent).toContain('样本');},{timeout:5000});
    expect(root.querySelector('.import-metadata')!.textContent).toContain('小鱼');action(root, '开始读这本').click(); await settle();
    expect(root.textContent).toContain('0.0%');
    expect(action(root,'暂停阅读').disabled).toBe(true);expect(action(root,'暂停阅读').parentElement).toBe(action(root,'继续读').parentElement);
    action(root,'继续读').click();await settle();expect(action(root,'继续读').disabled).toBe(true);expect(action(root,'暂停阅读').disabled).toBe(false);
    action(root, '暂停阅读').click(); await settle();
    expect(root.textContent).toContain('已暂停');
    expect(action(root,'暂停阅读').disabled).toBe(true);expect(action(root,'继续读').disabled).toBe(false);action(root, '继续读').click(); await settle();
    const opportunityId=(await world.webUi!().invoke!('status','get',[]) as any).status.scheduler.active.opportunityId;
    const get = world.tools().find(t => t.name === 'bookfish_read_next')!;
    const t = JSON.parse(await get.handler({opportunityId}, {} as ToolCallContext) as string);
    const finish = world.tools().find(t => t.name === 'bookfish_finish_reading')!;
    await finish.handler({ opportunityId,taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '小鱼回到家。' }, {} as ToolCallContext);
    await poll(); await settle();
    expect(root.textContent).toContain('100.0%');
  });
  it('shows background import progress and cancels without changing the shelf', async () => {
    const { root, poll } = await mount();
    const importForm=action(root,'导入书架').closest('form')!;const file = importForm.querySelector<HTMLInputElement>('input[type=file]')!;
    const bytes = new TextEncoder().encode('海边的小鱼回家了。'.repeat(1000000));
    const sample = { name: '大样本.txt', size: bytes.length, slice:(start:number,end:number)=>({arrayBuffer:async()=>bytes.slice(start,end).buffer}), arrayBuffer: async () => bytes.buffer };
    Object.defineProperty(file, 'files', { value: [sample] }); file.dispatchEvent(new Event('change'));
    importForm.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    const status = root.querySelector<HTMLElement>('[data-bookfish=import-status]')!;
    await vi.waitFor(async()=>{await poll();const bar=status.querySelector('progress')!;expect(Number(bar.value)).toBeGreaterThan(0);expect(bar.value).toBeLessThan(100);expect(action(root,'取消导入').hidden).toBe(false);},{timeout:15000});
    action(root,'取消导入').click();
    await vi.waitFor(async()=>{await poll();expect(status.textContent).toContain('已取消导入');},{timeout:15000});
    expect(status.textContent).not.toContain('导入完成');
    const panel = await world.webUi!('zh').invoke!('status','get',[]) as {books:unknown[]};
    expect(panel.books).toEqual([]);
    expect(root.querySelector('.cover-grid article')).toBeNull();
  });
  it('renders local typographic covers on the home card and shelf without image requests', async () => {
    const invoke = world.webUi!().invoke!;
    const imported = await invoke('status', 'import', [{ filename: 'cover.txt', title: '封面样本', author: '小鱼', base64: Buffer.from('海风。').toString('base64') }]) as { book: { key: string } };
    await invoke('status', 'select', [imported.book.key]);
    const { root } = await mount(); await settle();
    const hero = root.querySelector<HTMLElement>('.reading-hero .book-cover')!;
    expect(hero.querySelector('.cover-title')!.textContent).toBe('封面样本');
    expect(hero.querySelector('.cover-author')!.textContent).toBe('小鱼');
    expect(hero.querySelector('.cover-foot')!.textContent).toBe('本地导入');
    expect(hero.dataset.palette).toMatch(/^[0-7]$/);
    expect(root.querySelector('img')).toBe(null);
    const footer = root.querySelector<HTMLElement>('.hero-footer')!;
    expect(footer.querySelector('.hero-actions')).not.toBeNull();
    expect(footer.textContent).toContain('已读');
    action(root, '书架').click(); await settle();
    const card = root.querySelector<HTMLElement>('.cover-grid .book-cover')!;
    expect(card.querySelector('.cover-title')!.textContent).toBe('封面样本');
    expect(card.querySelector('.cover-author')!.textContent).toBe('小鱼');
  });
  it('renders hostile metadata as text, asks for removal confirmation, and removes only after confirmation', async () => {
    await world.webUi!().invoke!('status', 'import', [{ filename: 'x.md', title: '<img src=x onerror=alert(1)>', base64: Buffer.from('原文').toString('base64') }]);
    const { root, poll } = await mount();
    expect(root.querySelector('img')).toBe(null);
    expect(root.textContent).toContain('<img');
    root.querySelector<HTMLButtonElement>('.cover-grid .cover-button')!.click();await settle();
    expect(root.querySelector('.detail-head .book-cover')!.textContent).toContain('<img');
    action(root, '移除这本书').click(); await settle();
    expect(lastConfirm).toMatchObject({ danger: true });
    expect(lastConfirm!.body).toContain('无法撤销');
    expect(root.querySelector('.cover-grid article')).not.toBeNull();
    await poll(); await settle();
    confirmAnswer = true;
    action(root, '移除这本书').click(); await settle();
    expect(toasts).toContain('已移除《<img src=x onerror=alert(1)>》');
    expect(root.querySelector('.cover-grid article')).toBe(null);
  });
  it('does not update the DOM after disposal', async () => {
    const { root, poll } = await mount(); const initial = root.textContent;
    dispose?.();
    await world.webUi!().invoke!('status', 'import', [{ filename: 'new.md', title: '新书', base64: Buffer.from('原文').toString('base64') }]);
    await poll(); await settle();
    expect(root.textContent).toBe(initial);
  });
  it('imports a paginated source link and displays chapter-based progress and source identity', async () => {
    const f = fixture(); vi.spyOn(SourceHttp.prototype, 'get').mockImplementation(f.get);
    const { root } = await mount();
    const url = root.querySelector<HTMLInputElement>('input[type=url]')!; url.value = ROOT;
    url.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    expect(root.textContent).toContain('合成测试小说');
    expect((await world.webUi!().invoke!('status','get',[]) as {books:unknown[]}).books).toHaveLength(0);
    action(root, '确认加入书架').click(); await settle();
    expect(root.textContent).toContain(ROOT);
    action(root, '开始读这本').click(); await settle();
    expect(root.textContent).toContain('章节进度'); expect(root.textContent).toContain('已读章节 0/3');
    expect(f.requests).toHaveLength(4);
  });
});


it('uses host-persisted reading and quiet settings without duplicate controls',async()=>{
  persist({readingCharsPerMinute:550,shareQuietStartMinute:1410,shareQuietEndMinute:450});const {root,poll}=await mount();await poll();
  const state=await world.webUi!().invoke!('status','get',[]) as any;expect(state.status.scheduler.charsPerMinute).toBe(550);expect(state.status.sharing.limits.startMinute).toBe(1410);expect(root.querySelector('#bf-shareQuietStartMinute')).toBeNull();
});

it('opens real cover details and another book journal without switching the current reading book',async()=>{
 const invoke=world.webUi!().invoke!;const one=await invoke('status','import',[{filename:'a.txt',title:'甲书',base64:Buffer.from('海风。').toString('base64')}]) as any;const two=await invoke('status','import',[{filename:'b.txt',title:'乙书',base64:Buffer.from('海浪。').toString('base64')}]) as any;await invoke('status','select',[one.book.key]);const {root}=await mount();action(root,'书架').click();
 expect(root.querySelectorAll('.cover-grid article')).toHaveLength(2);root.querySelector<HTMLButtonElement>('[aria-label="查看这本书：乙书"]')!.click();await settle();expect(root.querySelector('[data-page=bookDetail]')!.hasAttribute('hidden')).toBe(false);
 action(root,'查看阅读足迹').click();await settle();expect((await invoke('status','get',[]) as any).status.library.current.key).toBe(one.book.key);
 action(root,'书架').click();const search=root.querySelector<HTMLInputElement>('input[type=search]')!;search.value='乙';search.dispatchEvent(new Event('input'));expect(root.querySelectorAll('.cover-grid article')).toHaveLength(1);expect(root.querySelector('.cover-grid')!.textContent).toContain('乙书');
});

it('switches between recent and title sorting without pinning the current book',async()=>{
  const invoke=world.webUi!().invoke!;
  for(const [filename,title] of [['beta.txt','Beta'],['gamma.txt','Gamma'],['alpha.txt','Alpha']]){
    await invoke('status','import',[{filename,title,base64:Buffer.from('海风。').toString('base64')}]);
  }
  const beta=(await invoke('status','get',[]) as any).books.find((book:any)=>book.title==='Beta');
  await invoke('status','select',[beta.key]);
  const {root}=await mount();action(root,'书架').click();await settle();
  const titles=()=>[...root.querySelectorAll('.cover-grid article strong')].map(node=>node.textContent);
  expect(titles()).toEqual(['Alpha','Gamma','Beta']);
  const sort=root.querySelector<HTMLSelectElement>('select[aria-label="书架排序"]')!;
  sort.value='title';sort.dispatchEvent(new Event('change',{bubbles:true}));await settle();
  expect(titles()).toEqual(['Alpha','Beta','Gamma']);
});
it('renders a compact empty state with one clear call to action', async () => {
  const { root } = await mount();
  const hero = root.querySelector<HTMLElement>('.reading-hero')!;
  expect(hero.classList.contains('is-empty')).toBe(true);
  expect(hero.textContent).toContain('书架还是空的');
  const recommend = [...hero.querySelectorAll('button')].find(node => node.textContent === '＋ 推荐一本书');
  expect(recommend).toBeTruthy();
  expect(hero.querySelector('.hero-actions')!.textContent).toContain('页数怎么算');
  expect([...hero.querySelectorAll('button')].filter(node => node.textContent === '查看这本书 ↗' && !node.hidden)).toHaveLength(0);
});
it('opens a feedback page with GitHub, QQ group and author links', async () => {
  const { root } = await mount('support');
  const support = root.querySelector<HTMLElement>('section[data-page=support]')!;
  expect(support).toBeTruthy();
  expect(support.textContent).toContain('1135570183');
  expect(support.textContent).toContain('oceanxuhaiao');
  expect(support.querySelector<HTMLAnchorElement>('a[href="https://github.com/oceanxuhaiao/bookfish/issues"]')).toBeTruthy();
  expect(support.querySelector<HTMLAnchorElement>('a[href="https://afdian.com/a/book-fish"]')?.textContent).toContain('前往爱发电');
  expect(support.textContent).toContain('赞助完全自愿');
  expect(support.textContent).toContain('请作者吃个菠萝');
  expect(support.querySelectorAll('.support-actions .support-card')).toHaveLength(3);
  expect(support.querySelector('.support-community .qq-group-code')).toBeTruthy();
  expect(support.querySelector<HTMLImageElement>('.qq-group-code')?.src.startsWith('data:image/png;base64,')).toBe(true);
});
it('lets the user request a passage immediately while automatic reading is off and distinguishes queued from confirmed',async()=>{
 const invoke=world.webUi!().invoke!,book=await invoke('status','import',[{filename:'now.txt',title:'主动阅读样本',base64:Buffer.from('小鱼把最后一口饼留在桌边。').toString('base64')}]) as any;await invoke('status','select',[book.book.key]);const {root,poll}=await mount();expect(root.textContent).toContain('自主阅读已关闭，仍可点击');action(root,'继续读').click();await settle();const state=await invoke('status','get',[]) as any;expect(state.status.scheduler.manual.state).toBe('queued');expect(action(root,'继续读').disabled).toBe(true);expect(action(root,'继续读').parentElement).toBe(action(root,'查看这本书 ↗').parentElement);expect(root.querySelector('.reading-state strong')!.textContent).toBe('等待开始阅读');expect(root.textContent).toContain('阅读请求已发送');expect(state.status.library.current.confirmedChars).toBe(0);
 const tool=async(name:string,args:any)=>JSON.parse(await world.tools().find(t=>t.name===name)!.handler(args,{} as ToolCallContext) as string);const opportunityId=state.status.scheduler.active.opportunityId;const task=await tool('bookfish_read_next',{opportunityId});await poll();await settle();expect(root.textContent).toContain('大肥鱼正在读这一段');expect(root.querySelector('.reading-state')!.getAttribute('data-state')).toBe('reading');expect(root.querySelector('.reading-state strong')!.textContent).toBe('正在阅读');await tool('bookfish_finish_reading',{...task,opportunityId,understanding:'小鱼把饼留在桌边。'});await poll();await settle();expect(root.textContent).toContain('这本书已经读完了');expect(root.querySelector('.reading-state strong')!.textContent).toBe('已读完');expect((await invoke('status','get',[]) as any).status.library.current.confirmedChars).toBeGreaterThan(0);
});
it('does not block Read now on retired character caps and does not fake progress',async()=>{
 persist({dailyChars:1});const invoke=world.webUi!().invoke!,book=await invoke('status','import',[{filename:'cap.txt',title:'额度样本',base64:Buffer.from('这段超过一个字。').toString('base64')}]) as any;await invoke('status','select',[book.book.key]);const {root}=await mount();action(root,'继续读').click();await settle();expect(root.textContent).toContain('阅读请求已发送');expect(root.textContent).not.toContain('今天的阅读额度已用完');expect((await invoke('status','get',[]) as any).status.library.current.confirmedChars).toBe(0);
});
it('shows rest as a mechanical timeline entry without inventing a reading mood',async()=>{
 persist({readingSessionMinutes:1});const invoke=world.webUi!().invoke!,book=await invoke('status','import',[{filename:'break.txt',title:'休息样本',base64:Buffer.from('海风。'.repeat(900)).toString('base64')}]) as any;await invoke('status','select',[book.book.key]);const tool=async(name:string,args:any)=>JSON.parse(await world.tools().find(t=>t.name===name)!.handler(args,{} as ToolCallContext) as string),task=await tool('bookfish_read_next',{});await tool('bookfish_finish_reading',{...task,understanding:'风吹过海边。'});const {root,poll}=await mount();const timeline=root.querySelector('.timeline')!;expect(timeline.textContent).toContain('☕ 休息一会儿');expect(timeline.textContent).toContain('预计继续');const rest=[...timeline.querySelectorAll('article')].find(r=>r.textContent?.includes('☕'))!;expect(rest.textContent).not.toContain('阅读心情');await invoke('status','resume_rest',[]);await poll();await settle();expect(timeline.textContent).toContain('这次休息已提前结束');
});

it('disables Continue while routine is active and shows the reason even with automatic reading off',async()=>{
 await world.stop();vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-08T16:00:00Z'));const nightContext=fakeWorldContext(BOOKFISH,{scratchDir:dir});nightContext.persist({automaticReading:false,realRoutineEnabled:true});world=BOOKFISH.create(nightContext);await world.start(new FakeHost());const invoke=world.webUi!().invoke!,book:any=await invoke('status','import',[{filename:'sleep.txt',title:'睡眠样本',base64:Buffer.from('海边。').toString('base64')}]);await invoke('status','select',[book.book.key]);const {root}=await mount();expect(action(root,'继续读').disabled).toBe(true);expect(root.textContent).toContain('她正在睡觉');expect(root.querySelector('.reading-state strong')!.textContent).toBe('睡觉中');expect(action(root,'继续读').parentElement).toBe(action(root,'查看这本书 ↗').parentElement);
});

it.each(['shelf','trail'] as const)('opens the top-level %s panel directly without visible secondary navigation',async panel=>{
 const {root}=await mount(panel);expect(root.querySelector<HTMLElement>('[data-page='+ (panel==='shelf'?'shelf':'trail') +']')!.hidden).toBe(false);expect(root.querySelector('nav')!.hidden).toBe(true);expect(root.querySelector('h2')!.hidden).toBe(true);expect(world.webUi!('zh').panels!.map(p=>p.title)).toEqual(['正在读','书架','阅读足迹','反馈','配置']);
});


