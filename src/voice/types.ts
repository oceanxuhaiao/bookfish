/** Public voice types. They never contain the API key or book text. */

export type VoicePhase = 'disabled' | 'idle' | 'starting' | 'playing' | 'waiting_content' | 'paused' | 'error';

export type VoiceStopReason = 'user' | 'chat' | 'book_changed' | 'pause' | 'shutdown' | 'config' | 'key' | 'restart' | 'error' | 'complete';

export interface VoiceStatus {
  enabled: boolean;
  phase: VoicePhase;
  bookKey: string | null;
  title: string | null;
  /** Segment currently being voiced (or the next one when idle). */
  segmentId: number | null;
  /** Largest segment that has been fully voiced, contiguous from the session start. */
  voicedUpTo: number | null;
  totalSegments: number | null;
  keyConfigured: boolean;
  error: string | null;
  detail: string | null;
}

/** Read-only view of the selected book. No task, progress or generation change. */
export interface VoiceBookSnapshot {
  bookKey: string;
  title: string;
  generation: number;
  frontier: number;
  totalSegments: number;
  paused: boolean;
  complete: boolean;
  readiness: string;
}

export interface VoiceSegment {
  id: number;
  text: string;
}

/** Implemented by BookFish; the voice module can only read cached text. */
export interface VoiceReadPort {
  snapshot(): VoiceBookSnapshot | null;
  segments(from: number, max: number): VoiceSegment[];
  /** Existing unconfirmed task, read-only. Starting the voice must not switch semantics mid-task. */
  pendingTask?(): { taskId: string; segmentId: number } | null;
  /** Full read-only pending metadata, including expiry and identity. */
  pendingTasks?(): Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }>;
}

/** The scheduler reads this synchronously; `upper` is the last fully voiced segment. */
export interface VoiceGate {
  enabled: boolean;
  upper: number | null;
  bookKey: string | null;
  generation: number | null;
}

export interface VoiceLogger {
  warn(message: string, detail?: Record<string, unknown>): void;
  info?(message: string, detail?: Record<string, unknown>): void;
}

export interface VoicePlaybackEngine {
  attach(log?: VoiceLogger): void;
  start(): Promise<VoiceStatus>;
  stop(reason?: VoiceStopReason): Promise<void>;
  status(): VoiceStatus;
  gate(): VoiceGate;
  onRunPhase(phase: { state: string }): void;
  revalidate(): Promise<void>;
  onConfigChanged(): Promise<void>;
  onKeyChanged(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;
}