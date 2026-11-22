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
    if (method === 'txt_setup_configure') return result;
    if (method === 'txt_discover') return task;
    if (method === 'txt_import') return { task: { ...task, candidates: [], status: 'completed', bookKey: 'b' } };
    return task;
  });
  const controller = new AbortController();
  const ctx = { invoke, signal: controller.signal, interval: () => ({ dispose() {} }), refresh: vi.fn(async () => {}) } as unknown as WebUiPanelContext;
  const view = mountBrowserTxt(root, ctx, zh => zh); view.activate(true);
  return { root, invoke, change: (next: TxtSetup) => { setup = next; }, setResult:(next:BrowserSetupResult)=>{result=next;}, controller };
}
function button(root: HTMLElement, text: string) { return [...root.querySelectorAll('button')].find(n => n.textContent === text)!; }
function fill(root: HTMLElement) { const inputs=root.querySelectorAll<HTMLInputElement>('form input'); inputs[0].value='海风'; inputs[1].value='小鱼'; inputs[2].value='https://example.org/book'; }
describe('browser TXT setup and acquisition UI', () => {
  it('runs one-click setup and reports the actual missing installer without claiming success',async()=>{
    const {root,invoke}=mount({...ready,controllerReady:false,browserReady:false});await settle();
    button(root,'一键配置浏览器获取').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{allowNetwork:false}]);
    expect(root.textContent).toContain('停在“安全组件”步骤');expect(root.textContent).toContain('无需手动填写端口或令牌');
    expect(root.textContent).not.toContain('配置完成，可以开始获取');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('asks for network consent only when needed and verifies readiness after configuration',async()=>{
    const {root,invoke,setResult,change}=mount({...ready,networkEnabled:false,browserReady:false});await settle();
    setResult({state:'consent_required',reason:'network_consent',changed:false,steps:[{id:'verification',state:'action_required'}]});button(root,'一键配置浏览器获取').click();await settle();
    expect(button(root,'同意并继续配置').disabled).toBe(true);
    const consent=root.querySelector<HTMLInputElement>('input[type=checkbox]')!;consent.checked=true;consent.dispatchEvent(new Event('change'));expect(button(root,'同意并继续配置').disabled).toBe(false);
    change(ready);setResult({state:'ready',reason:'ready',changed:true,steps:[{id:'verification',state:'done'}]});button(root,'同意并继续配置').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_setup_configure',[{allowNetwork:true}]);expect(root.textContent).toContain('配置完成，可以开始获取');
    change({...ready,networkEnabled:false,browserReady:false});setResult({state:'consent_required',reason:'network_consent',changed:false,steps:[{id:'verification',state:'action_required'}]});button(root,'重新验证配置').click();await settle();
    expect(invoke.mock.calls.filter(([method])=>method==='txt_setup_configure').at(-1)?.[1]).toEqual([{allowNetwork:false}]);expect(consent.checked).toBe(false);
  });
  it('rejects a stale ready result when the final live connection check fails',async()=>{
    const {root,setResult}=mount({...ready,controllerReady:false,browserReady:false});await settle();
    setResult({state:'ready',reason:'ready',changed:true,steps:[{id:'verification',state:'done'}]});button(root,'一键配置浏览器获取').click();await settle();
    expect(root.textContent).not.toContain('配置完成，可以开始获取');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
  });
  it('prevents duplicate setup requests and recovers its button after a connection error',async()=>{
    const {root,invoke}=mount(ready);await settle();let reject!:(e:Error)=>void;
    invoke.mockImplementation(async method=>{if(method==='txt_setup')return ready;if(method==='txt_setup_configure')return await new Promise((_ok,no)=>{reject=no;});return task;});
    const start=button(root,'一键配置浏览器获取');start.click();start.click();await settle();
    expect(invoke.mock.calls.filter(([method])=>method==='txt_setup_configure')).toHaveLength(1);
    reject(Error('host disconnected'));await settle();expect(start.disabled).toBe(false);expect(root.textContent).toContain('配置未完成，请重试');expect(button(root,'发现 TXT 文件').disabled).toBe(true);
    expect(root.textContent).not.toContain('配置完成，可以开始获取');
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
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
    expect(root.querySelector('details')!.open).toBe(true);
  });
  it('uses discovered candidate ids, escapes source text and keeps a completed import distinct from reading', async () => {
    const {root,invoke}=mount(ready);await settle();fill(root);
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(root.querySelector('script')).toBeNull();expect(root.textContent).toContain('<script>海风</script>');
    button(root,'导入此 TXT 文件').click();await settle();
    expect(invoke).toHaveBeenCalledWith('txt_import',[{taskId:'fixture',candidateId:'c'}]);
    expect(root.textContent).toContain('阅读进度不会因导入而增加');
  });
  it('requires a specific work rather than substituting its author as a title', async () => {
    const {root,invoke}=mount(ready);await settle();fill(root);root.querySelector<HTMLInputElement>('form input')!.value='';
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
  });
});
