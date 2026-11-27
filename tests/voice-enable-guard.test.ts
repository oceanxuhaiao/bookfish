import { describe, expect, it } from 'vitest';
import { voiceEnableBlocker } from '../src/voice/enable-guard.ts';

const clean = { pendingTask: false, activeOpportunity: false, cognitionRunning: false, manualState: null, hostPhase: 'idle' };

describe('voice enable guard', () => {
  it('allows a clean idle boundary and the pre-observation boundary', () => {
    expect(voiceEnableBlocker(clean)).toBeNull();
    expect(voiceEnableBlocker({ ...clean, hostPhase: 'unknown' })).toBeNull();
  });

  it('rejects every in-flight reading state', () => {
    expect(voiceEnableBlocker({ ...clean, pendingTask: true })).toMatch(/未确认的正文/);
    expect(voiceEnableBlocker({ ...clean, activeOpportunity: true })).toMatch(/阅读机会/);
    expect(voiceEnableBlocker({ ...clean, cognitionRunning: true })).toMatch(/仍在结束中/);
    expect(voiceEnableBlocker({ ...clean, manualState: 'queued' })).toMatch(/阅读请求/);
    expect(voiceEnableBlocker({ ...clean, manualState: 'reading' })).toMatch(/阅读请求/);
  });

  it('rejects a busy main-session phase', () => {
    for (const hostPhase of ['delivering', 'model', 'tools', 'backoff', 'handoff']) {
      expect(voiceEnableBlocker({ ...clean, hostPhase })).toMatch(/对话或工具调用/);
    }
  });

  it('does not treat finished manual states as blockers', () => {
    for (const manualState of ['completed', 'failed', 'cancelled', 'deferred', 'expired']) {
      expect(voiceEnableBlocker({ ...clean, manualState })).toBeNull();
    }
  });
});