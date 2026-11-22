/** Local setup orchestration. It cannot install a controller or assert protection. */
export type SetupStepId = 'environment' | 'controller' | 'browser' | 'extension' | 'verification';
export interface BrowserSetupResult {
  state: 'ready' | 'blocked' | 'consent_required' | 'failed' | 'waiting_extension';
  reason: 'ready' | 'unsupported_platform' | 'controller_unavailable' | 'pairing_unavailable' | 'network_consent' | 'settings_unavailable' | 'verification_failed' | 'standard_consent' | 'extension_connection' | 'bridge_unavailable';
  steps: Array<{ id: SetupStepId; state: 'done' | 'blocked' | 'pending' | 'action_required' | 'not_required' }>;
  changed: boolean;
}
interface Settings { allowNetwork: boolean; txtAcquisitionEnabled?: boolean; browserBridgeEnabled?: boolean; browserProtectionMode?:'enhanced'|'standard'; browserStandardConsent?:boolean }
interface Readiness { controllerReady: boolean; transportConnected: boolean; browserReady: boolean }
export interface BrowserSetupOptions {
  platform: string;
  settings(): Settings;
  readiness(): Readiness;
  persist?: (patch: Partial<Settings>) => void;
  changed(): void;
}

/** Standard mode is a real user opt-in, never a fabricated controller signal. */
export async function configureStandardBrowserSetup(options: BrowserSetupOptions, allowNetwork: boolean, acceptStandard: boolean, prepareTransport: () => Promise<unknown>): Promise<BrowserSetupResult> {
  const before={...options.settings()};
  const steps:BrowserSetupResult['steps']=[{id:'environment',state:'done'},{id:'controller',state:'not_required'},{id:'browser',state:'not_required'},{id:'extension',state:'pending'},{id:'verification',state:'pending'}];
  const result=(state:BrowserSetupResult['state'],reason:BrowserSetupResult['reason'],changed=false):BrowserSetupResult=>({state,reason,changed,steps});
  if(!acceptStandard&&!(before.browserProtectionMode==='standard'&&before.browserStandardConsent===true)){steps[3].state='action_required';return result('consent_required','standard_consent');}
  if(!before.allowNetwork&&!allowNetwork){steps[4].state='action_required';return result('consent_required','network_consent');}
  const patch:Partial<Settings>={};
  for(const [key,value] of Object.entries({browserProtectionMode:'standard',browserStandardConsent:true,txtAcquisitionEnabled:true,browserBridgeEnabled:true,...(!before.allowNetwork?{allowNetwork:true}:{})}))if(before[key as keyof Settings]!==value)(patch as Record<string,unknown>)[key]=value;
  const changed=Object.keys(patch).length>0;
  if(changed&&!options.persist)return result('blocked','settings_unavailable');
  let preparing=false;
  try{
    if(changed){options.persist!(patch);options.changed();}
    preparing=true;await prepareTransport();
    const cfg=options.settings(),live=options.readiness();
    if(cfg.browserProtectionMode!=='standard'||!cfg.browserStandardConsent||!cfg.allowNetwork||!cfg.txtAcquisitionEnabled||!cfg.browserBridgeEnabled)throw Error('Browser policy revoked');
    if(!live.transportConnected){steps[3].state='action_required';return result('waiting_extension','extension_connection',changed);}
    if(!live.browserReady)throw Error('Final verification failed');
    steps[3].state=steps[4].state='done';return result('ready','ready',changed);
  }catch{
    let rollbackFailed=false;
    if(changed&&options.persist){
      const cfg=options.settings();const rollback=Object.fromEntries(Object.keys(patch).filter(key=>cfg[key as keyof Settings]===patch[key as keyof Settings]).map(key=>[key,before[key as keyof Settings]]));
      try{options.persist(rollback);options.changed();await prepareTransport();}catch{rollbackFailed=true;}
    }
    steps[4].state='blocked';return result('failed',rollbackFailed?'settings_unavailable':preparing?'bridge_unavailable':'settings_unavailable',rollbackFailed);
  }
}

export function configureBrowserSetup(options: BrowserSetupOptions, allowNetwork: boolean): BrowserSetupResult {
  const steps: BrowserSetupResult['steps'] = ['environment','controller','browser','extension','verification'].map(id => ({ id: id as SetupStepId, state: 'pending' }));
  const stop = (at: number, state: BrowserSetupResult['state'], reason: BrowserSetupResult['reason']): BrowserSetupResult => {
    steps[at].state = state === 'consent_required' ? 'action_required' : 'blocked'; return { state, reason, steps, changed: false };
  };
  if (options.platform !== 'win32') return stop(0, 'blocked', 'unsupported_platform');
  steps[0].state = 'done';
  const readiness = options.readiness();
  // The production World has no controller adapter. No simulated install or launch.
  if (!readiness.controllerReady) return stop(1, 'blocked', 'controller_unavailable');
  steps[1].state = 'done';
  // A controller's readiness is not proof that a browser is connected. The
  // existing bridge only exposes transport readiness; no auto-pair adapter exists.
  if (!readiness.transportConnected) return stop(2, 'blocked', 'pairing_unavailable');
  steps[2].state = steps[3].state = 'done';
  const before = { ...options.settings() };
  if (!before.allowNetwork && !allowNetwork) return stop(4, 'consent_required', 'network_consent');
  const patch: Partial<Settings> = {};
  if (!before.allowNetwork) patch.allowNetwork = true;
  if (before.txtAcquisitionEnabled !== true) patch.txtAcquisitionEnabled = true;
  if (before.browserBridgeEnabled !== true) patch.browserBridgeEnabled = true;
  const changed = Object.keys(patch).length > 0;
  if (changed && !options.persist) return stop(4, 'blocked', 'settings_unavailable');
  let applied = !changed;
  try {
    if (changed) { options.persist!(patch); options.changed(); }
    applied = true;
    const after = options.settings(), verified = options.readiness();
    if (!after.allowNetwork || !after.txtAcquisitionEnabled || !after.browserBridgeEnabled || !verified.controllerReady || !verified.transportConnected || !verified.browserReady) throw new Error('Protection verification failed');
    steps[4].state = 'done'; return { state: 'ready', reason: 'ready', steps, changed };
  } catch {
    // Roll back only the fields this attempt changed. Never leave a false ready
    // receipt after a storage failure or loss of protection during setup.
    if (changed && options.persist) {
      const rollback = Object.fromEntries(Object.keys(patch).map(key => [key, before[key as keyof Settings]]));
      try { options.persist(rollback); options.changed(); }
      catch { return { ...stop(4, 'failed', 'settings_unavailable'), changed: true }; }
    }
    return stop(4, 'failed', applied ? 'verification_failed' : 'settings_unavailable');
  }
}
