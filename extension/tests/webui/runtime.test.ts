// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { mountRuntimeCard } from '../../src/webui/runtime.ts';
import type { RuntimeStatusView } from '../../src/novel-runtime/types.ts';

function baseStatus(patch: Partial<RuntimeStatusView> = {}): RuntimeStatusView {
  return {
    platform: { platform: 'win32', arch: 'x64', supported: true },
    installed: false, usable: false, runtimeId: null, runtimeVersion: null, soNovelVersion: null, javaVersion: null, source: null,
    health: { state: 'unknown', checkedAt: null }, install: null, error: null,
    online: { available: false, reason: '正式下载来源尚未配置；可导入离线运行时包', sizeBytes: null, fileName: null, urlHost: null },
    archiveBytes: 85_784_286, payloadBytes: 189_431_419, versions: [], canRollback: false, canUninstall: false, busyTasks: 0, bridgeProtocol: 1, note: null,
    ...patch,
  };
}

function context(statuses: RuntimeStatusView[], invokes: Array<{ method: string; args: unknown[] }> = []) {
  let index = 0;
  const ctx = {
    root: document.createElement('div'), panelId: 'settings', language: 'zh', signal: new AbortController().signal,
    invoke: async (method: string, args: unknown[] = []) => {
      invokes.push({ method, args });
      if (method === 'runtime_status') return statuses[Math.min(index++, statuses.length - 1)];
      if (method === 'runtime_probe') return { ok: true, health: baseStatus().health };
      if (method === 'runtime_check_source') return { ok: true, message: 'ok' };
      return {};
    },
    interval: () => ({ dispose() {} }),
    ui: { confirm: async () => true, toast: () => ({ dispose() {} }) },
  } as unknown as WebUiPanelContext;
  return { ctx, invokes };
}
async function flush(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 30)); }
function button(root: HTMLElement, label: string): HTMLButtonElement | undefined { return [...root.querySelectorAll('button')].find((node) => node.textContent === label) as HTMLButtonElement | undefined; }

describe('runtime settings card', () => {
  it('shows real sizes and a disabled online button when no trusted source is configured', async () => {
    const { ctx } = context([baseStatus()]);
    const host = document.createElement('div');
    mountRuntimeCard(host, ctx);
    await flush();
    expect(host.textContent).toContain('未安装');
    expect(host.textContent).toContain('81.8 MiB');
    expect(host.textContent).toContain('正式下载来源尚未配置');
    expect(host.textContent).toContain('一键安装不可用');
    expect(button(host, '一键安装小说引擎')!.disabled).toBe(true);
    expect(button(host, '导入离线运行时包')).toBeTruthy();
  });

  it('shows the configured offline ZIP address when one-click install is unavailable', async () => {
    const url = 'https://downloads.example.test/bookfish-novel-runtime.zip';
    const { ctx } = context([baseStatus({ online: { ...baseStatus().online, offlineUrl: url, offlineFileName: 'bookfish-novel-runtime.zip', offlineSizeBytes: 85_784_286 } })]);
    const host = document.createElement('div');
    mountRuntimeCard(host, ctx);
    await flush();
    const link = host.querySelector<HTMLAnchorElement>('a.runtime-offline-link')!;
    expect(link.hidden).toBe(false);
    expect(link.href).toBe(url);
    expect(link.textContent).toContain('下载离线运行时包');
    expect(link.textContent).toContain('81.8 MiB');
  });

  it('enables one-click install when an operator configured a trusted origin', async () => {
    const invokes: Array<{ method: string; args: unknown[] }> = [];
    const { ctx } = context([baseStatus({ online: { available: true, reason: null, sizeBytes: 85_784_286, fileName: 'runtime.zip', urlHost: 'runtime.example.test' } })], invokes);
    const host = document.createElement('div');
    mountRuntimeCard(host, ctx);
    await flush();
    const install = button(host, '一键安装小说引擎')!;
    expect(install.disabled).toBe(false);
    install.click();
    await flush();
    expect(invokes.some((call) => call.method === 'runtime_install')).toBe(true);
  });

  it('polls after a one-click install so the card does not freeze at the first byte count', async () => {
    const downloading = baseStatus({ install: { installId: 'i', kind: 'online', phase: 'downloading', runtimeId: 'r', bytesReceived: 0, bytesTotal: 85_784_286, percent: 0, speedBytesPerSecond: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null }, online: { available: true, reason: null, sizeBytes: 85_784_286, fileName: 'zip', urlHost: 'x' } });
    const ready = baseStatus({ installed: true, usable: true, runtimeId: 'r', runtimeVersion: '1.12.0-bf1', soNovelVersion: '1.12.0', source: 'managed', health: { state: 'ok', checkedAt: new Date().toISOString(), message: 'ok' }, install: { installId: 'i', kind: 'online', phase: 'ready', runtimeId: 'r', bytesReceived: 85_784_286, bytesTotal: 85_784_286, percent: 100, speedBytesPerSecond: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null }, online: { available: true, reason: null, sizeBytes: 85_784_286, fileName: 'zip', urlHost: 'x' }, canUninstall: true });
    const { ctx } = context([baseStatus({ online: downloading.online }), downloading, ready]);
    const host = document.createElement('div');
    mountRuntimeCard(host, ctx);
    await flush();
    button(host, '一键安装小说引擎')!.click();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await flush();
    expect(host.textContent).toContain('可用');
    expect(host.querySelector('progress')!.hidden).toBe(true);
  });

  it('renders measured download progress and a cancel action, then hides progress when ready', async () => {
    const downloading = baseStatus({ install: { installId: 'i', kind: 'online', phase: 'downloading', runtimeId: 'r', bytesReceived: 42_892_143, bytesTotal: 85_784_286, percent: 50, speedBytesPerSecond: 5_000_000, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null } });
    const ready = baseStatus({ installed: true, usable: true, runtimeId: 'r', runtimeVersion: '1.12.0-bf1', soNovelVersion: '1.12.0', source: 'managed', health: { state: 'ok', checkedAt: new Date().toISOString(), message: 'Java 21.0.8 · 引擎 1.12.0 · 13 个书源' }, install: { installId: 'i', kind: 'online', phase: 'ready', runtimeId: 'r', bytesReceived: 85_784_286, bytesTotal: 85_784_286, percent: 100, speedBytesPerSecond: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null }, online: { available: true, reason: null, sizeBytes: 85_784_286, fileName: 'zip', urlHost: 'x' }, canUninstall: true });
    const { ctx } = context([downloading, ready]);
    const host = document.createElement('div');
    mountRuntimeCard(host, ctx, { onReady: () => undefined });
    await flush();
    expect(host.querySelector('progress')!.value).toBe(50);
    expect(host.textContent).toContain('下载运行时');
    expect(host.textContent).toContain('正在下载固定版本的运行时压缩包');
    expect(button(host, '取消安装')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await flush();
    expect(host.querySelector('progress')!.hidden).toBe(true);
    expect(host.textContent).toContain('可用');
    expect(button(host, '卸载运行时')).toBeTruthy();
  });
});
