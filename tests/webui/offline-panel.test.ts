import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import type { BookfishConfigSection } from '../../src/config.ts';

it('keeps polling transfer_status harmless after the World is unmounted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-offline-'));
  try {
    const context = fakeWorldContext<BookfishConfigSection>(BOOKFISH, { scratchDir: dir });
    const world = BOOKFISH.create(context);
    const webUi = world.webUi!('zh');
    // The panel keeps polling for a few seconds after the host disabled the World.
    await expect(webUi.invoke!('status', 'transfer_status', [])).resolves.toBeNull();
    await expect(webUi.invoke!('shelf', 'transfer_status', ['stale-id'])).resolves.toBeNull();
    // Mutations still fail while unmounted.
    await expect(webUi.invoke!('status', 'upload_begin', [{}])).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
