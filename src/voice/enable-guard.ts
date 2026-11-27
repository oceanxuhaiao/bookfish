/**
 * Enabling read-aloud changes how the next reading opportunity is authorized.
 * It must happen at a clean reading boundary; an already supplied range keeps
 * its original meaning until it is finished or safely cancelled.
 */
export interface VoiceEnableState {
  pendingTask: boolean;
  activeOpportunity: boolean;
  cognitionRunning: boolean;
  manualState: string | null;
  hostPhase: string;
}

export function voiceEnableBlocker(state: VoiceEnableState): string | null {
  if (state.pendingTask) {
    return '大肥鱼还有一段已经发出、尚未确认的正文。请等本轮阅读结束或安全取消后再启用语音朗读。';
  }
  if (state.activeOpportunity) {
    return '大肥鱼正在处理一次阅读机会。请等这次阅读结束后再启用语音朗读。';
  }
  if (state.cognitionRunning) {
    return '上一次阅读仍在结束中。请稍后再启用语音朗读。';
  }
  if (state.manualState === 'queued' || state.manualState === 'reading') {
    return '大肥鱼还有未完成的阅读请求。请等这次阅读结束后再启用语音朗读。';
  }
  if (state.hostPhase !== 'idle' && state.hostPhase !== 'unknown') {
    return '大肥鱼当前正在处理对话或工具调用。请等回到空闲后再启用语音朗读。';
  }
  return null;
}