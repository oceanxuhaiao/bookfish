#!/usr/bin/env node
/**
 * Reproduce the v3 footprint evidence check locally.
 *
 * Inputs:
 *   --evidence  output/token-optimization/footprint-review-v3-evidence.json
 *   --manifest  output/token-optimization/footprint-review-v2-manifest.json
 *   --data      <Coopanion>/data/home/companion/data/bookfish
 *
 * For every sample it loads the same book revision, reads the recorded
 * segment, slices [absoluteStart, absoluteEnd), and compares the text hash
 * with the recorded quote hash. It never prints novel text.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadPagedBook, PageCache } from '../src/paged-book.ts';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) if (process.argv[i]?.startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.evidence || !args.manifest || !args.data) {
  console.error('usage: tsx scripts/verify-footprint-evidence.mts --evidence v3.json --manifest v2.json --data <bookfish data dir>');
  process.exit(2);
}
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const evidence = JSON.parse(readFileSync(args.evidence, 'utf8'));
const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
const library = JSON.parse(readFileSync(join(args.data, 'library.json'), 'utf8'));
const books = new Map();
for (const entry of library.books) {
  const handle = entry.book?.$bookBlob;
  if (!handle) continue;
  const book = loadPagedBook(join(args.data, 'books', `${handle}.json.gz`), handle, new PageCache());
  books.set(book.key, book);
}
const bySample = new Map(manifest.samples.map((sample) => [sample.sampleId, sample]));
let passed = 0;
let failed = 0;
const rows = [];
for (const sample of evidence.samples) {
  const internal = bySample.get(sample.sampleId);
  if (!internal) { rows.push({ sampleId: sample.sampleId, status: 'MISSING_MANIFEST_ROW' }); failed += 1; continue; }
  const book = books.get(internal.key);
  if (!book) { rows.push({ sampleId: sample.sampleId, status: 'MISSING_BOOK_REVISION' }); failed += 1; continue; }
  for (const quote of sample.evidence) {
    const segment = book.segments[quote.segmentId];
    if (!segment) { rows.push({ sampleId: sample.sampleId, segmentId: quote.segmentId, status: 'MISSING_SEGMENT' }); failed += 1; continue; }
    const actual = Array.from(segment.text).slice(quote.absoluteStart - segment.start, quote.absoluteEnd - segment.start).join('');
    const ok = sha(actual) === quote.quoteSha256 && sha(segment.text) === quote.segmentSha256;
    rows.push({ sampleId: sample.sampleId, segmentId: quote.segmentId, start: quote.absoluteStart, end: quote.absoluteEnd, length: quote.length, status: ok ? 'PASS' : 'FAIL' });
    if (ok) passed += 1; else failed += 1;
  }
}
const summary = { checkedAt: new Date().toISOString(), samples: evidence.samples.length, quotes: passed + failed, passed, failed, rows };
console.log(JSON.stringify(summary, null, 2));
if (failed) process.exitCode = 1;
