export { VoiceCoordinator } from './coordinator.ts';
export type { VoiceCoordinatorOptions } from './coordinator.ts';
export { splitChunks, DEFAULT_CHUNK_CHARS } from './chunk.ts';
export { synthesize, isWav, MIMO_TTS } from './tts.ts';
export { playWav, sweepTempDir, powershellPath, psSingleQuote } from './player.ts';
export { VoiceError, VoiceConfigError, TtsError, AudioPlaybackError, safeMessage } from './errors.ts';
export type {
  VoiceBookSnapshot, VoiceGate, VoiceLogger, VoicePhase, VoicePlaybackEngine, VoiceReadPort,
  VoiceSegment, VoiceStatus, VoiceStopReason,
} from './types.ts';