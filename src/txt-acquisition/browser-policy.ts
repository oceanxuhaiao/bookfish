import type { BookfishConfigSection } from '../config.ts';

/** User-owned policy. Model tools cannot change settings or supply consent. */
export function browserPolicy(cfg: Pick<BookfishConfigSection, 'browserProtectionMode' | 'browserStandardConsent'>, controllerReady: boolean) {
  const protectionMode = cfg.browserProtectionMode === 'standard' ? 'standard' : 'enhanced';
  const standardAccepted = protectionMode === 'standard' && cfg.browserStandardConsent === true;
  return { protectionMode, standardAccepted, browserAccessAllowed: standardAccepted || (protectionMode === 'enhanced' && controllerReady),
    isolationVerified: protectionMode === 'enhanced' && controllerReady };
}
