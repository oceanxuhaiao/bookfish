import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playWav, powershellPath } from '../src/voice/player.ts';
import { makeWav } from './helpers/voice-fixtures.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-win-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(process.platform === 'win32')('real Windows WAV playback', () => {
  it('plays a short WAV through the system player and cleans the temp file', async () => {
    const result = await playWav(makeWav(200), { tempDir: dir });
    expect(result.aborted).toBe(false);
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  }, 20000);

  it('stops a longer WAV on abort and leaves no temp file', async () => {
    const controller = new AbortController();
    const pending = playWav(makeWav(4000), { tempDir: dir, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  }, 20000);

  it('resolves the absolute system PowerShell path', () => {
    expect(powershellPath()).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  });
});