import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/library.ts';
import { validateSettings } from '../src/config.ts';
import { assertWritableTextStoreDir } from '../src/text-store.ts';
import { BOOKFISH } from '../src/definition.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dataDir: string, first: string, second: string;
const blobs = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json\.gz$/.test(name)) : [];
const long = Buffer.from('海风。'.repeat(3000)).toString('base64');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bookfish-text-store-'));
  first = mkdtempSync(join(tmpdir(), 'bookfish-text-target-'));
  second = mkdtempSync(join(tmpdir(), 'bookfish-text-target2-'));
});
afterEach(() => {
  for (const dir of [dataDir, first, second]) rmSync(dir, { recursive: true, force: true });
});

describe('configurable full-text storage folder', () => {
  it('migrates existing bodies while metadata and progress stay in the data folder', () => {
    const original = new Library({ dataDir });
    original.open();
    const imported = original.import({ filename: 'long.txt', title: '长书', base64: long });
    const key = imported.book.key;
    original.select(key);
    original.close();

    const defaultDir = join(dataDir, 'bookfish', 'books');
    expect(blobs(defaultDir)).toHaveLength(1);

    const moved = new Library({ dataDir, textStoreDir: first });
    moved.open();
    expect(moved.status().textStore.dir).toBe(resolve(first));
    expect(blobs(first)).toHaveLength(1);
    expect(moved.status().current?.key).toBe(key);
    const task = moved.readNext();
    expect(task.complete).toBe(false);
    moved.finish({ ...task, understanding: '仍能继续阅读。' });
    expect(moved.status().current?.confirmedSegments).toBe(1);
    moved.close();

    const movedAgain = new Library({ dataDir, textStoreDir: second });
    movedAgain.open();
    expect(movedAgain.status().textStore.dir).toBe(resolve(second));
    expect(blobs(second)).toHaveLength(1);
    expect(movedAgain.status().current?.key).toBe(key);
    movedAgain.close();

    const back = new Library({ dataDir });
    back.open();
    expect(back.status().textStore.dir).toBe(resolve(defaultDir));
    expect(blobs(defaultDir)).toHaveLength(1);
    expect(back.status().current?.key).toBe(key);
    back.close();
  });

  it('falls back to the default folder and stays mountable when the configured path is not a directory', () => {
    const original = new Library({ dataDir });
    original.open();
    const imported = original.import({ filename: 'long.txt', title: '长书', base64: long });
    original.select(imported.book.key);
    original.close();

    const bad = join(dataDir, 'not-a-folder');
    writeFileSync(bad, 'x');
    const lib = new Library({ dataDir, textStoreDir: bad });
    lib.open();
    try {
      expect(lib.status().textStore.error).toBeTruthy();
      expect(lib.status().textStore.dir).toBe(resolve(join(dataDir, 'bookfish', 'books')));
      expect(lib.status().current).not.toBeNull();
    } finally { lib.close(); }
  });

  it('rejects relative paths and probes that an absolute target is writable', () => {
    expect(() => validateSettings({ textStoreDir: 'relative/folder' })).toThrow(/absolute/);
    expect(() => assertWritableTextStoreDir('relative/folder')).toThrow(/absolute/);
    expect(validateSettings({ textStoreDir: '  ' }).textStoreDir).toBe('');
    expect(assertWritableTextStoreDir(resolve(first))).toBe(resolve(first));
    expect(existsSync(first)).toBe(true);
  });

  it('saves an absolute folder through the World settings panel', async () => {
    const ctx = fakeWorldContext(BOOKFISH, { scratchDir: dataDir });
    const world = BOOKFISH.create(ctx);
    await world.start(new FakeHost());
    try {
      const panel = world.webUi!('zh');
      const saved = await panel.invoke!('settings', 'save', [{ textStoreDir: first }]) as { config: { textStoreDir?: string } };
      expect(saved.config.textStoreDir).toBe(resolve(first));
      await expect(panel.invoke!('settings', 'save', [{ textStoreDir: 'relative/folder' }])).rejects.toThrow(/absolute/);
    } finally { await world.stop(); }
  });
});
