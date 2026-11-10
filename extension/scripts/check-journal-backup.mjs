// Validate a real Bookfish backup in an isolated library; never restores over the user's live data.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Library } from '../src/library.ts';
const base = join(process.cwd(), 'output', 'host-fixture'); mkdirSync(base, { recursive: true });
const target = mkdtempSync(join(base, 'stage5-restore-'));
const proof = JSON.parse(readFileSync('output/live-stage5-reading-proof.json', 'utf8'));
const backup = readFileSync('output/live-backups/stage5-bookfish-backup.json', 'utf8');
const lib = new Library({ dataDir: target });
try {
  lib.open(); lib.restore(backup);
  const original = lib.episode(proof.original.episode.id), revision = lib.episode(proof.revision.episode.id);
  const checks = {
    progressRestored: lib.status().current.confirmedChars === proof.state.status.library.current.confirmedChars,
    originalRestored: isDeepStrictEqual(original.episode, proof.original.episode),
    revisionRestored: isDeepStrictEqual(revision.episode, proof.revision.episode),
    evidenceRestored: isDeepStrictEqual(original.evidence, proof.original.evidence),
    moodTimestampRestored: lib.journal().mood.recordedAt === proof.state.journal.mood.recordedAt,
    oldRangesNotInvented: lib.journal().rangesWithoutReadingEpisode === 2,
  };
  writeFileSync('output/live-stage5-backup-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), checks,
    limits: 'Real source/model-authored backup restored into an isolated Library, not a live-instance destructive restore.' }, null, 2));
  console.log(JSON.stringify(checks)); if (Object.values(checks).some(v => !v)) process.exitCode = 1;
} finally { lib.close(); }
