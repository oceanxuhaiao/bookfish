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
  /** False when an interrupted upload cannot be proven to be the same archive. */
  reselectable: boolean;
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
}

export interface ImportBatch { id: string; source: 'files' | 'folder' | 'zip'; status: BatchStatus; toPlan: boolean }

export type ImportBatchSummary = Pick<ImportBatchView, 'id' | 'source' | 'status' | 'toPlan' | 'total' | 'completed' | 'failed' | 'cancelled' | 'needsReselect' | 'pending' | 'title' | 'createdAt' | 'updatedAt'>;
