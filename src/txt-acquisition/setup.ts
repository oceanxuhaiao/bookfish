/** Local setup orchestration. It cannot install a controller or assert protection. */
export type SetupStepId = 'environment' | 'controller' | 'browser' | 'extension' | 'verification';
export interface BrowserSetupResult {
  state: 'ready' | 'blocked' | 'consent_required' | 'failed';
  reason: 'ready' | 'unsupported_platform' | 'controller_unavailable' | 'pairing_unavailable' | 'network_consent' | 'settings_unavailable' | 'verification_failed';
  steps: Array<{ id: SetupStepId; state: 'done' | 'blocked' | 'pending' | 'action_required' }>;
  changed: boolean;
}
interface Settings { allowNetwork: boolean; txtAcquisitionEnabled?: boolean; browserBridgeEnabled?: boolean }
interface Readiness { controllerReady: boolean; transportConnected: boolean; browserReady: boolean }
export interface BrowserSetupOptions {
  platform: string;
  settings(): Settings;
  readiness(): Readiness;
  persist?: (patch: Partial<Settings>) => void;
  changed(): void;
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
