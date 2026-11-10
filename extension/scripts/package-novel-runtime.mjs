/**
 * Build the distributable Windows x64 novel runtime ZIP.
 *
 * Inputs are explicit: an already verified so-novel v1.12.0 runtime and its
 * Temurin JRE. The script refuses to package research downloads/logs, writes a
 * deterministic archive, and emits the trusted manifest, SHA256SUMS, license
 * material, SBOM and release notes.
 *
 * Usage:
 *   node scripts/package-novel-runtime.mjs [--source <SoNovel dir>] [--out <dir>] [--write-builtin]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const RESEARCH = resolve(PACKAGE_ROOT, '../../research/novel-fetch-20261109');

const CONSTANTS = {
  soNovelVersion: '1.12.0',
  runtimeVersion: 'bf1',
  sourceCommit: '88acec6ee489ca1c2489c624cedd1ef417d3f3ee',
  bridgeProtocol: 1,
  extensionApi: 6,
  createdAt: '2026-11-10T00:00:00.000Z',
  sourceUrl: 'https://github.com/freeok/so-novel',
  temurinSource: 'https://github.com/adoptium/jdk21u/tree/18dfe1e4938d',
};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceDir = resolve(argument('--source') ?? join(RESEARCH, 'sonovel-runtime', 'SoNovel'));
const outDir = resolve(argument('--out') ?? join(PACKAGE_ROOT, 'output', 'novel-runtime'));
const writeBuiltin = process.argv.includes('--write-builtin');
const zipName = `bookfish-novel-runtime-${CONSTANTS.soNovelVersion}-${CONSTANTS.runtimeVersion}-win32-x64.zip`;
const runtimeId = `bookfish-runtime-${CONSTANTS.soNovelVersion}-${CONSTANTS.runtimeVersion}-win32-x64`;
const metadataDir = join(outDir, 'staging-metadata');

for (const [label, path] of [['app.jar', join(sourceDir, 'app.jar')], ['runtime', join(sourceDir, 'runtime')], ['rules/main.json', join(sourceDir, 'rules', 'main.json')]]) {
  if (!existsSync(path)) { console.error(`Missing ${label}: ${path}`); process.exit(2); }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function prepareMetadata(rulesCount) {
  mkdirSync(join(metadataDir, 'licenses'), { recursive: true });
  copyFileSync(join(RESEARCH, 'so-novel', 'LICENSE'), join(metadataDir, 'licenses', 'so-novel-AGPL-3.0.txt'));
  copyFileSync(join(sourceDir, 'runtime', 'legal', 'java.base', 'LICENSE'), join(metadataDir, 'licenses', 'temurin-GPLv2+CE.txt'));
  copyFileSync(join(sourceDir, 'runtime', 'legal', 'java.base', 'ASSEMBLY_EXCEPTION'), join(metadataDir, 'licenses', 'temurin-ASSEMBLY_EXCEPTION.txt'));
  copyFileSync(join(sourceDir, 'runtime', 'NOTICE'), join(metadataDir, 'licenses', 'temurin-NOTICE.txt'));
  const release = readFileSync(join(sourceDir, 'runtime', 'release'), 'utf8');
  const javaVersion = release.match(/JAVA_VERSION="([^"]+)"/u)?.[1] ?? '21.0.8';
  const fullVersion = release.match(/FULL_VERSION="([^"]+)"/u)?.[1] ?? javaVersion;
  const implementor = release.match(/IMPLEMENTOR="([^"]+)"/u)?.[1] ?? 'Eclipse Adoptium';
  const notice = [
    'Bookfish Novel Runtime',
    '',
    `so-novel ${CONSTANTS.soNovelVersion} (commit ${CONSTANTS.sourceCommit}) is licensed under AGPL-3.0.`,
    'This runtime ZIP includes the unmodified upstream engine JAR and its rule snapshot.',
    `Source: ${CONSTANTS.sourceUrl}`,
    '',
    `Eclipse Temurin JRE ${fullVersion} is redistributed under GPLv2 with the Classpath Exception.`,
    `Runtime source: ${CONSTANTS.temurinSource}`,
    '',
    'The Bookfish bridge (SonovelBridge) is compiled against the upstream JAR and distributed',
    'with the extension package, not inside this runtime ZIP. Its license interaction with the',
    'AGPL-3.0 upstream is an open distribution question recorded in the project acceptance report.',
    '',
    'This ZIP contains no novel text, user configuration, cookies, logs or download caches.',
  ].join('\n');
  writeFileSync(join(metadataDir, 'NOTICE'), `${notice}\n`, 'utf8');
  writeFileSync(join(metadataDir, 'SOURCE.md'), [
    '# Runtime source and build material',
    '',
    `- so-novel: ${CONSTANTS.sourceUrl} tag v${CONSTANTS.soNovelVersion}, commit ${CONSTANTS.sourceCommit}`,
    `- Temurin JRE: ${CONSTANTS.temurinSource} (${fullVersion}, Windows x64)`,
    '- Bridge health protocol: 1; bridge rebuilt from src/novel-bridge/SonovelBridge.java against app.jar.',
    '- Repackage: node scripts/package-novel-runtime.mjs --source <SoNovel directory> --write-builtin',
    '',
    `The corresponding so-novel source archive is published beside this ZIP as so-novel-v${CONSTANTS.soNovelVersion}-source.tar.gz.`,
    `Sources for the Temurin build: ${CONSTANTS.temurinSource}`,
    '',
    `Rules: ${rulesCount} sources in rules/main.json.`,
  ].join('\n') + '\n', 'utf8');
  return { javaVersion, fullVersion, implementor };
}

/** Fixed file list: never a blind recursive copy of a research directory. */
function collectPayload() {
  const rows = [];
  const add = (absolute, archivePath, executable = false) => {
    if (!existsSync(absolute)) throw new Error(`Missing required payload file: ${absolute}`);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`);
    rows.push({ absolute, path: archivePath, size: stat.size, sha256: sha256(absolute), executable });
  };
  add(join(sourceDir, 'app.jar'), 'app.jar');
  const walk = (absolute, prefix) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(absolute, entry.name);
      const archive = `${prefix}/${entry.name}`;
      if (/[\\/](downloads|logs)([\\/]|$)/u.test(full)) continue;
      if (/\.(part|tmp|log)$/iu.test(entry.name)) continue;
      if (entry.isDirectory()) walk(full, archive);
      else if (entry.isFile()) add(full, archive, /[\\/]bin[\\/][^\\/]+\.exe$/u.test(full));
      else throw new Error(`Unsupported payload entry: ${full}`);
    }
  };
  walk(join(sourceDir, 'runtime'), 'runtime');
  add(join(sourceDir, 'rules', 'main.json'), 'rules/main.json');
  for (const name of ['NOTICE', 'SOURCE.md']) add(join(metadataDir, name), name);
  for (const name of readdirSync(join(metadataDir, 'licenses')).sort()) add(join(metadataDir, 'licenses', name), `licenses/${name}`);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function writeZip(payloadRows, manifest) {
  return new Promise((resolvePromise, reject) => {
    mkdirSync(outDir, { recursive: true });
    const zipPath = join(outDir, zipName);
    rmSync(zipPath, { force: true });
    const zip = new ZipFile();
    const output = createWriteStream(zipPath, { flags: 'wx' });
    output.on('error', reject);
    output.on('close', () => resolvePromise(zipPath));
    zip.outputStream.pipe(output);
    const mtime = new Date(CONSTANTS.createdAt);
    for (const row of payloadRows) zip.addFile(row.absolute, row.path, { mtime, mode: row.executable ? 0o755 : 0o644, compress: true });
    const manifestPath = join(metadataDir, 'runtime-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    zip.addFile(manifestPath, 'runtime-manifest.json', { mtime, mode: 0o644, compress: true });
    zip.end();
  });
}

async function main() {
  rmSync(metadataDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const rules = JSON.parse(readFileSync(join(sourceDir, 'rules', 'main.json'), 'utf8'));
  if (!Array.isArray(rules) || !rules.length) throw new Error('rules/main.json is not a non-empty array');
  const { javaVersion, fullVersion, implementor } = prepareMetadata(rules.length);
  const payloadRows = collectPayload();
  const manifest = {
    schema: 1,
    runtimeId,
    runtimeVersion: CONSTANTS.runtimeVersion,
    platform: 'win32',
    arch: 'x64',
    soNovelVersion: CONSTANTS.soNovelVersion,
    bridgeProtocol: CONSTANTS.bridgeProtocol,
    extensionApi: CONSTANTS.extensionApi,
    java: { vendor: implementor, version: fullVersion, major: Number(javaVersion.split('.')[0]) },
    rules: { path: 'rules/main.json', sha256: sha256(join(sourceDir, 'rules', 'main.json')), sources: rules.length },
    payloadBytes: payloadRows.reduce((sum, row) => sum + row.size, 0),
    payloadFiles: payloadRows.length,
    files: payloadRows.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    createdAt: CONSTANTS.createdAt,
    source: { url: CONSTANTS.sourceUrl, commit: CONSTANTS.sourceCommit, note: `so-novel v${CONSTANTS.soNovelVersion} + Temurin JRE, Windows x64` },
  };

  const zipPath = await writeZip(payloadRows, manifest);
  const archive = { path: zipName, size: statSync(zipPath).size, sha256: sha256(zipPath) };
  const trusted = { ...manifest, archive };
  writeFileSync(join(outDir, 'runtime-manifest.json'), `${JSON.stringify(trusted, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'SHA256SUMS'), `${archive.sha256}  ${zipName}\n`, 'utf8');
  writeFileSync(join(outDir, 'sbom.json'), `${JSON.stringify({ schema: 1, runtimeId, generatedAt: CONSTANTS.createdAt, files: payloadRows.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })) }, null, 2)}\n`, 'utf8');

  if (writeBuiltin) {
    const target = join(PACKAGE_ROOT, 'src', 'novel-runtime', 'builtin-manifest.ts');
    writeFileSync(target, `/** Generated by scripts/package-novel-runtime.mjs. Do not edit by hand. */\nimport type { TrustedRuntimeManifest } from './types.ts';\n\nexport const BUILTIN_RUNTIME_MANIFEST: TrustedRuntimeManifest = ${JSON.stringify(trusted, null, 2)};\n`, 'utf8');
    console.log(`Wrote ${relative(PACKAGE_ROOT, target)}`);
  }

  writeFileSync(join(outDir, 'RELEASE-NOTES.md'), [
    `# Bookfish novel runtime ${CONSTANTS.soNovelVersion}-${CONSTANTS.runtimeVersion}`,
    '',
    '- Platform: Windows x64 only',
    `- Engine: so-novel v${CONSTANTS.soNovelVersion} (upstream commit ${CONSTANTS.sourceCommit})`,
    `- Java: ${manifest.java.vendor} ${manifest.java.version}`,
    `- Rules: ${manifest.rules.sources} sources, sha256 ${manifest.rules.sha256}`,
    `- ZIP: ${archive.size} bytes, sha256 ${archive.sha256}`,
    `- Unpacked payload: ${manifest.payloadBytes} bytes in ${manifest.payloadFiles} files`,
    '',
    'Install through the Bookfish settings page (online or offline import). Do not unpack by hand.',
    'License: so-novel is AGPL-3.0; Temurin is GPLv2+CE. See NOTICE and licenses/.',
  ].join('\n') + '\n', 'utf8');

  console.log(JSON.stringify({ zipPath, archive, payloadBytes: manifest.payloadBytes, payloadFiles: manifest.payloadFiles }, null, 2));
}

await main();
