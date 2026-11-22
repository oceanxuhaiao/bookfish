// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { mountBrowserTxt, type TxtSetup } from '../../src/webui/browser-txt.ts';
import type { TaskView } from '../../src/txt-acquisition/types.ts';
import type { BrowserSetupResult } from '../../src/txt-acquisition/setup.ts';
const ready: TxtSetup = { networkEnabled: true, enabled: true, bridgeEnabled: true, controllerReady: true, transportConnected: true, browserReady: true };
// UI protocol fixtures only: no controller/network-isolation security claim.
const task: TaskView = { taskId: 'fixture', status: 'candidate_ready', origin: 'manual', target: { title: '海风' }, sourceHost: 'example.org', updatedAt: 0, nextActions: ['import'], candidates: [{ candidateId: 'c', filename: '海风.txt', title: '<script>海风</script>', format: 'txt', host: 'example.org', expiresAt: Date.now()+60000, available: true }] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => document.body.replaceChildren());
function mount(state: TxtSetup) {
  const root = document.createElement('div'); document.body.append(root);
  let setup = state;
  let result: BrowserSetupResult = {state:'blocked',reason:'controller_unavailable',changed:false,steps:[{id:'environment',state:'done'},{id:'controller',state:'blocked'}]};
  const invoke = vi.fn(async (method: string, _args?: unknown[]) => {
    if (method === 'txt_setup') return setup;
    if(method==='txt_search')return {blocked:false,hits:[{title:'《海风》下载',suggestedTitle:'海风',host:'example.org',url:'https://example.org/sea',snippet:'未经验证的搜索摘要'}]};
    if(method==='txt_extension_location')return {directory:'C:/test/extension'};
    if (method === 'txt_setup_configure') return result;
    if (method === 'txt_discover') return task;
    if (method === 'txt_import') return { task: { ...task, candidates: [], status: 'completed', bookKey: 'b' } };
    return task;
  });
  const controller = new AbortController();
  let tick:()=>Promise<void>=async()=>{};
  const ctx = { invoke, signal: controller.signal, interval: (callback:()=>Promise<void>) => {tick=callback;return { dispose() {} };}, refresh: vi.fn(async () => {}) } as unknown as WebUiPanelContext;
  const view = mountBrowserTxt(root, ctx, zh => zh); view.activate(true);
  return { root, invoke, change: (next: TxtSetup) => { setup = next; }, tick:()=>tick(), setResult:(next:BrowserSetupResult)=>{result=next;}, controller };
}
function button(root: HTMLElement, text: string) { return [...root.querySelectorAll('button')].find(n => n.textContent === text)!; }
function fill(root: HTMLElement) { const inputs=root.querySelectorAll<HTMLInputElement>('form[data-resource] input'); inputs[0].value='海风'; inputs[1].value='小鱼'; inputs[2].value='https://example.org/book'; }
describe('browser TXT setup and acquisition UI', () => {
  it.each([{title:'海风',author:''},{title:'',author:'小鱼'}])('searches without a resource URL: %j',async query=>{
    const {root,invoke}=mount(ready);await settle();const form=root.querySelector<HTMLFormElement>('form[data-book-search]')!,inputs=form.querySelectorAll('input');inputs[0].value=query.title;inputs[1].value=query.author;form.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke).toHaveBeenCalledWith('txt_search',[query]);expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);expect(root.querySelector<HTMLDetailsElement>('form[data-resource]')!.parentElement!.tagName).toBe('DETAILS');
    button(root,'确认作品，查找 TXT').click();await settle();expect(invoke).toHaveBeenCalledWith('txt_discover',[{title:'海风',author:query.author||undefined,url:'https://example.org/sea'}]);
  });
  it('shows remaining installation steps and automatically detects connection completion and loss before any task',async()=>{
    const state={...ready,controllerReady:false,transportConnected:false,browserReady:false,protectionMode:'standard' as const,standardAccepted:true};
    const {root,change,tick,invoke}=mount(state);await settle();expect(root.querySelector('h3')!.textContent).toContain('还差浏览器扩展连接');expect(root.textContent).toContain('edge://extensions');expect(root.textContent).toContain('保存并连接');
    button(root,'查看扩展文件夹位置').click();await settle();expect(invoke).toHaveBeenCalledWith('txt_extension_location',[]);expect(root.textContent).toContain('C:/test/extension');
    change({...state,transportConnected:true,browserReady:true});await tick();expect(root.querySelector('h3')!.textContent).toBe('配置完成，可以开始获取');expect(button(root,'发现 TXT 文件').disabled).toBe(false);expect(root.textContent).toContain('当前页面无法验证');
    change(state);await tick();expect(root.querySelector('h3')!.textContent).toContain('还差浏览器扩展连接');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('requires explicit ordinary-mode consent and supports autonomous browsing without inventing controller readiness',async()=>{
    const {root,invoke,setResult,change}=mount({...ready,controllerReady:false,browserReady:false,protectionMode:'enhanced'});await settle();
    const mode=root.querySelector<HTMLSelectElement>('[aria-label="浏览器使用模式"]')!;mode.value='standard';mode.dispatchEvent(new Event('change'));
    const consent=root.querySelector<HTMLInputElement>('[data-standard-consent]')!;expect(consent.checked).toBe(false);expect(root.textContent).toContain('模型自主浏览');
    setResult({state:'consent_required',reason:'standard_consent',changed:false,steps:[{id:'verification',state:'action_required'}]});button(root,'应用模式并一键配置').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{mode:'standard',acceptStandard:false,allowNetwork:false}]);
    expect(button(root,'重新运行一键配置').disabled).toBe(true);consent.checked=true;consent.dispatchEvent(new Event('change'));
    change({...ready,controllerReady:false,protectionMode:'standard',standardAccepted:true,isolationVerified:false});setResult({state:'ready',reason:'ready',changed:true,steps:[{id:'verification',state:'done'}]});button(root,'重新运行一键配置').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{mode:'standard',acceptStandard:true,allowNetwork:false}]);expect(button(root,'发现 TXT 文件').disabled).toBe(false);
    change({...ready,controllerReady:false,protectionMode:'standard',standardAccepted:false,browserReady:false});fill(root);root.querySelector('form[data-resource]')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
  });
  it('runs one-click setup and reports the actual missing installer without claiming success',async()=>{
    const {root,invoke}=mount({...ready,controllerReady:false,browserReady:false});await settle();
    button(root,'一键配置浏览器获取').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{allowNetwork:false,mode:'enhanced',acceptStandard:false}]);
    expect(root.textContent).toContain('停在“安全组件”步骤');expect(root.textContent).toContain('无需手动填写端口或令牌');
    expect(root.querySelector('h3')!.textContent).not.toContain('配置完成，可以开始获取');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('asks for network consent only when needed and verifies readiness after configuration',async()=>{
    const {root,invoke,setResult,change}=mount({...ready,networkEnabled:false,browserReady:false});await settle();
    setResult({state:'consent_required',reason:'network_consent',changed:false,steps:[{id:'verification',state:'action_required'}]});button(root,'一键配置浏览器获取').click();await settle();
    expect(button(root,'同意并继续配置').disabled).toBe(true);
    const consent=root.querySelector<HTMLInputElement>('[data-network-consent]')!;consent.checked=true;consent.dispatchEvent(new Event('change'));expect(button(root,'同意并继续配置').disabled).toBe(false);
    change(ready);setResult({state:'ready',reason:'ready',changed:true,steps:[{id:'verification',state:'done'}]});button(root,'同意并继续配置').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{allowNetwork:true,mode:'enhanced',acceptStandard:false}]);expect(root.textContent).toContain('配置完成，可以开始获取');
    change({...ready,networkEnabled:false,browserReady:false});setResult({state:'consent_required',reason:'network_consent',changed:false,steps:[{id:'verification',state:'action_required'}]});button(root,'重新验证配置').click();await settle();
    expect(invoke.mock.calls.filter(([method])=>method==='txt_setup_configure').at(-1)?.[1]).toEqual([{allowNetwork:false,mode:'enhanced',acceptStandard:false}]);expect(consent.checked).toBe(false);
  });
  it('rejects a stale ready result when the final live connection check fails',async()=>{
    const {root,setResult}=mount({...ready,controllerReady:false,browserReady:false});await settle();
    setResult({state:'ready',reason:'ready',changed:true,steps:[{id:'verification',state:'done'}]});button(root,'一键配置浏览器获取').click();await settle();
    expect(root.querySelector('h3')!.textContent).not.toContain('配置完成，可以开始获取');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('prevents duplicate setup requests and recovers its button after a connection error',async()=>{
    const {root,invoke}=mount(ready);await settle();let reject!:(e:Error)=>void;
    invoke.mockImplementation(async method=>{if(method==='txt_setup')return ready;if(method==='txt_setup_configure')return await new Promise((_ok,no)=>{reject=no;});return task;});
    const start=button(root,'一键配置浏览器获取');start.click();start.click();await settle();
    expect(invoke.mock.calls.filter(([method])=>method==='txt_setup_configure')).toHaveLength(1);
    reject(Error('host disconnected'));await settle();expect(start.disabled).toBe(false);expect(root.textContent).toContain('配置未完成，请重试');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
    expect(root.querySelector('h3')!.textContent).not.toContain('配置完成，可以开始获取');
  });
  it('guides first use without changing permissions or treating extension transport as protection', async () => {
    const { root, invoke } = mount({ ...ready, controllerReady: false }); await settle();
    expect(root.querySelector('details')!.open).toBe(true);
    expect(root.textContent).toContain('尚未接入正式安全控制器');
    expect(button(root,'发现 TXT 文件').disabled).toBe(true);
    expect(invoke.mock.calls.every(([method]) => method === 'txt_setup')).toBe(true);
    expect(root.querySelector('a')!.href).toContain('bookfish/settings');
  });
  it.each(['networkEnabled','enabled','bridgeEnabled','transportConnected','browserReady'] as const)('keeps discovery disabled with missing %s', async key => {
    const {root}=mount({...ready,[key]:false});await settle();expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('rechecks protection at submission and does not dispatch after revocation', async () => {
    const { root, invoke, change }=mount(ready);await settle();fill(root);change({...ready,controllerReady:false,browserReady:false});
    root.querySelector('form[data-resource]')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
    expect(root.querySelector('details')!.open).toBe(true);
  });
  it('uses discovered candidate ids, escapes source text and keeps a completed import distinct from reading', async () => {
    const {root,invoke}=mount(ready);await settle();fill(root);
    root.querySelector('form[data-resource]')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(root.querySelector('script')).toBeNull();expect(root.textContent).toContain('<script>海风</script>');
    button(root,'导入此 TXT 文件').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_import',[{taskId:'fixture',candidateId:'c'}]);
    expect(root.textContent).toContain('阅读进度不会因导入而增加');
  });
  it('requires a specific work rather than substituting its author as a title', async () => {
    const {root,invoke}=mount(ready);await settle();fill(root);root.querySelector<HTMLInputElement>('form[data-resource] input')!.value='';
    root.querySelector('form[data-resource]')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
  });
});
