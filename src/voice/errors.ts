export type VoiceErrorCode =
  | 'config'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid_audio'
  | 'aborted'
  | 'playback'
  | 'state';

/** A classified voice failure. Messages are bounded and never contain the API key. */
export class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

export class VoiceConfigError extends VoiceError {
  constructor(message: string) {
    super('config', message);
    this.name = 'VoiceConfigError';
  }
}

export class TtsError extends VoiceError {
  constructor(code: VoiceErrorCode, message: string) {
    super(code, message);
    this.name = 'TtsError';
  }
}

export class AudioPlaybackError extends VoiceError {
  constructor(message: string) {
    super('playback', message);
    this.name = 'AudioPlaybackError';
  }
}

/** Bound a message shown to the user or written to a log. Never pass text or keys here. */
export function safeMessage(error: unknown, max = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function redact(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join('[redacted]');
}