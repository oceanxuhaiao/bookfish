import { describe, expect, it } from 'vitest';
import { isBookfishReadingTurn } from '../src/voice/turn-priority.ts';

describe('main-turn chat priority classification', () => {
  it('recognizes only a main-mode reading opportunity without external events', () => {
    expect(isBookfishReadingTurn({ activeReadingMode: 'main', hasExternalSinceIdle: false })).toBe(true);
  });

  it('never treats background cognition as a main reading turn', () => {
    expect(isBookfishReadingTurn({ activeReadingMode: 'background', hasExternalSinceIdle: false })).toBe(false);
  });

  it('stops on any external event even when a main reading opportunity exists', () => {
    expect(isBookfishReadingTurn({ activeReadingMode: 'main', hasExternalSinceIdle: true })).toBe(false);
  });

  it('stops when no BookFish opportunity exists', () => {
    expect(isBookfishReadingTurn({ activeReadingMode: null, hasExternalSinceIdle: false })).toBe(false);
    expect(isBookfishReadingTurn({ activeReadingMode: null, hasExternalSinceIdle: true })).toBe(false);
  });
});