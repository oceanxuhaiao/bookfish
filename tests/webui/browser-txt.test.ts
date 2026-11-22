// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { mountBrowserTxt, type TxtSetup } from '../../src/webui/browser-txt.ts';
import type { TaskView } from '../../src/txt-acquisition/types.ts';
const ready: TxtSetup = { networkEnabled: true, enabled: true, bridgeEnabled: true, controllerReady: true, transportConnected: true, browserReady: true };
// UI protocol fixtures only: no controller/network-isolation security claim.
const task: TaskView = { taskId: 'fixture', status: 'candidate_ready', origin: 'manual', target: { title: '海风' }, sourceHost: 'example.org', updatedAt: 0, nextActions: ['import'], candidates: [{ candidateId: 'c', filename: '海风.txt', title: '<script>海风</script>', format: 'txt', host: 'example.org', expiresAt: Date.now()+60000, available: true }] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => document.body.replaceChildren());
function mount(state: TxtSetup) {
  const root = document.createElement('div'); document.body.append(root);
  let setup = state;
  const invoke = vi.fn(async (method: string) => {
    if (method === 'txt_setup') return setup;
    if (method === 'txt_discover') return task;
    if (method === 'txt_import') return { task: { ...task, candidates: [], status: 'completed', bookKey: 'b' } };
    return task;
  });
  const controller = new AbortController();
  const ctx = { invoke, signal: controller.signal, interval: () => ({ dispose() {} }), refresh: vi.fn(async () => {}) } as unknown as WebUiPanelContext;
  const view = mountBrowserTxt(root, ctx, zh => zh); view.activate(true);
  return { root, invoke, change: (next: TxtSetup) => { setup = next; }, controller };
}
function button(root: HTMLElement, text: string) { return [...root.querySelectorAll('button')].find(n => n.textContent === text)!; }
function fill(root: HTMLElement) { const inputs=root.querySelectorAll('input'); inputs[0].value='海风'; inputs[1].value='小鱼'; inputs[2].value='https://example.org/book'; }
describe('browser TXT setup and acquisition UI', () => {
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
    const {root,invoke}=mount(ready);await settle();fill(root);root.querySelector('input')!.value='';
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
    expect(invoke.mock.calls.some(([method])=>method==='txt_discover')).toBe(false);
  });
});
