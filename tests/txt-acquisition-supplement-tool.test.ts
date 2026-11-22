import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
describe('model-visible precise intent termination',()=>{
  it.each(['cancel','abandon'] as const)('%s reaches the actual TXT abort path without cancelling an unrelated intent',async action=>{
    const dir=mkdtempSync(join(tmpdir(),'bf-supp-tool-'));const ctx=fakeWorldContext(BOOKFISH,{scratchDir:dir});
    ctx.persist({autonomousAcquisition:true,txtAcquisitionEnabled:true,allowNetwork:true,browserBridgeEnabled:false});
    const world=BOOKFISH.create(ctx) as any,library=world.library,selection=world.selection,acq=world.txtAcquisition;
    library.open();await acq.init();selection.start({pushEvent:async()=>undefined});
    cleanups.push(async()=>{await selection.stop();await acq.stop();library.close();rmSync(dir,{recursive:true,force:true});});
    const id=randomUUID(),other=randomUUID(),now=Date.now();library.updateSelection((state:any)=>{for(const value of [id,other])state.intents.push({id:value,title:'海风',author:'小鱼',reason:'测试',status:'proposed',origin:'autonomous',candidates:[],queueOnImport:true,createdAt:now,updatedAt:now});});
    let started!:()=>void;const requestStarted=new Promise<void>(r=>started=r);let bodyCancelled=false;
    // Test-only injected transport. No browser guard or production socket policy is bypassed in World.
    acq.resolve=async()=>['93.184.216.34'];acq.fetchImpl=async()=>{started();return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('第一章\n'));},cancel(){bodyCancelled=true;}}));};
    const running=acq.importFile({url:'https://books.example/a.txt',title:'海风',author:'小鱼',origin:'autonomous',intentId:id});await requestStarted;
    const tool=world.tools().find((entry:any)=>entry.name==='bookfish_acquire');
    expect(tool.parameters.properties.action.enum).toContain(action);
    const receipt=await tool.handler({action,intentId:id},{});expect(receipt).toBeTruthy();const result=await running;
    expect(result.failure?.code).toBe('cancelled');expect(bodyCancelled).toBe(true);
    expect(library.selection().intents.find((i:any)=>i.id===id).status).toBe(action==='cancel'?'cancelled':'abandoned');
    if(action==='abandon')expect(library.selection().intents.find((i:any)=>i.id===id).failure.message).toContain('大肥鱼');
    expect(library.selection().intents.find((i:any)=>i.id===other).status).toBe('proposed');expect(library.selection().queue).toHaveLength(0);
    expect(acq.summary().controllerReady).toBe(false);expect(acq.summary().browserReady).toBe(false);
  });
});
