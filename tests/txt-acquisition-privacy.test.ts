import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AcquisitionRecords } from '../src/txt-acquisition/records.ts';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { TxtAcquisition } from '../src/txt-acquisition/acquisition.ts';
const dirs: string[] = [];afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch() { const dir = mkdtempSync(join(tmpdir(), 'bookfish-privacy-')); dirs.push(dir); return dir; }
describe('acquisition privacy and original retention', () => {
  it('sanitizes legacy URLs and failure strings on load, before any view can read them', () => {
    const dir = scratch(); const url = 'https://alice:password@files.example.com/private/signed-secret?token=signature'; const now = Date.now();
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ schema: 1, tasks: [{ id: randomUUID(), createdAt: now, updatedAt: now, status: 'failed_recoverable', origin: 'manual', target: { title: 'Novel' }, pageUrl: url, sourceHost: 'files.example.com', candidates: [], attempts: { downloads: 0, imports: 0, repairs: 0 }, history: [], failure: { code: 'network', message: `Failed ${url} Authorization: Bearer secret`, recoverable: true, at: now } }] }));
    const records = new AcquisitionRecords(dir); records.load(); const serialized = JSON.stringify(records.list()) + readFileSync(records.file, 'utf8');
    for (const secret of ['alice', 'password', 'signed-secret', 'signature', 'Bearer secret']) expect(serialized).not.toContain(secret);
    expect(records.list()[0]!.pageUrl).toBe('https://files.example.com'); expect(records.list()[0]!.requiresRediscovery).toBe(true);
    expect(records.list()[0]!.pageUrlHash).toBe(createHash('sha256').update(url).digest('hex'));
  });
  it('never exposes signed page URLs in task receipts and requires rediscovery after restart', async () => {
    const dir = scratch(); const library = new Library({ dataDir: dir }); library.open();
    try {
      const options = { dataDir: dir, library, cfg: () => ({ ...BOOKFISH_DEFAULTS, txtAcquisitionEnabled: true, browserDebugPort: 9333 }), resolve: async () => ['93.184.216.34'], pageLoader: async () => ({ html: '<a href="/book.txt?signature=download-secret">Novel</a>', close: async () => undefined }) };
      const acquisition = new TxtAcquisition(options); await acquisition.init(); const view = await acquisition.discover({ pageUrl: 'https://alice:password@files.example.com/path-secret?token=page-secret', title: 'Novel' });
      const text = JSON.stringify(view) + readFileSync(acquisition.records.file, 'utf8'); for (const secret of ['password', 'path-secret', 'page-secret', 'download-secret']) expect(text).not.toContain(secret);
      const restarted = new TxtAcquisition(options); await restarted.init(); await expect(restarted.retry(view.taskId)).rejects.toThrow(/discovered again/u);
    } finally { library.close(); }
  });
  it('verifies staged content before raw commit and preserves an existing original', async () => {
    const staging = new AcquisitionStaging(scratch()); await staging.init(); const hash = createHash('sha256').update('ORIGINAL').digest('hex');
    const a = staging.partialPath('a'); writeFileSync(a, 'ORIGINAL'); const raw = await staging.commitRaw(a, hash, 'txt');
    const b = staging.partialPath('b'); writeFileSync(b, 'TAMPERED'); await expect(staging.commitRaw(b, hash, 'txt')).rejects.toThrow(/checksum/u); expect(readFileSync(staging.resolveInside(raw), 'utf8')).toBe('ORIGINAL');
    const c = staging.partialPath('c'); writeFileSync(c, 'ORIGINAL'); expect(await staging.commitRaw(c, hash, 'txt')).toBe(raw); expect(existsSync(c)).toBe(false);
  });
  it('counts protected originals in quota pressure while deleting only unreferenced files', async () => {
    const staging = new AcquisitionStaging(scratch()); await staging.init(); const protectedHash = 'a'.repeat(64); const orphan = 'b'.repeat(64) + '.txt';
    writeFileSync(join(staging.rawDir, protectedHash + '.txt'), 'protected'.repeat(100)); writeFileSync(join(staging.rawDir, orphan), 'orphan');
    expect(await staging.enforceQuota(100, new Set([protectedHash]))).toEqual([orphan]); expect(existsSync(join(staging.rawDir, protectedHash + '.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(join(staging.root, 'quota.json'), 'utf8')).reason).toContain('Referenced');
  });
  it('expires incomplete parts without deleting active attempts or committed originals', async () => {
    const staging = new AcquisitionStaging(scratch()); await staging.init(); const now = Date.now();
    for (const name of ['orphan.part', 'active-123.part', 'fresh.part']) { const path = join(staging.workDir, name); writeFileSync(path, 'partial'); if (name !== 'fresh.part') utimesSync(path, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000)); }
    writeFileSync(join(staging.rawDir, 'original.txt'), 'original'); expect(await staging.clearExpiredParts(now, ['active'])).toEqual(['orphan.part']);
    expect(existsSync(join(staging.workDir, 'active-123.part'))).toBe(true); expect(existsSync(join(staging.rawDir, 'original.txt'))).toBe(true);
  });
});
