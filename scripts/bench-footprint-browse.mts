/**
 * Read-only footprint benchmark.
 *
 *   node --import tsx scripts/bench-footprint-browse.mts
 *   node --import tsx scripts/bench-footprint-browse.mts --episodes=5000 --books=12
 *
 * Two independent parts:
 *  1. synthetic: builds a disposable Library through the public API and times journalBrowse/journalBooks/probe/new;
 *  2. live: opens the user's real history.sqlite read-only and times the exact SQL the browser uses,
 *     including EXPLAIN QUERY PLAN with and without a candidate global-sequence index (on a temp copy).
 *
 * It never writes to the live library and never calls a model.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Library } from '../src/library.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function option(name: string, fallback: number): number {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  const value = found ? Number(found.split('=')[1]) : fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const SYNTHETIC_EPISODES = option('episodes', 2000);
const SYNTHETIC_BOOKS = option('books', 10);
const LIVE_DIR = 'E:\\zcdfy\\Coopanion\\data\\home\\companion\\data\\bookfish';
const ROUNDS = option('rounds', 25);

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}
async function measure(fn: () => unknown): Promise<{ median: number; p95: number; min: number; runs: number }> {
  const values: number[] = [];
  for (let index = 0; index < ROUNDS; index++) {
    const started = performance.now();
    await fn();
    values.push(performance.now() - started);
  }
  return { median: +percentile(values, 0.5).toFixed(3), p95: +percentile(values, 0.95).toFixed(3), min: +Math.min(...values).toFixed(3), runs: ROUNDS };
}

async function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), 'bf-bench-'));
  const text = '序章：海风轻轻吹过岸边，她把信放进抽屉。' + '远处传来潮声。'.repeat(2000);
  const quotes = ['海风轻轻吹过岸边', '她把信放进抽屉'];
  const lib = new Library({ dataDir: dir });
  lib.open();
  try {
    const startedSeed = performance.now();
    const perBook = Math.ceil(SYNTHETIC_EPISODES / SYNTHETIC_BOOKS);
    const bookKeys: string[] = [];
    for (let book = 0; book < SYNTHETIC_BOOKS; book++) {
      const title = `合成书${book + 1}`;
      const imported = lib.import({ filename: `${book}.txt`, title, base64: Buffer.from(text).toString('base64') }).book;
      lib.select(imported.key); bookKeys.push(imported.key);
      const task = lib.readNext(); if (task.complete) throw new Error('expected a segment');
      lib.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '读到海边。',
        episode: { trigger: '海风吹过', interpretation: `${title} 第一条`, evidence: [{ segmentId: task.segmentId, quote: quotes[0]! }] } });
      for (let index = 1; index < perBook; index++) {
        lib.reflect({ bookKey: imported.key, requestId: `b${book}-r${index}`,
          episode: { trigger: '抽屉里的信', interpretation: `${title} 第 ${index} 条`, evidence: [{ segmentId: 0, quote: quotes[index % 2]! }] } });
      }
    }
    const seedMs = +(performance.now() - startedSeed).toFixed(0);
    const total = SYNTHETIC_EPISODES;
    const firstDescPage = lib.journalBrowse({ limit: 10 });
    const midSequence = Math.floor(total / 2);
    const midAnchor = lib.journalBrowse({ anchorSequence: midSequence, limit: 10 });
    const results: Record<string, unknown> = {
      synthetic: {
        books: SYNTHETIC_BOOKS, episodes: total, seedMs,
        dbBytes: statSync(join(dir, 'bookfish', 'history.sqlite')).size,
      },
      timings: {} as Record<string, unknown>,
    };
    const timings = results.timings as Record<string, unknown>;
    timings['journalBooks (all books)'] = await measure(() => lib.journalBooks());
    timings['journalBrowse first page desc/10'] = await measure(() => lib.journalBrowse({ limit: 10 }));
    timings['journalBrowse first page asc/10'] = await measure(() => lib.journalBrowse({ order: 'asc', limit: 10 }));
    timings['journalBrowse scoped page'] = await measure(() => lib.journalBrowse({ scope: { bookKey: bookKeys[0]! }, limit: 10 }));
    timings['journalBrowse anchor (middle)'] = await measure(() => lib.journalBrowse({ anchorSequence: midSequence, limit: 10 }));
    timings['journalBrowse page 50'] = await measure(() => lib.journalBrowse({ limit: 50 }));
    {
      let cursor: { edge: 'before' | 'after'; sequence: number } | undefined = firstDescPage.nextCursor ?? undefined;
      const walk: number[] = [];
      const started = performance.now();
      for (let page = 0; page < 10 && cursor; page++) {
        const next = lib.journalBrowse({ limit: 10, cursor });
        walk.push(next.items.length);
        cursor = next.nextCursor ?? undefined;
      }
      timings['10 sequential pages (total ms)'] = { median: +(performance.now() - started).toFixed(3), pages: walk.length };
    }
    timings['journalProbe (since 0)'] = await measure(() => lib.journalProbe({ since: 0 }));
    timings['journalProbe (since middle)'] = await measure(() => lib.journalProbe({ since: midSequence }));
    timings['journalNew (since 0)'] = await measure(() => lib.journalNew({ since: 0, limit: 50 }));
    timings['journalBrowse query (one word, hits)'] = await measure(() => lib.journalBrowse({ limit: 10, query: '第 500 次' }));
    timings['journalBrowse query (one word, no hit)'] = await measure(() => lib.journalBrowse({ limit: 10, query: '不存在的关键词' }));
    timings['journalBrowse prev page'] = await measure(() => {
      const page = lib.journalBrowse({ anchorSequence: midSequence, limit: 10 });
      return lib.journalBrowse({ limit: 10, cursor: page.prevCursor! });
    });
    return { ...results, midAnchorStart: midAnchor.position.start, firstPageTotal: firstDescPage.total };
  } finally { lib.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function liveSql() {
  const file = join(LIVE_DIR, 'history.sqlite');
  if (!existsSync(file)) return { skipped: `missing ${file}` };
  const library = JSON.parse(readFileSync(join(LIVE_DIR, 'library.json'), 'utf8')) as { $history?: { version: number; episodes: number; tasks: number } };
  const version = library.$history?.version ?? 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const visibility = 'kind=? AND v<=? AND (until_v IS NULL OR until_v>?)';
    const queries: Record<string, { sql: string; args: (number | string)[] }> = {
      'COUNT all episodes': { sql: `SELECT COUNT(*) AS n FROM history WHERE ${visibility}`, args: ['episodes', version, version] },
      'page 10 desc': { sql: `SELECT n FROM history WHERE ${visibility} ORDER BY sequence DESC LIMIT 11`, args: ['episodes', version, version] },
      'COUNT older than x': { sql: `SELECT COUNT(*) AS n FROM history WHERE ${visibility} AND sequence<?`, args: ['episodes', version, version, 400] },
      'COUNT newer than x': { sql: `SELECT COUNT(*) AS n FROM history WHERE ${visibility} AND sequence>?`, args: ['episodes', version, version, 400] },
      'GROUP BY bookKey': { sql: `SELECT bookKey, COUNT(*) AS n, MAX(sequence) AS head, MIN(sequence) AS tail FROM history WHERE ${visibility} GROUP BY bookKey ORDER BY head DESC`, args: ['episodes', version, version] },
      'scoped page 10 desc': { sql: `SELECT n FROM history WHERE ${visibility} AND bookKey=? ORDER BY sequence DESC LIMIT 11`, args: ['episodes', version, version, ''] },
    };
    const scopeRow = db.prepare(`SELECT bookKey FROM history WHERE ${visibility} LIMIT 1`).get('episodes', version, version) as { bookKey?: string } | undefined;
    queries['scoped page 10 desc']!.args[3] = scopeRow?.bookKey ?? '';
    const plans: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(queries)) {
      try {
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...(entry.args as never[])) as Array<{ detail?: string }>;
        plans[name] = rows.map((row) => String(row.detail ?? ''));
      } catch (error) { plans[name] = [`plan failed: ${String(error)}`]; }
    }
    const timings: Record<string, unknown> = {};
    for (const name of ['page 10 desc', 'COUNT all episodes', 'GROUP BY bookKey', 'scoped page 10 desc']) {
      const entry = queries[name]!;
      const statement = db.prepare(entry.sql);
      timings[name] = await measure(() => statement.all(...(entry.args as never[])));
    }
    // Candidate index experiment on a disposable copy: does an explicit sequence index change the plan?
    const copyDir = mkdtempSync(join(tmpdir(), 'bf-bench-live-'));
    const copy = join(copyDir, 'history.sqlite');
    let indexExperiment: Record<string, unknown>;
    try {
      copyFileSync(file, copy);
      const writable = new DatabaseSync(copy);
      writable.exec('CREATE INDEX IF NOT EXISTS bench_sequence ON history(kind,sequence,n,v,until_v)');
      const plan = writable.prepare(`EXPLAIN QUERY PLAN SELECT n FROM history WHERE ${visibility} ORDER BY sequence DESC LIMIT 11`).all('episodes', version, version) as Array<{ detail?: string }>;
      const statement = writable.prepare(`SELECT n FROM history WHERE ${visibility} ORDER BY sequence DESC LIMIT 11`);
      indexExperiment = {
        plan: plan.map((row) => String(row.detail ?? '')),
        timing: await measure(() => statement.all('episodes', version, version)),
      };
      writable.close();
    } finally { rmSync(copyDir, { recursive: true, force: true }); }
    return {
      file, bytes: statSync(file).size, version,
      historyRef: library.$history ?? null,
      timings, plans, indexExperiment,
    };
  } finally { db.close(); }
}

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  synthetic: await synthetic(),
  live: await liveSql(),
};
const output = process.argv.find((item) => item.startsWith('--out='))?.slice(6);
if (output) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`wrote ${output}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
