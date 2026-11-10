import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against an installed framework with a fake host and isolated package-owned data only.
const framework = resolve(process.argv[2]);
const root = process.cwd();
const scratchDir = join(root, 'output', 'host-fixture');
await mkdir(scratchDir, { recursive: true });
await import(pathToFileURL(join(framework, 'src/extensions/runtime.ts')).href);
const { dryMountWorld, fakeWorldContext } = await import(pathToFileURL(join(framework, 'src/extensions/dry-mount.ts')).href);
const { default: definition } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
const { FakeHost } = await import(pathToFileURL(join(root, 'tests/helpers/fake-host.ts')).href);
const { EXTENSION_API_VERSIONS } = await import(pathToFileURL(join(framework, 'src/extensions/manifest.ts')).href);
const dryMount = await dryMountWorld(definition, { scratchDir, packageDir: root });
const context = fakeWorldContext(definition, { scratchDir, packageDir: root }); context.persist({ automaticReading: false,realRoutineEnabled:false });
const world = definition.create(context);
const host = new FakeHost();
let result;
try {
  await world.start(host);
  await world.webUi('zh').storage[0].clear();
  const invoke = (method, args = []) => world.webUi('zh').invoke('status', method, args);
  const tool = async (name, args = {}) => JSON.parse(await world.tools().find(t => t.name === name).handler(args, {}));
  const imported = await invoke('import', [{ filename: 'sample.md', title: '隔离校验短篇', author: '测试', base64: Buffer.from('# 海边\n小鱼回家了。').toString('base64') }]);
  await invoke('select', [imported.book.key]);
  const offered = await tool('bookfish_read_next');
  const before = await tool('bookfish_get_status');
  const confirm = { taskId: offered.taskId, bookKey: offered.bookKey, segmentId: offered.segmentId, understanding: '小鱼从海边回家。', episode: { trigger: '小鱼回家', interpretation: '合成协议测试的感想', reason: '仅用于验证，不是真实模型感受', mood: { label: '合成测试心情' }, evidence: [{ segmentId: offered.segmentId, quote: '小鱼回家了。' }] } };
  await tool('bookfish_finish_reading', confirm);
  const retry = await tool('bookfish_finish_reading', confirm);
  const journal = await tool('bookfish_list_journal');
  const detail = await tool('bookfish_get_episode', { episodeId: retry.receipt.episodeId });
  await tool('bookfish_record_reflection', { bookKey: offered.bookKey, requestId: 'host-revision', revises: retry.receipt.episodeId, episode: { trigger: '重读小鱼回家', interpretation: '这是后续合成反思，保留原记录', evidence: [{ segmentId: offered.segmentId, quote: '小鱼回家了。' }] } });
  const backup = await invoke('export');
  await world.stop();
  await world.start(host);
  const after = await invoke('get');
  const backupBeforeRetrieval = await invoke('export');
  const discovery = await tool('bookfish_search_reading', { query: '小鱼', kind: 'episode' });
  const context = await tool('bookfish_get_reading_context', { episodeIds: [retry.receipt.episodeId] });
  const backupAfterRetrieval = await invoke('export');
  const reviewJob = await tool('bookfish_begin_review', { bookKey: offered.bookKey, requestId: 'host-review' });
  await tool('bookfish_review_materials', { jobId: reviewJob.job.id, kind: 'ranges' });
  await tool('bookfish_review_materials', { jobId: reviewJob.job.id, kind: 'episodes' });
  const savedReview = await tool('bookfish_finish_review', { jobId: reviewJob.job.id, title: '合成宿主文章', text: '这是一段明确标注为合成的协议验收文章，不是真实模型阅读或主观感受。小鱼从海边回家，这句话是唯一正文依据，阅读手账和后续修订分别保留。我不能凭这句短文推断更多情节，也不能编造早先没有保存的理由。此段只检验文章、证据和版本能否通过宿主工具保存并恢复。', episodeIds: [retry.receipt.episodeId], evidence: [{ segmentId: 0, quote: '小鱼回家了。' }] });
  const articleBackup = await invoke('export');
  const { Library } = await import(pathToFileURL(join(root, 'src/library.ts')).href);
  const restore = new Library({ dataDir: join(scratchDir, 'article-restore') });
  let articleRestored;
  try { restore.open(); restore.clear(); restore.restore(articleBackup); articleRestored = restore.review(savedReview.review.id).review; } finally { restore.close(); }
  const bundle = (await import(pathToFileURL(join(root, 'lib/webui.js')).href)).default;
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  result = {
    checkedAt: new Date().toISOString(), framework, package: `${manifest.name}@${manifest.version}`,
    worldContract: EXTENSION_API_VERSIONS.world, failures: dryMount.failures,
    checks: { fetchingDoesNotAdvance: before.library.current.confirmedChars === 0,
      confirmationReachedEnd: after.status.library.current.complete, retryIsDuplicate: retry.duplicate,
      backupExists: JSON.parse(backup).format === 'bookfish-backup-v1',
      journalSavedWithProgress: journal.total === 1 && journal.rangesWithoutReadingEpisode === 0,
      exactEvidenceAnchored: detail.evidence[0].exactTextMatched && detail.evidence[0].quote === '小鱼回家了。',
      journalAndRevisionSurviveRemount: after.journal.total === 2 && after.journal.items[0].kind === 'revision',
      moodNotSynthesizedByRevision: after.journal.mood.episodeId === retry.receipt.episodeId,
      searchSurvivesRemount: discovery.total === 2,
      contextIncludesOriginalAndRevision: context.accounts.length === 2 && context.sources.length === 1,
      retrievalDoesNotWrite: backupBeforeRetrieval === backupAfterRetrieval,
      fullBookArticleSaved: savedReview.review.version === 1,
      articleBackupRestored: JSON.stringify(savedReview.review) === JSON.stringify(articleRestored),
      browserPanelExport: typeof bundle.panels?.status?.mount === 'function' },
    statusWithFakeHost: after.status,
    limits: 'Installed framework plus fake host, isolated import/tool/backup/remount flow only. No running user deployment, model or desktop message was exercised.',
  };
} finally { await world.stop(); }
await writeFile(join(root, 'output/installed-host-check.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.failures.length || Object.values(result.checks).some(v => v !== true)) process.exitCode = 1;
