import { describe, expect, it, vi } from 'vitest';
import { configureBrowserSetup, type BrowserSetupOptions } from '../src/txt-acquisition/setup.ts';
// Protocol/state fixtures, never proof of OS isolation or a production controller.
function fixture() {
  const settings={allowNetwork:false,txtAcquisitionEnabled:false,browserBridgeEnabled:false};
  const protection={controllerReady:true,transportConnected:true};
  const persist=vi.fn((patch:Record<string,unknown>)=>Object.assign(settings,patch));
  const options:BrowserSetupOptions={platform:'win32',settings:()=>settings,
    readiness:()=>({...protection,browserReady:protection.controllerReady&&protection.transportConnected&&settings.allowNetwork&&settings.txtAcquisitionEnabled&&settings.browserBridgeEnabled}),persist,changed:vi.fn()};
  return{settings,protection,persist,options};
}
describe('one-click browser configuration',()=>{
  it.each(['linux','darwin'])('does not modify settings on unsupported %s',platform=>{
    const x=fixture();x.options.platform=platform;expect(configureBrowserSetup(x.options,true)).toMatchObject({state:'blocked',reason:'unsupported_platform',changed:false});expect(x.persist).not.toHaveBeenCalled();
  });
  it('stops at the missing controller without enabling network or starting manual pairing',()=>{
    const x=fixture();x.protection.controllerReady=false;const result=configureBrowserSetup(x.options,true);
    expect(result).toMatchObject({state:'blocked',reason:'controller_unavailable',changed:false});
    expect(result.steps.map(s=>s.state)).toEqual(['done','blocked','pending','pending','pending']);expect(x.persist).not.toHaveBeenCalled();
  });
  it('does not equate controller readiness with a protected browser connection',()=>{
    const x=fixture();x.protection.transportConnected=false;expect(configureBrowserSetup(x.options,true).reason).toBe('pairing_unavailable');expect(x.persist).not.toHaveBeenCalled();
  });
  it('requires explicit permission to enable global BookFish network access',()=>{
    const x=fixture();expect(configureBrowserSetup(x.options,false)).toMatchObject({state:'consent_required',reason:'network_consent'});expect(x.persist).not.toHaveBeenCalled();
    const result=configureBrowserSetup(x.options,true);expect(result.state).toBe('ready');expect(result.changed).toBe(true);expect(x.settings).toEqual({allowNetwork:true,txtAcquisitionEnabled:true,browserBridgeEnabled:true});
    expect(configureBrowserSetup(x.options,false)).toMatchObject({state:'ready',changed:false});expect(x.persist).toHaveBeenCalledTimes(1);
  });
  it('enables local acquisition settings with already-authorized network access',()=>{
    const x=fixture();x.settings.allowNetwork=true;expect(configureBrowserSetup(x.options,false).state).toBe('ready');expect(x.persist).toHaveBeenCalledWith({txtAcquisitionEnabled:true,browserBridgeEnabled:true});
  });
  it('does not claim setup is complete when host persistence is unavailable',()=>{
    const x=fixture();x.options.persist=undefined;expect(configureBrowserSetup(x.options,true)).toMatchObject({state:'blocked',reason:'settings_unavailable',changed:false});expect(x.persist).not.toHaveBeenCalled();
  });
  it('rolls back when protection disappears during configuration',()=>{
    const x=fixture();x.options.changed=()=>{x.protection.controllerReady=false;};expect(configureBrowserSetup(x.options,true)).toMatchObject({state:'failed',reason:'verification_failed',changed:false});expect(x.settings).toEqual({allowNetwork:false,txtAcquisitionEnabled:false,browserBridgeEnabled:false});
  });
  it('reports persistence failure and distinguishes an unsuccessful rollback',()=>{
    const x=fixture();x.persist.mockImplementationOnce(()=>{throw Error('disk full');});expect(configureBrowserSetup(x.options,true)).toMatchObject({state:'failed',reason:'settings_unavailable',changed:false});
    x.persist.mockImplementation(()=>{throw Error('storage unavailable');});expect(configureBrowserSetup(x.options,true)).toMatchObject({state:'failed',reason:'settings_unavailable',changed:true});
  });
});
