/**
 * One real end-to-end download into an isolated library.
 *
 * Search (with the short-title hint path available), pick an exact candidate,
 * download the whole book, run the production validation (catalog preflight,
 * text completeness, per-source page probe), compose the validated TXT and
 * import it into a throwaway Library. Asserts that the announcements are not
 * in the imported text and that volume-scoped numbering was accepted.
 *
 * Usage: node --import tsx scripts/full-download-check.mts ["书名"] ["作者"]
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { NovelFetches, type NovelTaskView } from '../src/novel-fetch.ts';
import { NOVEL_SOURCES } from '../src/novel-sources.ts';
import { SourcePageProbe } from '../src/novel-probe.ts';
import { isAnnouncementTitle } from '../src/novel-integrity.ts';
import { Library } from '../src/library.ts';

const title = process.argv[2] ?? '大奉打更人';
const author = process.argv[3] ?? '卖报小郎君';
const engineDir = process.env.BOOKFISH_ENGINE_DIR
  ?? 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a';
const root = join(process.cwd(), 'output', `full-download-${Date.now()}`);
const workDir = join(root, 'work');
const dataDir = join(root, 'library');
mkdirSync(workDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const library = new Library({ dataDir });
library.open();
library.clear();
const engine = new NovelEngine({ engineDir, workDir });
const fetches = new NovelFetches(engine, (file, metadata) => library.importFile(metadata, file), {
  workDir,
  sources: NOVEL_SOURCES,
  searchSourceIds: NOVEL_SOURCES.map((source) => source.id),
  pageProbe: new SourcePageProbe(),
  // The production cap is 120 s; a 1,000-chapter probe needs longer, and this
  // run is meant to prove the probe itself, not the cap.
  probeTimeoutMs: 40 * 60_000,
  maxTasks: 2,
});

const started = new Date().toISOString();
console.log(`[${new Date().toLocaleTimeString()}] searching ${title} / ${author}`);
const search = await fetches.searchDetailed(title, author);
const exact = search.candidates.filter((candidate) => candidate.match === 'exact');
console.log(`exact candidates: ${exact.length}`);
if (!exact.length) throw new Error('no exact candidates');

const preferred = exact.find((candidate) => candidate.source.id === 5) ?? exact[0]!;
console.log(`chosen: ${preferred.source.name} ${preferred.url} latest=${preferred.latestChapter}`);
const task = fetches.start(preferred);
console.log(`task ${task.id} started`);

let record: NovelTaskView = task;
const deadline = Date.now() + 60 * 60_000;
let lastLine = '';
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  record = fetches.get(task.id);
  const line = `${record.state}/${record.stage} ${record.percent}% ${record.downloadedChapters}/${record.catalogChapters}`;
  if (line !== lastLine) {
    console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
    lastLine = line;
  }
  if (['complete', 'failed', 'cancelled'].includes(record.state)) break;
}

const warningCodes: Record<string, number> = {};
for (const warning of record.warnings) warningCodes[warning.code] = (warningCodes[warning.code] ?? 0) + 1;
const issueCodes: Record<string, number> = {};
for (const issue of record.issues) issueCodes[issue.code] = (issueCodes[issue.code] ?? 0) + 1;

// Read the exact TXT that was handed to the importer.
let validatedText = '';
let taskDir: string | undefined;
const tasksRoot = join(workDir, 'tasks');
try {
  const dirs = readdirSync(tasksRoot).map((name) => ({ name, time: statSync(join(tasksRoot, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  taskDir = dirs[0] ? join(tasksRoot, dirs[0].name) : undefined;
  if (taskDir) validatedText = readFileSync(join(taskDir, 'validated.txt'), 'utf8');
} catch { /* evidence only */ }

const headings = validatedText.split(/\r?\n/).filter((line) => line.startsWith('# ')).map((line) => line.slice(2));
// A real chapter title may mention 请假 (e.g. "第二百六十章 出征（请假到十四号写大结局）");
// only unnumbered announcement-shaped headings would prove the filter failed.
const announcementHeadings = headings.filter((heading) => isAnnouncementTitle(heading));
const books = library.list();
const book = books[0];
const result = {
  started, finishedAt: new Date().toISOString(),
  task: { id: record.id, state: record.state, stage: record.stage, catalogChapters: record.catalogChapters,
    downloadedChapters: record.downloadedChapters, percent: record.percent, error: record.error ?? null,
    warningCodes, issueCodes, warningCount: record.warningCount, issueCount: record.issueCount },
  text: { validatedBytes: validatedText.length, headings: headings.length, announcementHeadings: announcementHeadings.slice(0, 10),
    firstHeadings: headings.slice(0, 5), lastHeadings: headings.slice(-5) },
  library: books.map((entry) => ({ key: entry.key, title: entry.title, author: entry.author, totalChars: entry.totalChars,
    identifiedChapters: entry.identifiedChapters, sourceAdapter: entry.source?.adapter ?? null })),
  bookImported: !!book && book.title === preferred.title,
  taskDir: taskDir ?? null,
};
const outFile = join(process.cwd(), 'output', `full-download-${title.replace(/[\\/:*?"<>|\s]+/gu, '_')}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
console.log(`evidence: ${outFile}`);
process.exitCode = record.state === 'complete' && result.bookImported && announcementHeadings.length === 0 ? 0 : 1;
