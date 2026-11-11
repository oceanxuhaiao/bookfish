import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../../src/novel-engine.ts';
import { SourcePageProbe } from '../../src/novel-probe.ts';
import { NOVEL_SOURCES } from '../../src/novel-sources.ts';

const root = 'E:/项目/桌面宠物/扩展/cortina/state/packages/cortico-world-bookfish/output/novel-adapter/source-research/run';
const cases = [
  ['source1-aq', 1, 'http://www.ibiqugu.net/150/150114/', '阿Q正传'],
  ['source6-aq', 6, 'http://www.ujxsw.org/book/115812/', '阿Q正传'],
  ['source9-aq', 9, 'https://www.d8zw.com/45/45256/', '阿Q正传'],
  ['source12-aq', 12, 'https://www.xbiquge.info/45/45256/', '阿Q正传'],
  ['source8-three-kingdoms', 8, 'https://www.biquge365.net/book/08451/', '三国演义'],
] as const;

const engine = new NovelEngine({
  engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine',
  workDir: join(root, 'probe-engine'),
});
const probe = new SourcePageProbe();
const results: Array<Record<string, unknown>> = [];
for (const [name, sourceId, url, title] of cases) {
  const source = NOVEL_SOURCES.find((item) => item.id === sourceId)!;
  const catalog = await engine.toc(url);
  const taskRoot = join(root, `${name}-work`, 'engine', 'tasks');
  const taskDir = readdirSync(taskRoot).map((item) => join(taskRoot, item)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
  const files = readdirSync(join(taskDir, 'downloads'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /(?:^|[\\/])\d+_.*\.txt$/u.test(file))
    .map((file) => {
      const base = file.split(/[\\/]/u).pop()!; const match = base.match(/^(\d+)_(.*)\.txt$/u)!;
      return { order: Number(match[1]), title: match[2]!, text: readFileSync(join(taskDir, 'downloads', file), 'utf8') };
    });
  const sampleCatalog = catalog.slice(0, 2);
  const sampleFiles = files.filter((file) => sampleCatalog.some((chapter) => chapter.order === file.order));
  const started = Date.now();
  try {
    const issues = await probe.probe(source, sampleCatalog, sampleFiles, AbortSignal.timeout(90_000));
    results.push({ case: name, source: source.name, title, sampled: sampleCatalog.length, issues: issues.map((issue) => issue.code), seconds: (Date.now() - started) / 1000 });
    console.log(JSON.stringify(results.at(-1)));
  } catch (error) {
    results.push({ case: name, source: source.name, title, sampled: sampleCatalog.length, error: (error as Error).message, seconds: (Date.now() - started) / 1000 });
    console.log(JSON.stringify(results.at(-1)));
  }
}
writeFileSync(join(root, '..', 'source-probe-sample.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
