import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBridge, BridgeError } from '../src/txt-acquisition/bridge.ts';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
import { DownloadError } from '../src/txt-acquisition/download.ts';

const resolvePublic = async (): Promise<string[]> => ['93.184.216.34'];
const BOOK = 'http://books.example.com/novel.txt';
const PAGE = 'http://books.example.com/list';

function scratch(): { dir: string; discard: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-bridge-'));
  return { dir, discard: () => rmSync(dir, { recursive: true, force: true }) };
}

async function start(dir: string): Promise<{ bridge: BrowserBridge; port: number; token: string }> {
  const bridge = new BrowserBridge({ dataDir: dir, port: 0, resolve: resolvePublic });
  const { port, token } = await bridge.start();
  return { bridge, port, token };
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-bookfish-token': token, ...extra };
}

/** Attach the handler right away; the bridge may settle while the POST is in flight. */
function capture<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

async function poll(port: number, token: string): Promise<{ job: { id: string; kind: string; url: string } | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/bridge/jobs`, { headers: headers(token) });
  return await response.json() as { job: { id: string; kind: string; url: string } | null };
}

describe('browser extension bridge', () => {
  it('binds loopback only and persists one pairing token', async () => {
    const { dir, discard } = scratch();
    try {
      const first = await start(dir);
      expect(first.port).toBeGreaterThan(1024);
      expect(first.token.length).toBeGreaterThanOrEqual(24);
      expect(existsSync(join(dir, 'bridge.json'))).toBe(true);
      const stored = JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')) as { token: string };
      expect(stored.token).toBe(first.token);
      await first.bridge.stop();

      // A restart keeps the pairing, so the user does not have to paste the token again.
      const second = await start(dir);
      expect(second.token).toBe(first.token);
      await second.bridge.stop();
    } finally {
      discard();
    }
  });

  it('refuses requests without the token or from a web page', async () => {
    const { dir, discard } = scratch();
    try {
      const { bridge, port, token } = await start(dir);
      const unauthorized = await fetch(`http://127.0.0.1:${port}/bridge/hello`);
      expect(unauthorized.status).toBe(401);
      const wrong = await fetch(`http://127.0.0.1:${port}/bridge/hello`, { headers: headers('nope') });
      expect(wrong.status).toBe(401);

      // A normal web page must not be able to poll the bridge.
      const webPage = await fetch(`http://127.0.0.1:${port}/bridge/hello`, {
        headers: headers(token, { origin: 'https://evil.example' }),
      });
      expect(webPage.status).toBe(403);

      const extension = await fetch(`http://127.0.0.1:${port}/bridge/hello`, {
        headers: headers(token, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }),
      });
      expect(extension.status).toBe(200);
      expect(bridge.connected).toBe(true);
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('hands a page job to the extension and takes the html back', async () => {
    const { dir, discard } = scratch();
    try {
      const { bridge, port, token } = await start(dir);
      const pending = bridge.fetchPage(PAGE, { allowNetwork: true, timeoutMs: 5_000 });
      const { job } = await poll(port, token);
      expect(job?.kind).toBe('page');
      expect(job?.url).toBe(PAGE);

      const html = '<a href="/novel.txt">下载 TXT</a>';
      const posted = await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/page`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ html, finalUrl: PAGE }),
      });
      expect(posted.status).toBe(200);
      await expect(pending).resolves.toEqual({ html, finalUrl: PAGE });
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('rejects a page that landed on a private address', async () => {
    const { dir, discard } = scratch();
    try {
      const { bridge, port, token } = await start(dir);
      const pending = capture(bridge.fetchPage(PAGE, { allowNetwork: true, timeoutMs: 5_000 }));
      const { job } = await poll(port, token);
      const posted = await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/page`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ html: '<p>x</p>', finalUrl: 'http://192.168.1.10/novel.txt' }),
      });
      // The extension is told the job failed, and the world never reads that DOM.
      expect(posted.status).toBe(400);
      const outcome = await pending;
      expect(outcome.error).toMatchObject({ code: 'policy_blocked' });
      expect(String(outcome.error)).toMatch(/192\.168\.1\.10/u);
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('streams raw bytes untouched and hashes what arrived', async () => {
    const { dir, discard } = scratch();
    const staging = new AcquisitionStaging(dir);
    try {
      await staging.init();
      const { bridge, port, token } = await start(dir);
      // GBK bytes: the bridge must not decode them.
      const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xa3]);
      const pending = bridge.fetchFile({ url: BOOK, taskId: 'task-1', staging, filename: 'novel.txt', allowNetwork: true, timeoutMs: 5_000 });
      const { job } = await poll(port, token);
      expect(job?.kind).toBe('file');

      const chunk = await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/chunk`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/octet-stream' }),
        body: gbk,
      });
      expect(chunk.status).toBe(200);
      const done = await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/done`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ finalUrl: BOOK, contentType: 'text/plain' }),
      });
      expect(done.status).toBe(200);

      const result = await pending;
      expect(result.bytes).toBe(gbk.length);
      expect(result.sha256).toBe('613d3ddb7f6a508093ee31e7134bce0e92a5351ad62a10febe18779c6ac334f3');
      expect(result.contentType).toBe('text/plain');
      expect(readFileSync(result.partPath).equals(gbk)).toBe(true);
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('does not accept an html page as a download', async () => {
    const { dir, discard } = scratch();
    const staging = new AcquisitionStaging(dir);
    try {
      await staging.init();
      const { bridge, port, token } = await start(dir);
      const pending = capture(bridge.fetchFile({ url: BOOK, taskId: 'task-2', staging, filename: 'novel.txt', allowNetwork: true, timeoutMs: 5_000 }));
      const { job } = await poll(port, token);
      await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/chunk`, {
        method: 'POST', headers: headers(token, { 'content-type': 'application/octet-stream' }), body: Buffer.from('x'),
      });
      await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/done`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ finalUrl: BOOK, contentType: 'text/html; charset=utf-8' }),
      });
      const outcome = await pending;
      expect(String(outcome.error)).toMatch(/HTML page/u);
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('maps extension failures and refuses a job after stop', async () => {
    const { dir, discard } = scratch();
    const staging = new AcquisitionStaging(dir);
    try {
      await staging.init();
      const { bridge, port, token } = await start(dir);
      const pending = capture(bridge.fetchFile({ url: BOOK, taskId: 'task-3', staging, filename: 'novel.txt', allowNetwork: true, timeoutMs: 5_000 }));
      const { job } = await poll(port, token);
      await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job!.id}/fail`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ code: 'permission_missing', message: 'The site wants a login' }),
      });
      const outcome = await pending;
      expect(outcome.error).toBeInstanceOf(DownloadError);
      expect(outcome.error).toMatchObject({ code: 'policy_blocked', recoverable: false });

      const offline = new BrowserBridge({ dataDir: dir, port: 0, resolve: resolvePublic });
      const refused = await capture(offline.fetchPage(PAGE, { allowNetwork: true, timeoutMs: 1_000 }));
      expect(refused.error).toBeInstanceOf(BridgeError);
      await bridge.stop();
    } finally {
      discard();
    }
  });

  it('fails waiting work when the bridge stops', async () => {
    const { dir, discard } = scratch();
    try {
      const { bridge } = await start(dir);
      const pending = bridge.fetchPage(PAGE, { allowNetwork: true, timeoutMs: 10_000 });
      setTimeout(() => { void bridge.stop(); }, 50);
      await expect(pending).rejects.toBeInstanceOf(BridgeError);
    } finally {
      discard();
    }
  });
});
