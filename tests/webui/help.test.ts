// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { HelpCenter } from '../../src/help-center.ts';
import { HelpCenterView, renderHelpBanner, renderMarkdown } from '../../src/webui/help.ts';
import type { AnnouncementView } from '../../src/help-store.ts';
import type { OnlineAnnouncements } from '../../src/webui/announcements.ts';

const onlineFeed: OnlineAnnouncements = {
  schemaVersion: 1,
  updatedAt: '2026-11-21T10:00:00Z',
  announcements: [{
    id: 'online-1', publishedAt: '2026-11-21T09:00:00Z', title: '在线动态标题', category: 'feature', content: '这是在线动态正文。', link: 'https://example.com/post',
  }],
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function center(): HelpCenter {
  const dir = mkdtempSync(join(tmpdir(), 'bookfish-help-ui-'));
  dirs.push(dir);
  const value = new HelpCenter({ dataDir: dir, currentVersion: '0.65.1', now: () => new Date('2026-11-21T12:00:00Z') });
  value.open();
  return value;
}

function context(centerValue: HelpCenter, calls: Array<{ method: string; args: unknown[] }>): WebUiPanelContext {
  const controller = new AbortController();
  return {
    root: document.createElement('div'), panelId: 'status', language: 'zh', signal: controller.signal,
    invoke: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === 'help_index') return centerValue.index(false);
      if (method === 'help_guide') return centerValue.guide(String(args[0]));
      if (method === 'help_release') return centerValue.release(args.length ? String(args[0]) : undefined);
      if (method === 'help_progress') return centerValue.progress();
      if (method === 'help_online') return onlineFeed;
      if (method === 'help_updates_viewed') return centerValue.markUpdatesViewed();
      if (method === 'help_mark') return centerValue.mark(String(args[0]), args[1] as 'viewed' | 'dismissed');
      throw new Error(`Unexpected help invoke ${method}`);
    },
    ui: { drawer: vi.fn(() => ({ dispose() {} })) },
    own: <T,>(value: T) => value,
  } as unknown as WebUiPanelContext;
}

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 30)); };

describe('help center view', () => {
  it('loads only the index first and fetches a guide on demand', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const view = new HelpCenterView(context(data, calls), (zh) => zh, () => undefined);
    const host = document.createElement('div');
    await view.open(host);
    expect(calls.map((call) => call.method)).toEqual(['help_index']);
    expect(host.querySelectorAll('.bf-help-item').length).toBe(19);
    expect(host.textContent).toContain('大肥鱼 · 功能指南');

    const first = host.querySelector<HTMLButtonElement>('.bf-help-item')!;
    first.click();
    await flush();
    expect(calls.filter((call) => call.method === 'help_guide')).toHaveLength(1);
    expect(host.querySelector('.bf-help-body')?.textContent).toContain('怎么使用');
    [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('返回功能目录'))!.click();
    expect(host.querySelector<HTMLElement>('.bf-help-category')?.hidden).toBe(false);
    host.querySelector<HTMLButtonElement>('.bf-help-item')!.click();
    await flush();
    expect(calls.filter((call) => call.method === 'help_guide')).toHaveLength(1);
  });

  it('loads releases and history lazily, then progress on its own tab', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const view = new HelpCenterView(context(data, calls), (zh) => zh, () => undefined, async () => onlineFeed);
    const host = document.createElement('div');
    await view.open(host, 'updates');
    await flush();
    expect(host.textContent).toContain('在线动态标题');
    [...host.querySelectorAll<HTMLButtonElement>('.bf-help-subtabs button')].find((button) => button.textContent === '版本更新')!.click();
    await flush();
    expect(calls.filter((call) => call.method === 'help_release')).toHaveLength(1);
    const history = [...host.querySelectorAll<HTMLButtonElement>('.bf-help-history button')];
    expect(history.length).toBeGreaterThan(0);
    history[0]!.click();
    await flush();
    expect(calls.filter((call) => call.method === 'help_release')).toHaveLength(2);
    [...host.querySelectorAll<HTMLButtonElement>('.bf-help-subtabs button')].find((button) => button.textContent === '开发进度')!.click();
    await flush();
    expect(calls.some((call) => call.method === 'help_progress')).toBe(true);
    expect(host.textContent).toContain('开发进度更新于');
  });

  it('shows online updates and keeps the built-in version visible', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const view = new HelpCenterView(context(data, calls), (zh) => zh, () => undefined, async () => onlineFeed);
    const host = document.createElement('div');
    await view.open(host, 'updates');
    await flush();
    expect(host.querySelector('.bf-help-online-item')?.textContent).toContain('在线动态标题');
    expect(host.querySelector('.bf-help-builtin')?.textContent).toContain('版本更新（内置）');
    expect(host.textContent).toContain('GitHub 在线动态');
  });

  it('retries through the server-side loader when the browser cannot reach GitHub', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('browser blocked'); }));
    const view = new HelpCenterView(context(data, calls), (zh) => zh, () => undefined);
    const host = document.createElement('div');
    await view.open(host, 'updates');
    await flush();
    expect(calls.some((call) => call.method === 'help_online')).toBe(true);
    expect(host.querySelector('.bf-help-online-item')?.textContent).toContain('在线动态标题');
  });

  it('shows the bundled release card and a reason when both online loaders fail', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const view = new HelpCenterView(context(data, calls), (zh) => zh, () => undefined, async () => { throw new Error('offline'); });
    const host = document.createElement('div');
    await view.open(host, 'updates');
    await flush();
    expect(host.textContent).toContain('在线动态暂不可用');
    expect(host.querySelector('.bf-help-builtin')).not.toBeNull();
    expect(host.querySelector('.bf-help-online-item')).toBeNull();
  });

  it('renders markdown without injecting HTML and resolves help links', () => {
    const clicked: string[] = [];
    const node = renderMarkdown('# 标题\n\n**粗体** 和 `代码`\n\n- 一项\n\n<script>alert(1)</script>\n\n[说明](help:autonomous-reading)', (id) => clicked.push(id));
    expect(node.querySelector('script')).toBeNull();
    expect(node.querySelector('strong')?.textContent).toBe('粗体');
    expect(node.querySelector('code')?.textContent).toBe('代码');
    expect(node.querySelector('li')?.textContent).toBe('一项');
    const link = node.querySelector('a')!;
    link.click();
    expect(clicked).toEqual(['autonomous-reading']);
  });

  it('keeps a friendly error and a retry path when a guide is missing', async () => {
    const data = center();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const host = document.createElement('div');
    const ctx = context(data, calls);
    const original = ctx.invoke;
    (ctx as unknown as { invoke: WebUiPanelContext['invoke'] }).invoke = async (method: string, args: unknown[] = []) => {
      if (method === 'help_guide') throw new Error('missing guide');
      return original(method, args);
    };
    const view = new HelpCenterView(ctx, (zh) => zh, () => undefined);
    await view.open(host);
    host.querySelector<HTMLButtonElement>('.bf-help-item')!.click();
    await flush();
    expect(host.querySelector('.bf-help-error')?.textContent).toContain('暂时打不开');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === '重试')).toBe(true);
  });

  it('highlights changed guide paragraphs by exact snippet', () => {
    const snippet = '配置项旁的「?」会直接打开对应说明，不会触发阅读、下载或保存。';
    const node = renderMarkdown(`# 配置\n\n- ${snippet}\n\n普通段落。`, undefined, [snippet]);
    expect(node.querySelector('.bf-help-changed-block')?.textContent).toContain(snippet);
  });

  it('renders a one-time banner with view and dismiss actions', () => {
    const announcement: AnnouncementView = { announcementId: 'major-1', version: '1.1.0', releaseDate: '2026-11-21', title: '大肥鱼有新变化啦！', summary: '这次有一些值得了解的新功能。' };
    const view = vi.fn(); const dismiss = vi.fn();
    const banner = renderHelpBanner(announcement, (zh) => zh, { onView: view, onDismiss: dismiss });
    expect(banner.textContent).toContain('大肥鱼有新变化啦');
    [...banner.querySelectorAll('button')].find((button) => button.textContent === '查看更新')!.click();
    expect(view).toHaveBeenCalledOnce();
    [...banner.querySelectorAll('button')].find((button) => button.textContent === '以后再看')!.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
