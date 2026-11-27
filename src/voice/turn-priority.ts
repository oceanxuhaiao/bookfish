/**
 * A main-session model turn is BookFish's own reading turn only when BookFish
 * holds a main-mode reading opportunity and no external event has been stored
 * since the last idle observation. Anything else — user chat, another World's
 * event, background cognition beside a main turn — stops read-aloud.
 */
export interface MainTurnSignals {
  activeReadingMode: 'background' | 'main' | null;
  hasExternalSinceIdle: boolean;
}

export function isBookfishReadingTurn(signals: MainTurnSignals): boolean {
  return signals.activeReadingMode === 'main' && !signals.hasExternalSinceIdle;
}