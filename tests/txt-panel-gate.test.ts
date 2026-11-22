import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';
const dirs: string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('actual World browser TXT panel gate',()=>{
  it('exposes only setup facts and refuses direct discovery/import when the production controller is absent',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'bf-txt-panel-'));dirs.push(dir);
    const ctx=fakeWorldContext(BOOKFISH,{scratchDir:dir});ctx.persist({automaticReading:false,realRoutineEnabled:false,allowNetwork:true,txtAcquisitionEnabled:true,browserBridgeEnabled:false});
    const world=BOOKFISH.create(ctx);await world.start(new FakeHost());
    try{
      const invoke=world.webUi!().invoke!;
      const setup=await invoke('shelf','txt_setup',[]);
      expect(setup).toEqual({networkEnabled:true,enabled:true,bridgeEnabled:false,controllerReady:false,transportConnected:false,browserReady:false});
      expect(setup).not.toHaveProperty('token');
      const before=await invoke('settings','get',[]);
      expect(await invoke('shelf','txt_setup_configure',[{allowNetwork:true}])).toMatchObject({state:'blocked',reason:'controller_unavailable',changed:false});
      expect(await invoke('settings','get',[])).toEqual(before);
      await expect(invoke('shelf','txt_setup_configure',[{allowNetwork:'true'}])).rejects.toThrow('Invalid browser setup');
      await expect(invoke('shelf','txt_discover',[{title:'海风',url:'https://example.org'}])).rejects.toThrow('尚未就绪');
      await expect(invoke('shelf','txt_import',[{taskId:'x',candidateId:'c'}])).rejects.toThrow('尚未就绪');
      const view=await invoke('shelf','get',[]) as any;expect(view.status.txtAcquisition.active).toBe(0);expect(view.books).toHaveLength(0);
    }finally{await world.stop();}
  });
});
