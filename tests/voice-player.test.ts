import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackError } from '../src/voice/errors.ts';
import { playWav, psSingleQuote, sweepTempDir } from '../src/voice/player.ts';
import { makeWav } from './helpers/voice-fixtures.ts';

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-player-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function spawnWith(child: FakeChild, seen?: { args?: string[] }) {
  return ((_exe: string, args: readonly string[]) => {
    if (seen) seen.args = [...args];
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('Windows WAV player', () => {
  it('waits for the child, escapes the path and removes the temp file', async () => {
    const child = new FakeChild();
    const seen: { args?: string[] } = {};
    const pending = playWav(makeWav(), { tempDir: dir, spawnImpl: spawnWith(child, seen), psExe: 'powershell.exe' });
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(1);
    const command = seen.args?.join(' ') ?? '';
    expect(command).toContain('System.Media.SoundPlayer');
    expect(command).toContain("'");
    expect(command).not.toContain('<');
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ aborted: false });
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  });

  it('reports a non-zero exit without leaving the WAV behind', async () => {
    const child = new FakeChild();
    const pending = playWav(makeWav(), { tempDir: dir, spawnImpl: spawnWith(child), psExe: 'powershell.exe' });
    child.stderr.emit('data', Buffer.from('audio device missing'));
    child.emit('close', 1);
    await expect(pending).rejects.toBeInstanceOf(AudioPlaybackError);
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  });

  it('kills the process on abort and resolves as aborted', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const pending = playWav(makeWav(), { tempDir: dir, spawnImpl: spawnWith(child), psExe: 'powershell.exe', signal: controller.signal });
    controller.abort();
    expect(child.kill).toHaveBeenCalled();
    child.emit('close', null);
    await expect(pending).resolves.toEqual({ aborted: true });
    expect(readdirSync(dir).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  });

  it('rejects invalid audio before spawning and sweeps stale files', async () => {
    const child = new FakeChild();
    await expect(playWav(new Uint8Array([1, 2, 3]), { tempDir: dir, spawnImpl: spawnWith(child), psExe: 'powershell.exe' }))
      .rejects.toBeInstanceOf(AudioPlaybackError);
    expect(child.kill).not.toHaveBeenCalled();
    writeFileSync(join(dir, 'stale.wav'), makeWav());
    writeFileSync(join(dir, 'keep.txt'), 'x');
    sweepTempDir(dir);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('escapes single quotes for PowerShell', () => {
    expect(psSingleQuote("C:\\a'b.wav")).toBe("'C:\\a''b.wav'");
  });
});