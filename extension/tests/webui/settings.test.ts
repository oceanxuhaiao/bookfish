// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fakeWorldContext} from 'cortico/extensions/dry-mount.ts';import type {WebUiPanelContext} from 'cortico/web/shared/client-panel.ts';import {BOOKFISH} from '../../src/definition.ts';import type {BookfishConfigSection} from '../../src/config.ts';import {settingsPanel} from '../../src/webui/settings.ts';
let dir:string,controller:AbortController,root:HTMLElement,context:ReturnType<typeof fakeWorldContext<BookfishConfigSection>>,world:ReturnType<typeof BOOKFISH.create>,dispose:()=>void;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bf-settings-'));context=fakeWorldContext(BOOKFISH,{scratchDir:dir});world=BOOKFISH.create(context);controller=new AbortController();root=document.createElement('div');document.body.append(root);});
afterEach(()=>{dispose?.();controller.abort();document.body.replaceChildren();rmSync(dir,{recursive:true,force:true});});
async function mount(invoke?:WebUiPanelContext['invoke']){const h=await settingsPanel.mount({root,language:'zh',signal:controller.signal,invoke:invoke??((method,args)=>world.webUi!('zh').invoke!('settings',method,args??[]))} as WebUiPanelContext);dispose=()=>h.dispose();}
const field=(key:string)=>root.querySelector<HTMLInputElement>('#bf-config-'+key)!;
const change=(key:string,value:string|boolean)=>{const input=field(key);if(typeof value==='boolean')input.checked=value;else input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
const submit=()=>root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
it('loads persisted preferences, presents actual clock times, and exposes one custom settings tab',async()=>{
 context.persist({automaticReading:false,shareQuietStartMinute:1410,shareQuietEndMinute:450});await mount();expect(field('automaticReading').checked).toBe(false);expect(field('shareQuietStartMinute').value).toBe('23:30');expect(field('shareQuietEndMinute').value).toBe('07:30');expect(root.querySelector('details')!.open).toBe(false);expect(world.webUi!().config).toBeUndefined();expect(world.webUi!().panels!.filter(p=>p.title==='配置')).toHaveLength(1);expect(root.textContent).toContain('让她自己找书（实验功能）');
});
it('saves only edited settings through host persistence and preserves bookfish enable and advanced values',async()=>{
 context.persist({dailyTasks:77,enabled:true});await mount();change('pace','custom');change('readingCharsPerMinute','550');change('shareQuietStartMinute','23:30');change('shareQuietEndMinute','07:30');change('shareCooldownMinutes','90');submit();await vi.waitFor(()=>expect(root.textContent).toContain('已保存，下次'));expect(context.cfg.readingCharsPerMinute).toBe(550);expect(context.cfg.shareQuietStartMinute).toBe(1410);expect(context.cfg.shareQuietEndMinute).toBe(450);expect(context.cfg.dailyTasks).toBe(77);expect(context.cfg.enabled).toBe(true);
});
it('rejects an entire invalid or unsupported patch before persistence',async()=>{
 const invoke=world.webUi!().invoke!;const before={...context.cfg};await expect(invoke('settings','save',[{automaticReading:false,enabled:false}])).rejects.toThrow(/Unsupported/);await expect(invoke('settings','save',[{readingCharsPerMinute:99}])).rejects.toThrow();await expect(invoke('settings','save',[{shareQuietEndMinute:1440}])).rejects.toThrow();await expect(invoke('settings','save',[{automaticSharing:'false'}])).rejects.toThrow();expect(context.cfg).toEqual(before);
});
it('preserves edits on save failure and discards them only on an explicit discard',async()=>{
 await mount(async(method,args)=>{if(method==='save')throw Error('simulated disk failure');return world.webUi!().invoke!('settings',method,args??[]) as any;});change('shareCooldownMinutes','120');submit();await vi.waitFor(()=>expect(root.textContent).toContain('保存失败，修改已保留'));expect(field('shareCooldownMinutes').value).toBe('120');expect(context.cfg.shareCooldownMinutes).toBe(60);[...root.querySelectorAll('button')].find(b=>b.textContent==='取消修改')!.click();expect(field('shareCooldownMinutes').value).toBe('60');
});
it('does not overwrite newer settings in another client when saving an unrelated edit',async()=>{
 await mount();change('shareMaxSentenceChars','100');context.persist({dailyTasks:80});submit();await vi.waitFor(()=>expect(root.textContent).toContain('已保存，下次'));expect(context.cfg.dailyTasks).toBe(80);expect(context.cfg.shareMaxSentenceChars).toBe(100);
});
it('exposes an unlimited default goal and persists chapter and session preferences',async()=>{
 await mount();expect(field('dailyChapterGoal').value).toBe('0');expect(root.querySelector('#bf-config-dailyTasks')).toBeNull();expect(root.querySelector('#bf-config-dailyChars')).toBeNull();change('dailyChapterGoal','3');change('readingSessionMinutes','12');submit();await vi.waitFor(()=>expect(root.textContent).toContain('已保存，下次'));expect(context.cfg.dailyChapterGoal).toBe(3);expect(context.cfg.readingSessionMinutes).toBe(12);
});
it('defaults real routine on, removes editable clocks, and persists a single routine switch',async()=>{
 await mount();expect(field('realRoutineEnabled').checked).toBe(true);expect(field('sleepStartMinute')).toBeNull();expect(field('sleepEnabled')).toBeNull();expect(field('mealsEnabled')).toBeNull();expect(root.textContent).toContain('23:00—08:00');change('realRoutineEnabled',false);submit();await vi.waitFor(()=>expect(root.textContent).toContain('已保存，下次'));expect(context.cfg.realRoutineEnabled).toBe(false);
});
