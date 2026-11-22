import {describe,it,expect,vi} from 'vitest';
import {browserPolicy} from '../src/txt-acquisition/browser-policy.ts';
import {configureStandardBrowserSetup,type BrowserSetupOptions} from '../src/txt-acquisition/setup.ts';
describe('user-approved standard browser mode',()=>{
  it('keeps default enhanced mode closed and does not invent controller isolation',()=>{
    expect(browserPolicy({},false)).toMatchObject({protectionMode:'enhanced',browserAccessAllowed:false,isolationVerified:false});
    expect(browserPolicy({browserProtectionMode:'standard',browserStandardConsent:false},false).browserAccessAllowed).toBe(false);
    expect(browserPolicy({browserProtectionMode:'standard',browserStandardConsent:true},false)).toMatchObject({browserAccessAllowed:true,isolationVerified:false});
  });
  function fixture(){
    const cfg={allowNetwork:false,txtAcquisitionEnabled:false,browserBridgeEnabled:false,browserProtectionMode:'enhanced' as 'enhanced'|'standard',browserStandardConsent:false};let connected=false;
    const persist=vi.fn((patch:Record<string,unknown>)=>Object.assign(cfg,patch));const prepare=vi.fn(async()=>{});
    const options:BrowserSetupOptions={platform:'win32',settings:()=>cfg,persist,changed:()=>{},readiness:()=>({controllerReady:false,transportConnected:connected,browserReady:connected&&cfg.allowNetwork&&cfg.txtAcquisitionEnabled&&cfg.browserBridgeEnabled&&browserPolicy(cfg,false).browserAccessAllowed})};
    return{cfg,persist,prepare,options,connect:()=>{connected=true;}};
  }
  it('requires ordinary-mode and network permission before changing settings',async()=>{
    const f=fixture();expect(await configureStandardBrowserSetup(f.options,true,false,f.prepare)).toMatchObject({reason:'standard_consent',changed:false});
    expect(await configureStandardBrowserSetup(f.options,false,true,f.prepare)).toMatchObject({reason:'network_consent',changed:false});expect(f.persist).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it('starts transport without a controller and waits for user-granted extension access',async()=>{
    const f=fixture();expect(await configureStandardBrowserSetup(f.options,true,true,f.prepare)).toMatchObject({state:'waiting_extension',reason:'extension_connection',changed:true});expect(f.cfg).toMatchObject({browserProtectionMode:'standard',browserStandardConsent:true,allowNetwork:true,browserBridgeEnabled:true});
    f.connect();expect(await configureStandardBrowserSetup(f.options,false,false,f.prepare)).toMatchObject({state:'ready',changed:false});expect(f.options.readiness().controllerReady).toBe(false);expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it('does not restore consent revoked while transport is preparing',async()=>{
    const f=fixture();f.prepare.mockImplementation(async()=>{f.cfg.browserProtectionMode='enhanced';f.cfg.browserStandardConsent=false;});
    expect((await configureStandardBrowserSetup(f.options,true,true,f.prepare)).state).toBe('failed');expect(f.cfg).toMatchObject({browserProtectionMode:'enhanced',browserStandardConsent:false,allowNetwork:false});
  });
  it('rolls back a transport failure instead of leaving ordinary mode enabled',async()=>{
    const f=fixture();f.prepare.mockRejectedValueOnce(Error('port occupied'));expect(await configureStandardBrowserSetup(f.options,true,true,f.prepare)).toMatchObject({state:'failed',reason:'bridge_unavailable',changed:false});expect(f.cfg).toMatchObject({browserProtectionMode:'enhanced',browserStandardConsent:false,allowNetwork:false});
  });
});
