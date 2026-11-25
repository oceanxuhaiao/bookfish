/** Wire shapes the shelf panel reads for batch import. Kept slim on purpose. */
export type BatchStatus = 'preview' | 'running' | 'completed' | 'cancelled';
export type BatchItemStatus = 'pending' | 'importing' | 'processing' | 'validating' | 'completed' | 'failed' | 'cancelled' | 'needs_reselect';

export interface ImportBatchItemView {
  id: string;
  name: string;
  title: string;
  author: string;
  size: number;
  supported: boolean;
  status: BatchItemStatus;
  attempts: number;
  bookKey?: string;
  error?: string;
  duplicate: 'identical' | 'new_version' | 'in_batch' | null;
  duplicateOf: string | null;
  group: string | null;
}

export interface ImportBatchGroupView {
  key: string;
  name: string;
  itemIds: string[];
  evidence: 'folder' | 'title' | 'filename';
  confidence: 'high' | 'low';
  /** The rows may equally be one novel split into several files. */
  mayBeSplitNovel: boolean;
  ambiguous: boolean;
}

export interface ImportBatchPreview {
  batchId: string;
  source: 'files' | 'folder' | 'zip';
  status: BatchStatus;
  toPlan: boolean;
  count: number;
  supported: number;
  unsupported: string[];
  estimatedBytes: number;
  suspectedDuplicates: number;
  inBatchDuplicates: number;
  items: ImportBatchItemView[];
  groups: ImportBatchGroupView[];
  cancelled: number;
  failed: number;
  needsReselect: number;
}

export interface ImportBatchZipView {
  name: string;
  size: number;
  state: 'uploading' | 'needs_reselect' | 'ready' | 'extracted';
  sha256?: string;
  peakBytes?: number;
  /** Why the last extraction attempt stopped; `ready` is kept for all of them. */
  failure?: 'missing' | 'unverifiable' | 'over_limit' | 'disk' | 'transient';
  error?: string;
  /** Structured whole-archive refusal; present whenever the package was refused. */
  rejection?: ImportBatchZipRejection;
  /** False when an interrupted upload cannot be proven to be the same archive. */
  reselectable: boolean;
}

/**
 * A whole-archive refusal, persisted with the batch so it survives a restart and
 * a closed panel. `null` figures are "not measured", never zero.
 */
export interface ImportBatchZipRejection {
  kind: 'count' | 'bytes' | 'entry' | 'disk' | 'plan';
  reason: string;
  /** True when the figures come from a real extraction, not the archive index. */
  measured: boolean;
  totalBytes: number | null;
  budgetBytes: number | null;
  books: number | null;
  limit: number;
  /** Books accepted before the refusal (0 unless a retry re-extracted). */
  accepted: number;
  partiallyStaged: false;
  archiveKept: true;
  names: string[];
  nextStep: string;
}

/**
 * What a batch took in, what reached the shelf, and everything it refused.
 * A completion banner without the last part is a partial import sold as success.
 */
export interface ImportBatchReport {
  accepted: number;
  shelfAdded: number;
  pending: number;
  failed: number;
  cancelled: number;
  needsReselect: number;
  duplicate: number;
  unsupported: number;
  tooLarge: number;
  overBudget: number;
  overflow: number;
  rejectedNames: { duplicate: string[]; unsupported: string[]; tooLarge: string[]; overBudget: string[]; overflow: string[] };
  incomplete: boolean;
  archiveRejected: ImportBatchZipRejection | null;
}

export interface ImportBatchView extends ImportBatchPreview {
  zip?: ImportBatchZipView;
  id: string;
  total: number;
  completed: number;
  pending: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  report: ImportBatchReport;
}

export interface ImportBatch { id: string; source: 'files' | 'folder' | 'zip'; status: BatchStatus; toPlan: boolean }

export type ImportBatchSummary = Pick<ImportBatchView, 'id' | 'source' | 'status' | 'toPlan' | 'total' | 'completed' | 'failed' | 'cancelled' | 'needsReselect' | 'pending' | 'title' | 'createdAt' | 'updatedAt'>;
