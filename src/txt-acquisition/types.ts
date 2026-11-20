/** Shared types and invariants for the browser-assisted TXT acquisition engine. */
export const CANDIDATE_TTL_MS = 30 * 60_000;
export const MAX_CANDIDATES = 40;
export const MAX_TASKS = 100;
export const MAX_HISTORY = 60;
export const MAX_DISCOVERY_LINKS = 40;
export const MAX_REDIRECTS = 5;

export type AcquisitionStatus =
  | 'queued' | 'discovering' | 'candidate_ready' | 'downloading' | 'validating'
  | 'needs_repair' | 'repairing' | 'importing' | 'completed'
  | 'completed_with_warning' | 'failed_recoverable' | 'failed_terminal';

export const TERMINAL_STATUSES: readonly AcquisitionStatus[] = ['completed', 'completed_with_warning', 'failed_recoverable', 'failed_terminal'];
export const isTerminal = (status: AcquisitionStatus): boolean => TERMINAL_STATUSES.includes(status);

const TRANSITIONS: Readonly<Record<AcquisitionStatus, readonly AcquisitionStatus[]>> = {
  queued: ['discovering', 'downloading', 'failed_recoverable', 'failed_terminal'],
  discovering: ['candidate_ready', 'failed_recoverable', 'failed_terminal'],
  candidate_ready: ['downloading', 'failed_recoverable', 'failed_terminal'],
  downloading: ['validating', 'failed_recoverable', 'failed_terminal'],
  validating: ['needs_repair', 'repairing', 'importing', 'failed_recoverable', 'failed_terminal'],
  needs_repair: ['repairing', 'validating', 'failed_recoverable', 'failed_terminal'],
  repairing: ['importing', 'failed_recoverable', 'failed_terminal'],
  importing: ['completed', 'completed_with_warning', 'failed_recoverable', 'failed_terminal'],
  completed: [],
  // Repairing an imported-but-flawed file produces a new revision; the old one stays.
  completed_with_warning: ['validating'],
  failed_recoverable: ['downloading', 'repairing', 'importing', 'discovering', 'failed_terminal'],
  // A terminal failure still keeps its bytes. Retrying it is an explicit user
  // decision, so it may reuse the retained file or the page it came from.
  failed_terminal: ['validating', 'downloading', 'discovering'],
};

export function canTransition(from: AcquisitionStatus, to: AcquisitionStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AcquisitionStatus, to: AcquisitionStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid acquisition transition ${from} -> ${to}`);
}

export type QualityLevel = 'clean' | 'warning' | 'partial';

export interface QualityIssue { code: string; message: string; count?: number }

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'gb18030' | 'utf-16le' | 'utf-16be';

export interface QualityReport {
  quality: QualityLevel;
  encoding: DetectedEncoding;
  readableChars: number;
  totalChars: number;
  warnings: QualityIssue[];
  repairs: QualityIssue[];
  truncated: boolean;
  suspectedPartial: boolean;
}

export interface RepairOutcome {
  text: string;
  encoding: DetectedEncoding;
  repairs: QualityIssue[];
  truncatedTail: boolean;
  replacementChars: number;
}

export type FileFormat = 'txt' | 'md';

export interface DiscoveredLink {
  url: string;
  filename: string;
  format: FileFormat;
  title?: string;
  author?: string;
  size?: number;
  /** Surrounding anchor text, capped for receipts. */
  label?: string;
}

export interface CandidateRecord {
  id: string;
  filename: string;
  format: FileFormat;
  host: string;
  /** URLs are deliberately not persisted (they may carry signatures); only a digest is kept. */
  urlHash: string;
  title?: string;
  author?: string;
  size?: number;
  discoveredAt: number;
  expiresAt: number;
}

export interface FileRecord {
  sha256: string;
  bytes: number;
  filename: string;
  /** Relative to the acquisition root, e.g. files/<sha256>.txt */
  path?: string;
  retained: boolean;
  contentType?: string;
}

export interface FailureRecord { code: string; message: string; recoverable: boolean; at: number }

export type AcquisitionOrigin = 'manual' | 'autonomous';

export interface AcquisitionTask {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: AcquisitionStatus;
  origin: AcquisitionOrigin;
  intentId?: string;
  target: { title: string; author?: string };
  pageUrl?: string;
  sourceHost: string;
  candidates: CandidateRecord[];
  selectedCandidateId?: string;
  file?: FileRecord;
  quality?: QualityReport;
  bookKey?: string;
  duplicate?: boolean;
  rejection?: { code: string; message: string };
  failure?: FailureRecord;
  attempts: { downloads: number; imports: number; repairs: number };
  history: Array<{ at: number; status: AcquisitionStatus; note?: string }>;
}

export interface AcquisitionState { schema: 1; tasks: AcquisitionTask[] }

/** Failure codes distinguish "download again", "reprocess the retained file" and "nothing to retry". */
export const FAILURE_RECOVERABLE: Readonly<Record<string, boolean>> = {
  network: true,
  timeout: true,
  cancelled: true,
  restart_interrupted: true,
  browser_unavailable: false,
  policy_blocked: false,
  download_failed: true,
  http_error: true,
  too_large: false,
  empty_file: false,
  binary_file: false,
  unreadable_text: true,
  encoding_damaged: true,
  not_a_book: false,
  import_failed: true,
  storage_unavailable: true,
  candidate_expired: true,
  candidate_unknown: true,
  no_candidates: true,
  network_disabled: false,
  disabled: false,
  library_full: false,
  invalid_input: false,
};

export function failureRecoverable(code: string): boolean {
  return FAILURE_RECOVERABLE[code] ?? true;
}

export interface TaskView {
  taskId: string;
  status: AcquisitionStatus;
  origin: AcquisitionOrigin;
  target: { title: string; author?: string };
  intentId?: string;
  pageUrl?: string;
  sourceHost: string;
  bookKey?: string;
  duplicate?: boolean;
  quality?: QualityReport;
  file?: { filename: string; bytes: number; sha256: string; retained: boolean; contentType?: string };
  candidates?: Array<{ candidateId: string; filename: string; format: FileFormat; host: string; title?: string; author?: string; size?: number; expiresAt: number; available: boolean }>;
  failure?: FailureRecord;
  rejection?: { code: string; message: string };
  nextActions: string[];
  updatedAt: number;
}

/** Guard every persisted record so a corrupted or hand-edited file fails closed. */
export function validateAcquisitionState(raw: unknown): AcquisitionState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid acquisition records');
  const state = raw as AcquisitionState;
  if (state.schema !== 1 || !Array.isArray(state.tasks)) throw new Error('Invalid acquisition records');
  if (state.tasks.length > MAX_TASKS) throw new Error('Acquisition record count exceeds limit');
  const ids = new Set<string>();
  for (const task of state.tasks) {
    if (!task || typeof task !== 'object') throw new Error('Invalid acquisition task');
    if (typeof task.id !== 'string' || !/^[a-f0-9-]{36}$/.test(task.id) || ids.has(task.id)) throw new Error('Invalid acquisition task id');
    ids.add(task.id);
    if (!(task.status in TRANSITIONS)) throw new Error('Invalid acquisition status');
    if (task.origin !== 'manual' && task.origin !== 'autonomous') throw new Error('Invalid acquisition origin');
    if (!task.target || typeof task.target.title !== 'string') throw new Error('Invalid acquisition target');
    if (!Array.isArray(task.candidates) || task.candidates.length > MAX_CANDIDATES) throw new Error('Invalid acquisition candidates');
    for (const candidate of task.candidates) {
      if (!candidate || typeof candidate.id !== 'string' || !/^[a-f0-9-]{36}$/.test(candidate.id)) throw new Error('Invalid acquisition candidate');
      if (candidate.format !== 'txt' && candidate.format !== 'md') throw new Error('Invalid acquisition format');
      if (typeof candidate.urlHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.urlHash)) throw new Error('Invalid candidate digest');
    }
    if (task.file && (typeof task.file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.file.sha256) || !Number.isSafeInteger(task.file.bytes) || task.file.bytes < 0)) throw new Error('Invalid acquisition file record');
    if (!Array.isArray(task.history) || task.history.length > MAX_HISTORY) throw new Error('Invalid acquisition history');
    for (const entry of task.history) if (!entry || typeof entry.at !== 'number' || !(entry.status in TRANSITIONS)) throw new Error('Invalid acquisition history entry');
    if (!task.attempts || !Number.isSafeInteger(task.attempts.downloads)) throw new Error('Invalid acquisition attempts');
  }
  return state;
}

