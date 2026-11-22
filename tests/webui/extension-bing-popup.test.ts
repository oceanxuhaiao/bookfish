// @vitest-environment jsdom
import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';import {join} from 'node:path';import {runInNewContext} from 'node:vm';
const settle=()=>new Promise(ok=>setTimeout(ok,0));afterEach(()=>document.body.replaceChildren());
async function mount(initial:Record<string,unknown>={},granted=true){
  document.body.innerHTML=readFileSync(join(process.cwd(),'extension/popup.html'),'utf8').replace(/<script[\s\S]*?<\/script>/giu,'');
  const state={...initial};const event={addListener:vi.fn()};
  const permissions={contains:vi.fn(async()=>granted),request:vi.fn(async()=>granted),remove:vi.fn(async()=>true),onRemoved:event,onAdded:event};
  const storage={get:vi.fn(async (defaults:Record<string,unknown>)=>({...defaults,...state})),set:vi.fn(async (patch:Record<string,unknown>)=>{Object.assign(state,patch);})};
  const chrome={permissions,storage:{local:storage,onChanged:event},runtime:{sendMessage:vi.fn()}};
  runInNewContext(readFileSync(join(process.cwd(),'extension/popup.js'),'utf8'),{document,chrome,URL,setTimeout:vi.fn()});await settle();return {state,permissions,storage};
}
describe('built-in Bing source popup',()=>{
  it('shows built-in access without prompting or adding a user source',async()=>{
    const f=await mount();expect(document.getElementById('bing-state')!.textContent).toContain('安装时授权');expect(f.permissions.request).not.toHaveBeenCalled();expect(f.storage.set).not.toHaveBeenCalled();
  });
  it('lets the user disable and restore Bing without deleting required manifest permission',async()=>{
    const f=await mount();document.getElementById('bing-toggle')!.click();await settle();expect(f.state.bingSearchEnabled).toBe(false);expect(f.permissions.remove).not.toHaveBeenCalled();expect(document.getElementById('bing-state')!.textContent).toContain('已停用');document.getElementById('bing-toggle')!.click();await settle();expect(f.state.bingSearchEnabled).toBe(true);
  });
  it('preserves saved disablement on reopen and does not claim withheld browser access',async()=>{
    const f=await mount({bingSearchEnabled:false},false);expect(document.getElementById('bing-state')!.textContent).toContain('已停用');document.getElementById('bing-toggle')!.click();await settle();expect(f.permissions.request).toHaveBeenCalledWith({origins:['https://cn.bing.com/*']});expect(f.state.bingSearchEnabled).toBe(false);expect(document.getElementById('status')!.textContent).toContain('未获允许');
  });
  it('also honors the existing revoke-source action for built-in Bing',async()=>{
    const f=await mount({allowedOrigins:['https://cn.bing.com']});(document.getElementById('source') as HTMLInputElement).value='https://cn.bing.com';document.getElementById('revoke')!.click();await settle();expect(f.state.bingSearchEnabled).toBe(false);expect(f.state.allowedOrigins).toEqual([]);expect(f.permissions.remove).not.toHaveBeenCalled();
  });
});
