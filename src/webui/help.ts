import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { HelpGuideView, HelpIndexView, HelpProgressView, HelpReleaseView } from '../help-center.ts';
import type { AnnouncementView } from '../help-store.ts';
import { AnnouncementsError, fetchAnnouncements, type OnlineAnnouncement, type OnlineAnnouncements } from './announcements.ts';

type Say = (zh: string, english: string) => string;
type OnlineLoader = (signal?: AbortSignal) => Promise<OnlineAnnouncements>;

const ONLINE_CATEGORY_LABEL: Record<OnlineAnnouncement['category'], [string, string]> = {
  development: ['开发进展', 'Development'],
  feature: ['功能更新', 'Feature'],
  notice: ['通知公告', 'Notice'],
};

const STATUS_LABEL: Record<string, [string, string]> = {
  planned: ['计划中', 'Planned'],
  developing: ['开发中', 'In development'],
  testing: ['测试中', 'Testing'],
  accepted: ['已完成验收', 'Accepted'],
  released: ['已发布', 'Released'],
  paused: ['暂缓', 'Paused'],
};

const KIND_LABEL: Record<string, [string, string]> = {
  feature: ['新增', 'New'],
  improvement: ['改进', 'Improved'],
  fix: ['修复', 'Fixed'],
  compatibility: ['兼容性', 'Compatibility'],
  note: ['说明', 'Note'],
};

export const helpStyle = `
.bf nav{flex-wrap:wrap}
.bf-help{max-width:860px;margin:0 auto;color:#283d3a}
.bf-help-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:0 0 16px}
.bf-help-head h2{margin:0 0 4px}.bf-help-head p{margin:2px 0;color:#5f7064}
.bf-help-tagline{font-size:16px;line-height:1.7}.bf-help-version{font-size:12px;color:#6e7b70;border:1px solid #d9e3d3;background:#f7f9f2;border-radius:999px;padding:4px 10px;white-space:nowrap}
.bf-help-tabs,.bf-help-subtabs{display:flex;gap:6px;border-bottom:1px solid #dde5d8;margin:0 0 18px;flex-wrap:wrap}
.bf-help-tabs button,.bf-help-subtabs button{border:0;border-radius:0;background:none;padding:9px 2px;margin-right:18px;color:#5b6d60}
.bf-help-tabs button[aria-selected=true],.bf-help-subtabs button[aria-selected=true]{border-bottom:3px solid #386c58;color:#283d3a;font-weight:600}
.bf-help-scroll{min-height:0;padding:2px 6px 20px 2px}
.bf-help-category{border:1px solid #e0e6d9;border-radius:14px;background:#fffefa;margin:0 0 12px;padding:0 16px}
.bf-help-category>summary{padding:14px 2px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.bf-help-category>summary strong{font-size:16px}.bf-help-category>summary small{color:#6e7b70}
.bf-help-list{display:grid;gap:8px;padding:0 0 14px}
.bf-help-item{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;text-align:left;border:1px solid #e3e9dd;background:#fbfcf7;border-radius:10px;padding:10px 12px;color:#283d3a}
.bf-help-item:hover{background:#eef3e7;border-color:#cbd8c3}
.bf-help-item-icon{font-size:20px;line-height:1.3}.bf-help-item strong{display:block;font-size:15px}.bf-help-item small{display:block;color:#6e7b70;line-height:1.55}
.bf-help-badge{display:inline-block;font-size:11px;font-weight:500;border-radius:999px;padding:1px 8px;margin-left:6px;background:#f4ecd7;color:#7c5c1c;vertical-align:1px}
.bf-help-badge.update{background:#e7f0fb;color:#2e5f8a}.bf-help-badge.new{background:#2f6fb3;color:#fff;font-weight:600}
.bf-help-changed-block{background:#fff3c4;border-left:3px solid #d4a22f;border-radius:5px;padding:7px 11px;margin-left:-2px}
.bf-help-changed-note{display:flex;flex-wrap:wrap;gap:5px 8px;align-items:center;background:#e7f0fb;color:#2e5f8a;border-radius:7px;padding:6px 10px;font-size:13px;margin:8px 0}
.bf-help-jump{border:1px solid #a9c5df;background:#f7fbff;color:#2e5f8a;border-radius:999px;padding:1px 9px;font-size:12px}
.bf-help-jump:hover{background:#e3f0fb}
.bf-help-release-item.is-new{background:#eef5ff;border-left:3px solid #3b78b5;border-radius:6px;padding:6px 9px}
.bf-help-detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px}.bf-help-detail-head h2,.bf-help-detail-head h3{margin:0}
.bf-help-body{overflow-wrap:anywhere}.bf-help-body h2{font-size:22px;margin:6px 0 8px}.bf-help-body h3{font-size:17px;margin:20px 0 6px}.bf-help-body h4{font-size:15px;margin:16px 0 4px}
.bf-help-body p{margin:7px 0}.bf-help-body ul,.bf-help-body ol{margin:4px 0 10px;padding-left:24px}.bf-help-body ul{list-style:disc}.bf-help-body ol{list-style:decimal}.bf-help-body li{margin:3px 0;display:list-item}
.bf-help-body blockquote{margin:8px 0;padding:8px 14px;border-left:3px solid #b7c7ac;background:#f2f5ed;color:#405b4b}
.bf-help-body code{background:#eef2e8;border-radius:4px;padding:1px 5px;font-size:.92em}
.bf-help-body hr{border:0;border-top:1px solid #dde5d8;margin:18px 0}
.bf-help-body details{border:1px solid #e0e6d9;border-radius:10px;padding:0 12px;margin:12px 0;background:#fbfcf7}
.bf-help-body details>summary{padding:10px 0}
.bf-help-body a{color:#386c58;text-decoration:underline;text-underline-offset:3px}
.bf-help-error,.bf-help-empty{border:1px solid #e2c98f;background:#fbf5df;color:#6d551c;border-radius:10px;padding:12px 14px;margin:10px 0}
.bf-help-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.bf-help-release,.bf-help-progress,.bf-help-builtin,.bf-help-online-item{border:1px solid #e0e6d9;border-radius:14px;background:#fffefa;padding:16px 18px;margin:0 0 12px}
.bf-help-builtin{background:#f7f9f2;border-style:dashed}
.bf-help-online-item{border-left:4px solid #3b78b5;background:#fbfdff}
.bf-help-online-item .bf-help-source{background:#e3f0fb;color:#2e5f8a}
.bf-help-builtin h3,.bf-help-online-item h3{margin:0 0 4px}
.bf-help-builtin-meta,.bf-help-online-meta{font-size:12px;color:#6e7b70;display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.bf-help-online-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:18px 0 8px}
.bf-help-online-head h4{margin:0;font-size:15px}
.bf-help-online-content{white-space:pre-wrap;line-height:1.7;margin:6px 0}
.bf-help-source{font-size:11px;border-radius:999px;padding:1px 8px;background:#eef3e7;color:#58705f}
.bf-help-refresh{border:1px solid #c9d7c1;background:#f7f9f2;color:#386c58;border-radius:999px;padding:4px 10px;font-size:12px}
.bf-help-refresh:disabled{opacity:.55}
.bf-help-release h3,.bf-help-progress h3{margin:0 0 4px}.bf-help-release-meta,.bf-help-progress-meta{font-size:12px;color:#6e7b70;display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.bf-help-release-item{margin:6px 0;padding-left:2px}.bf-help-release-item b{color:#386c58;font-weight:600}
.bf-help-history{display:grid;gap:6px;margin:8px 0 0}.bf-help-history button{text-align:left;background:#fbfcf7;border:1px solid #e3e9dd;border-radius:9px;padding:9px 11px}
.bf-help-history button:hover{background:#eef3e7}.bf-help-history small{display:block;color:#6e7b70;font-weight:400}
.bf-help-progress-status{display:inline-block;font-size:11px;border-radius:999px;padding:2px 9px;background:#e7ece2;color:#58705f;margin-left:4px}
.bf-help-progress-status[data-status=developing],.bf-help-progress-status[data-status=testing]{background:#f4ecd7;color:#7c5c1c}
.bf-help-progress-status[data-status=accepted]{background:#dcefdc;color:#28643c}.bf-help-progress-status[data-status=released]{background:#dcefdc;color:#28643c}.bf-help-progress-status[data-status=paused]{background:#eee9e1;color:#6e6458}
.bf-help-banner{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;border:1px solid #d9c58b;background:#fbf5df;border-radius:12px;padding:14px 16px;margin:0 0 18px;box-shadow:0 4px 14px #493c1710}
.bf-help-banner strong{display:block;font-size:16px;color:#5f4a18}.bf-help-banner p{margin:4px 0 0;color:#6d5a2c;font-size:14px}.bf-help-banner-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bf-help-banner-actions .close{border-color:transparent;background:transparent;color:#6d5a2c;padding:8px 6px}
.bf-help-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#b2644c;margin-left:6px;vertical-align:2px}
.bf-help-question{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;min-width:22px;padding:0;margin-left:6px;border-radius:50%;border:1px solid #c9d7c1;background:#f7f9f2;color:#386c58;font-size:13px;font-weight:700;line-height:1;vertical-align:1px}
.bf-help-question:hover{background:#e5eedd}.bf-settings .bf-help-question{margin-left:8px}
@media(max-width:620px){.bf-help-head h2{font-size:20px}.bf-help-banner{flex-direction:column}.bf-help-banner-actions{width:100%}.bf-help-banner-actions button{flex:1}.bf-help-category{padding:0 10px}}
`;

function appendInline(parent: HTMLElement, text: string, onHelpLink?: (id: string) => void): void {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) parent.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong'); strong.textContent = token.slice(2, -2); parent.append(strong);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.append(code);
    } else {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      const label = parsed?.[1] ?? token;
      const target = parsed?.[2] ?? '';
      if (target.startsWith('help:') && onHelpLink) {
        const id = target.slice('help:'.length);
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = label;
        link.addEventListener('click', (event) => { event.preventDefault(); onHelpLink(id); });
        parent.append(link);
      } else if (/^https?:\/\//u.test(target)) {
        const link = document.createElement('a');
        link.href = target; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = label;
        parent.append(link);
      } else {
        parent.append(document.createTextNode(label));
      }
    }
    offset = match.index! + token.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

/** Minimal, deliberately safe Markdown renderer. It never assigns innerHTML. */
export function renderMarkdown(markdown: string, onHelpLink?: (id: string) => void, highlights: string[] = []): HTMLElement {
  const root = document.createElement('div');
  root.className = 'bf-help-body';
  let container: HTMLElement = root;
  let paragraph: string[] = [];
  let list: HTMLElement | undefined;
  let listTag: 'ul' | 'ol' | undefined;

  const closeList = (): void => { list = undefined; listTag = undefined; };
  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '), onHelpLink);
    container.append(p);
    paragraph = [];
  };
  const closeBlocks = (): void => { flushParagraph(); closeList(); };

  for (const raw of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeBlocks(); continue; }
    if (line.startsWith('```')) { closeBlocks(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      closeBlocks();
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (level === 2 && title === '进一步了解') {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = title;
        details.append(summary);
        root.append(details);
        container = details;
      } else {
        const node = document.createElement(level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4');
        appendInline(node, title, onHelpLink);
        container.append(node);
      }
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/u.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || listTag !== 'ul') { list = document.createElement('ul'); listTag = 'ul'; container.append(list); }
      const li = document.createElement('li'); appendInline(li, bullet[1]!, onHelpLink); list.append(li);
      continue;
    }
    const ordered = /^\d+\.\s+(.+)$/u.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || listTag !== 'ol') { list = document.createElement('ol'); listTag = 'ol'; container.append(list); }
      const li = document.createElement('li'); appendInline(li, ordered[1]!, onHelpLink); list.append(li);
      continue;
    }
    if (line.startsWith('> ')) {
      closeBlocks();
      const quote = document.createElement('blockquote'); appendInline(quote, line.slice(2), onHelpLink); container.append(quote);
      continue;
    }
    if (line.trim() === '---') { closeBlocks(); container.append(document.createElement('hr')); continue; }
    closeList();
    paragraph.push(line);
  }
  closeBlocks();
  if (highlights.length) {
    for (const block of root.querySelectorAll<HTMLElement>('p, li, blockquote')) {
      const text = block.textContent ?? '';
      if (highlights.some((snippet) => text.includes(snippet))) block.classList.add('bf-help-changed-block');
    }
  }
  return root;
}

function scrollWindowTo(top: number): void {
  try {
    if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    if (typeof navigator !== 'undefined' && /jsdom/iu.test(navigator.userAgent)) return;
    window.scrollTo({ top, behavior: 'auto' });
  } catch { /* scrolling is a progressive enhancement */ }
}

function formatDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : value;
}

function formatTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/(?:\.\d+)?Z$/u, ' UTC');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; parent?.append(node); return node;
}

export function renderHelpBanner(announcement: AnnouncementView, say: Say, actions: { onView: () => void; onDismiss: () => void }): HTMLElement {
  const banner = document.createElement('section');
  banner.className = 'bf-help-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', announcement.title);
  const copy = el('div', '', banner);
  el('strong', announcement.title, copy);
  el('p', announcement.summary || say('这次更新有一些值得了解的变化。', 'There are changes worth a look in this update.'), copy);
  const buttons = el('div', '', banner); buttons.className = 'bf-help-banner-actions';
  const view = el('button', say('查看更新', 'View update'), buttons); view.type = 'button'; view.className = 'primary';
  view.addEventListener('click', actions.onView);
  const later = el('button', say('以后再看', 'Later'), buttons); later.type = 'button'; later.addEventListener('click', actions.onDismiss);
  const close = el('button', '×', buttons); close.type = 'button'; close.className = 'close'; close.setAttribute('aria-label', say('关闭更新提醒', 'Close update notice')); close.addEventListener('click', actions.onDismiss);
  return banner;
}

export class HelpCenterView {
  private index: HelpIndexView | undefined;
  private root: HTMLElement | undefined;
  private tabs: HTMLElement | undefined;
  private catalog: HTMLElement | undefined;
  private detail: HTMLElement | undefined;
  private updates: HTMLElement | undefined;
  private scroll: HTMLElement | undefined;
  private tab: 'guide' | 'updates' = 'guide';
  private updateTab: 'announcements' | 'releases' | 'progress' = 'announcements';
  private activeGuide: string | undefined;
  private currentRelease: HelpReleaseView | undefined;
  private progress: HelpProgressView | undefined;
  private readonly releaseCache = new Map<string, HelpReleaseView>();
  private readonly guideCache = new Map<string, HelpGuideView>();
  private readonly seenFeatures = new Set<string>();
  private seenUpdates = false;
  private changeNote: HTMLElement | undefined;
  private viewedMarked = false;
  private savedScroll = 0;
  private disposed = false;
  private onlineRequest = 0;
  private onlineController: AbortController | undefined;
  private readonly loadOnline: OnlineLoader;

  constructor(
    private readonly ctx: WebUiPanelContext,
    private readonly say: Say,
    private readonly onUnread: (unread: boolean) => void,
    loadOnline?: OnlineLoader,
  ) {
    this.loadOnline = loadOnline ?? (async (signal) => {
      try {
        return await fetchAnnouncements({ signal, timeoutMs: 5000 });
      } catch (browserError) {
        if (signal?.aborted) throw browserError;
        try {
          return await this.ctx.invoke<OnlineAnnouncements>('help_online');
        } catch {
          throw browserError;
        }
      }
    });
  }

  async prime(claim = true): Promise<{ unread: boolean; announcement?: AnnouncementView }> {
    try {
      const view = await this.ctx.invoke<HelpIndexView>('help_index', [claim]);
      this.index = view;
      this.onUnread(view.unread);
      return { unread: view.unread, ...(view.announcement ? { announcement: view.announcement } : {}) };
    } catch {
      return { unread: false };
    }
  }

  private async ensureIndex(claim = false): Promise<HelpIndexView> {
    if (this.index) return this.index;
    const view = await this.ctx.invoke<HelpIndexView>('help_index', [claim]);
    this.index = view;
    this.onUnread(view.unread);
    return view;
  }

  async markViewed(announcementId: string): Promise<void> {
    try {
      await this.ctx.invoke('help_mark', [announcementId, 'viewed']);
      const result = await this.ctx.invoke<{ unread: boolean }>('help_updates_viewed', []);
      this.onUnread(result.unread);
      void this.ctx.refresh();
    } catch { /* the guide remains manually available */ }
  }

  async markDismissed(announcementId: string): Promise<void> {
    try {
      const result = await this.ctx.invoke<{ unread: boolean }>('help_mark', [announcementId, 'dismissed']);
      this.onUnread(result.unread);
    } catch { /* closing the banner is a local UI action */ }
  }

  async open(host: HTMLElement, tab: 'guide' | 'updates' = 'guide'): Promise<void> {
    if (this.disposed) return;
    if (!this.root) {
      if (!this.index) { try { await this.ensureIndex(); } catch { /* build shows the error state */ } }
      this.build(host);
    }
    this.tab = tab;
    this.applyTab();
    if (tab === 'updates') await this.renderUpdates();
  }

  private build(host: HTMLElement): void {
    const root = document.createElement('section'); root.className = 'bf-help'; host.replaceChildren(root); this.root = root;
    const tabs = el('div', '', root); tabs.className = 'bf-help-tabs'; tabs.setAttribute('role', 'tablist'); this.tabs = tabs;
    const guideTab = el('button', this.say('功能指南', 'Feature guide'), tabs); guideTab.type = 'button'; guideTab.setAttribute('role', 'tab');
    const updatesTab = el('button', this.say('更新动态', 'Updates'), tabs); updatesTab.type = 'button'; updatesTab.setAttribute('role', 'tab');
    guideTab.addEventListener('click', () => {
      if (this.tab === 'updates') { this.seenUpdates = true; this.onlineRequest += 1; this.onlineController?.abort(); }
      this.tab = 'guide'; this.applyTab();
    });
    updatesTab.addEventListener('click', () => { this.tab = 'updates'; this.applyTab(); void this.renderUpdates(); });
    const header = el('header', '', root); header.className = 'bf-help-head';
    const copy = el('div', '', header);
    el('h2', this.say('大肥鱼 · 功能指南', 'Bookfish · Help center'), copy);
    el('p', this.say('送她一本书，剩下的交给她。', 'Hand her a book and let her take it from there.'), copy).className = 'bf-help-tagline';
    el('p', this.say('想知道大肥鱼会什么？点开看看吧！', 'Want to know what she can do? Open a card below.'), copy).className = 'bf-help-tagline';
    const version = el('span', '', header); version.className = 'bf-help-version';
    version.textContent = this.say('当前版本 ', 'Installed ') + (this.index?.currentVersion ?? '…');
    const changed = this.index?.changedFeatures ?? [];
    if (changed.length) {
      const note = document.createElement('div'); note.className = 'bf-help-changed-note'; root.append(note); this.changeNote = note;
      note.append(document.createTextNode(this.say(`本次有 ${changed.length} 项功能说明更新：`, `${changed.length} guide${changed.length === 1 ? '' : 's'} changed: `)));
      for (const change of changed) {
        const title = this.index?.features.flatMap((category) => category.features).find((feature) => feature.id === change.featureId)?.title ?? change.featureId;
        const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'bf-help-jump'; jump.textContent = title;
        jump.addEventListener('click', () => void this.openGuide(change.featureId));
        note.append(jump);
      }
    }
    const scroll = document.createElement('div'); scroll.className = 'bf-help-scroll'; root.append(scroll); this.scroll = scroll;
    const catalog = document.createElement('div'); scroll.append(catalog); this.catalog = catalog;
    const detail = document.createElement('div'); detail.hidden = true; scroll.append(detail); this.detail = detail;
    const updates = document.createElement('div'); updates.hidden = true; scroll.append(updates); this.updates = updates;
    this.renderCatalog();
  }

  private applyTab(): void {
    if (!this.root || !this.catalog || !this.detail || !this.updates) return;
    const guideActive = this.tab === 'guide';
    this.catalog.hidden = !guideActive || !!this.activeGuide;
    this.detail.hidden = !guideActive || !this.activeGuide;
    this.updates.hidden = !guideActive;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.bf-help-tabs button')) {
      button.setAttribute('aria-selected', String((button.textContent === this.say('功能指南', 'Feature guide')) === guideActive));
    }
    if (this.tabs) this.tabs.hidden = guideActive && !!this.activeGuide;
    if (!guideActive) { this.catalog.hidden = true; this.detail.hidden = true; this.updates.hidden = false; }
  }

  private renderCatalog(): void {
    if (!this.catalog) return;
    this.catalog.replaceChildren();
    const index = this.index;
    if (!index || !index.features.length) {
      const box = el('div', index?.warning ? this.say('帮助内容暂时打不开：', 'Help content is unavailable: ') + index.warning : this.say('帮助内容暂时没有加载出来。', 'Help content is not available yet.'), this.catalog);
      box.className = 'bf-help-error';
      const retry = el('button', this.say('重试', 'Retry'), box); retry.type = 'button';
      retry.addEventListener('click', () => { void this.reload(); });
      return;
    }
    if (index.warning) {
      const box = el('div', this.say('提示：', 'Note: ') + index.warning, this.catalog);
      box.className = 'bf-help-error';
    }
    const changed = new Set((index.changedFeatures ?? []).map((change) => change.featureId));
    let first = true;
    for (const category of index.features) {
      const categoryChanged = category.features.some((feature) => changed.has(feature.id));
      const details = document.createElement('details'); details.className = 'bf-help-category'; details.open = first || categoryChanged; first = false;
      const summary = document.createElement('summary');
      el('strong', `${category.icon} ${category.title}`, summary);
      el('small', category.summary, summary);
      details.append(summary);
      const list = el('div', '', details); list.className = 'bf-help-list';
      for (const feature of category.features) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'bf-help-item'; button.dataset.featureId = feature.id;
        const icon = el('span', feature.icon, button); icon.className = 'bf-help-item-icon';
        const text = el('span', '', button);
        const title = el('strong', feature.title, text);
        if (feature.experimental) { const badge = el('span', this.say('实验功能', 'Experimental'), title); badge.className = 'bf-help-badge'; }
        if (changed.has(feature.id) && !this.seenFeatures.has(feature.id)) { const badge = el('span', this.say('有更新', 'Updated'), title); badge.className = 'bf-help-badge update'; }
        el('small', feature.summary, text);
        button.addEventListener('click', () => void this.openGuide(feature.id));
        list.append(button);
      }
      this.catalog.append(details);
    }
  }

  private async reload(): Promise<void> {
    this.index = undefined;
    try { await this.ensureIndex(); } catch { /* renderCatalog shows its own state */ }
    this.renderCatalog();
  }

  async openGuide(id: string): Promise<void> {
    if (!this.catalog || !this.detail || !this.scroll) return;
    this.seenFeatures.add(id);
    const card = this.catalog.querySelector<HTMLElement>(`[data-feature-id="${id}"]`);
    card?.querySelector('.bf-help-badge.update')?.remove();
    if (this.changeNote && this.index?.changedFeatures.every((change) => this.seenFeatures.has(change.featureId))) this.changeNote.hidden = true;
    this.activeGuide = id;
    this.savedScroll = window.scrollY;
    if (this.tabs) this.tabs.hidden = true;
    this.catalog.hidden = true;
    this.updates!.hidden = true;
    this.detail.hidden = false;
    scrollWindowTo(0);
    this.detail.replaceChildren();
    const back = el('button', this.say('← 返回功能目录', '← Back to guide'), this.detail); back.type = 'button';
    back.addEventListener('click', () => this.backToCatalog());
    const cached = this.guideCache.get(id);
    if (cached) { this.renderGuideDetail(cached, back); return; }
    const loading = el('p', this.say('正在加载说明…', 'Loading guide…'), this.detail); loading.className = 'bf-help-empty';
    try {
      const guide = await this.ctx.invoke<HelpGuideView>('help_guide', [id]);
      if (this.disposed || this.activeGuide !== id) return;
      this.guideCache.set(id, guide);
      this.renderGuideDetail(guide, back);
    } catch (error) {
      if (this.disposed) return;
      this.detail.replaceChildren(back);
      const box = el('div', this.say('这项说明暂时打不开。', 'This guide is unavailable right now.'), this.detail); box.className = 'bf-help-error';
      el('small', String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, ''), box);
      const retry = el('button', this.say('重试', 'Retry'), box); retry.type = 'button';
      retry.addEventListener('click', () => void this.openGuide(id));
    }
  }

  private renderGuideDetail(guide: HelpGuideView, back: HTMLButtonElement): void {
    if (!this.detail) return;
    this.detail.replaceChildren(back);
    const head = el('div', '', this.detail); head.className = 'bf-help-detail-head';
    const title = el('h2', guide.title, head); title.tabIndex = -1;
    if (guide.experimental) { const badge = el('span', this.say('实验功能', 'Experimental'), head); badge.className = 'bf-help-badge'; }
    el('p', guide.summary, this.detail).className = 'bf-help-tagline';
    if (guide.changed?.summary) el('p', this.say('本次更新：', 'Updated: ') + guide.changed.summary, this.detail).className = 'bf-help-changed-note';
    const body = renderMarkdown(guide.markdown, (next) => void this.openGuide(next), guide.changed?.snippets ?? []);
    const duplicate = body.querySelector('h2');
    if (duplicate?.textContent === guide.title) duplicate.remove();
    this.detail.append(body);
    title.focus();
  }

  private backToCatalog(): void {
    this.activeGuide = undefined;
    this.detail!.hidden = true;
    this.catalog!.hidden = false;
    this.updates!.hidden = true;
    if (this.tabs) this.tabs.hidden = false;
    scrollWindowTo(this.savedScroll);
  }

  private async renderUpdates(): Promise<void> {
    if (!this.updates) return;
    this.updates.replaceChildren();
    const head = el('div', '', this.updates); head.className = 'bf-help-detail-head';
    el('h3', this.say('更新动态', 'Updates'), head);
    if (!this.viewedMarked) {
      this.viewedMarked = true;
      void this.ctx.invoke<{ ok: boolean; unread: boolean }>('help_updates_viewed', []).then((result) => {
        this.onUnread(result.unread);
        void this.ctx.refresh();
      }).catch(() => undefined);
    }
    const tabs = el('div', '', this.updates); tabs.className = 'bf-help-subtabs'; tabs.setAttribute('role', 'tablist');
    const announcements = el('button', this.say('开发动态', 'Development feed'), tabs); announcements.type = 'button'; announcements.setAttribute('role', 'tab');
    const releases = el('button', this.say('版本更新', 'Releases'), tabs); releases.type = 'button'; releases.setAttribute('role', 'tab');
    const progress = el('button', this.say('开发进度', 'Development'), tabs); progress.type = 'button'; progress.setAttribute('role', 'tab');
    const body = el('div', '', this.updates);
    const apply = (which: 'announcements' | 'releases' | 'progress'): void => {
      this.updateTab = which;
      announcements.setAttribute('aria-selected', String(which === 'announcements'));
      releases.setAttribute('aria-selected', String(which === 'releases'));
      progress.setAttribute('aria-selected', String(which === 'progress'));
      if (which !== 'announcements') { this.onlineRequest += 1; this.onlineController?.abort(); }
      body.replaceChildren();
      if (which === 'announcements') void this.renderAnnouncements(body, () => apply('releases'));
      else if (which === 'releases') void this.renderReleases(body);
      else void this.renderProgress(body);
    };
    announcements.addEventListener('click', () => apply('announcements'));
    releases.addEventListener('click', () => apply('releases'));
    progress.addEventListener('click', () => apply('progress'));
    apply(this.updateTab);
  }

  private builtInReleaseCard(openReleases: () => void): HTMLElement {
    const card = document.createElement('article'); card.className = 'bf-help-builtin';
    const title = el('h3', this.say('版本更新（内置）', 'Releases (built in)'), card);
    const source = el('span', this.say('安装包内置', 'Bundled'), title); source.className = 'bf-help-source';
    const latest = this.index?.latest;
    if (!latest) {
      el('p', this.say('版本记录暂时没有加载出来。', 'Release notes are unavailable.'), card).className = 'bf-help-empty';
      return card;
    }
    const meta = el('p', '', card); meta.className = 'bf-help-builtin-meta';
    el('span', 'v' + latest.version, meta); el('span', formatDate(latest.releaseDate), meta);
    el('p', latest.summary, card);
    const more = el('button', this.say('查看全部版本更新', 'View all releases'), card); more.type = 'button'; more.className = 'bf-help-jump';
    more.addEventListener('click', openReleases);
    return card;
  }

  private async renderAnnouncements(host: HTMLElement, openReleases: () => void): Promise<void> {
    const request = ++this.onlineRequest;
    this.onlineController?.abort();
    const controller = new AbortController(); this.onlineController = controller;
    host.replaceChildren();
    const builtin = el('div', '', host); builtin.append(this.builtInReleaseCard(openReleases));
    const online = el('div', '', host);
    const head = el('div', '', online); head.className = 'bf-help-online-head';
    el('h4', this.say('开发动态', 'Development feed'), head);
    const actions = el('div', '', head);
    const refresh = el('button', this.say('刷新', 'Refresh'), actions); refresh.type = 'button'; refresh.className = 'bf-help-refresh';
    refresh.addEventListener('click', () => void this.renderAnnouncements(host, openReleases));
    const loading = el('p', this.say('正在获取在线动态…', 'Loading online updates…'), online); loading.className = 'bf-help-empty';
    refresh.disabled = true;
    try {
      const feed = await this.loadOnline(controller.signal);
      if (this.disposed || request !== this.onlineRequest) return;
      refresh.disabled = false;
      if (!feed.announcements.length) {
        loading.textContent = this.say('在线动态暂时没有新内容。', 'There are no online updates right now.');
        return;
      }
      online.replaceChildren();
      const listHead = el('div', '', online); listHead.className = 'bf-help-online-head';
      const listTitle = el('h4', this.say('最新动态', 'Latest updates'), listHead);
      const source = el('span', this.say('GitHub 在线动态', 'Online from GitHub'), listTitle); source.className = 'bf-help-source';
      const meta = el('p', '', online); meta.className = 'bf-help-online-meta';
      el('span', this.say('更新于 ', 'Updated ') + formatTimestamp(feed.updatedAt), meta);
      el('span', this.say(`${feed.announcements.length} 条`, `${feed.announcements.length} item${feed.announcements.length === 1 ? '' : 's'}`), meta);
      const refreshAgain = el('button', this.say('刷新', 'Refresh'), listHead); refreshAgain.type = 'button'; refreshAgain.className = 'bf-help-refresh';
      refreshAgain.addEventListener('click', () => void this.renderAnnouncements(host, openReleases));
      for (const item of feed.announcements) online.append(this.onlineItem(item));
    } catch (error) {
      if (this.disposed || request !== this.onlineRequest) return;
      refresh.disabled = false;
      online.replaceChildren();
      const box = el('div', this.say('在线动态暂不可用，当前显示内置版本更新。', 'Online updates are unavailable; showing bundled release notes instead.'), online);
      box.className = 'bf-help-error';
      el('small', this.say(`原因：${this.onlineErrorReason(error)}。可以稍后点「刷新」重试；版本更新和阅读功能不受影响。`, `Reason: ${this.onlineErrorReason(error)}. Try Refresh later; release notes and reading are unaffected.`), box);
      const retry = el('button', this.say('刷新', 'Refresh'), box); retry.type = 'button'; retry.className = 'bf-help-refresh';
      retry.addEventListener('click', () => void this.renderAnnouncements(host, openReleases));
    }
  }

  private onlineErrorReason(error: unknown): string {
    if (error instanceof AnnouncementsError) {
      if (error.code === 'timeout') return this.say('请求超时', 'request timed out');
      if (error.code === 'http') return this.say('GitHub 返回 HTTP 错误', 'GitHub returned an HTTP error');
      if (error.code === 'invalid-json' || error.code === 'invalid-data' || error.code === 'too-large') return this.say('在线数据格式异常', 'the online data is invalid');
      if (error.code === 'aborted') return this.say('请求被取消', 'the request was cancelled');
    }
    return this.say('无法连接 GitHub', 'GitHub is unreachable');
  }

  private onlineItem(item: OnlineAnnouncement): HTMLElement {
    const card = document.createElement('article'); card.className = 'bf-help-online-item';
    const title = el('h3', item.title, card);
    const labels = ONLINE_CATEGORY_LABEL[item.category];
    const category = el('span', this.say(labels[0], labels[1]), title); category.className = 'bf-help-badge';
    const source = el('span', this.say('在线动态', 'Online'), title); source.className = 'bf-help-source';
    const meta = el('p', '', card); meta.className = 'bf-help-online-meta';
    el('span', formatTimestamp(item.publishedAt), meta);
    el('p', item.content, card).className = 'bf-help-online-content';
    if (item.link) {
      const link = document.createElement('a');
      link.href = item.link; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.textContent = this.say('查看详情', 'Read more');
      card.append(link);
    }
    return card;
  }

  private async loadRelease(version?: string): Promise<HelpReleaseView> {
    const key = version ?? 'current';
    const cached = this.releaseCache.get(key);
    if (cached) return cached;
    const release = await this.ctx.invoke<HelpReleaseView>('help_release', version ? [version] : []);
    this.releaseCache.set(key, release);
    if (release.isCurrent) this.currentRelease = release;
    return release;
  }

  private releaseCard(release: HelpReleaseView, compact = false): HTMLElement {
    const isNew = release.isNew && !this.seenUpdates;
    const card = document.createElement('article'); card.className = 'bf-help-release' + (isNew ? ' is-new' : '');
    const title = el('h3', release.title, card);
    if (isNew) { const badge = el('span', this.say('新', 'New'), title); badge.className = 'bf-help-badge new'; }
    if (release.majorAnnouncement) { const badge = el('span', this.say('重要更新', 'Important'), title); badge.className = 'bf-help-badge'; }
    const meta = el('p', '', card); meta.className = 'bf-help-release-meta';
    el('span', 'v' + release.version, meta); el('span', formatDate(release.releaseDate), meta);
    el('span', release.type === 'major' ? this.say('主要版本', 'Major') : release.type === 'minor' ? this.say('功能更新', 'Feature') : this.say('修复更新', 'Patch'), meta);
    el('p', release.summary, card);
    if (!compact) {
      for (const kind of ['feature', 'improvement', 'fix', 'compatibility', 'note'] as const) {
        const items = release.items.filter((item) => item.kind === kind);
        if (!items.length) continue;
        for (const item of items) {
          const row = el('p', '', card); row.className = 'bf-help-release-item' + (isNew ? ' is-new' : '');
          if (isNew) { const badge = el('span', this.say('新', 'New'), row); badge.className = 'bf-help-badge new'; }
          const labels = KIND_LABEL[kind] ?? [kind, kind];
          el('b', this.say(labels[0], labels[1]) + '：', row);
          row.append(document.createTextNode(item.text));
        }
      }
      if (release.compatibility?.length) {
        const section = el('div', '', card);
        el('h4', this.say('兼容性变化', 'Compatibility'), section);
        const list = el('ul', '', section);
        for (const entry of release.compatibility) el('li', entry, list);
      }
      if (release.technical?.length) {
        const details = document.createElement('details'); card.append(details);
        el('summary', this.say('技术细节', 'Technical details'), details);
        const list = el('ul', '', details);
        for (const entry of release.technical) el('li', entry, list);
      }
    }
    return card;
  }

  private async renderReleases(host: HTMLElement): Promise<void> {
    if (!this.index) { el('p', this.say('更新记录暂时没有加载出来。', 'Release notes are unavailable.'), host).className = 'bf-help-error'; return; }
    let current: HelpReleaseView;
    try { current = await this.loadRelease(); }
    catch (error) {
      el('div', this.say('更新记录暂时打不开：', 'Release notes are unavailable: ') + String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, ''), host).className = 'bf-help-error';
      return;
    }
    if (this.disposed) return;
    host.append(this.releaseCard(current));
    const history = this.index.history;
    if (!history.length) return;
    el('h4', this.say('历史版本', 'Earlier releases'), host);
    const list = el('div', '', host); list.className = 'bf-help-history';
    const detail = el('div', '', host);
    for (const entry of history) {
      const button = document.createElement('button'); button.type = 'button';
      const heading = el('span', 'v' + entry.version + ' · ' + entry.title, button);
      if (entry.isNew && !this.seenUpdates) { const badge = el('span', this.say('新', 'New'), heading); badge.className = 'bf-help-badge new'; }
      el('small', formatDate(entry.releaseDate) + ' · ' + entry.summary, button);
      button.addEventListener('click', () => {
        void (async () => {
          detail.replaceChildren(el('p', this.say('正在加载这个版本…', 'Loading this release…'), detail));
          try {
            const release = await this.loadRelease(entry.version);
            detail.replaceChildren(this.releaseCard(release));
          } catch (error) {
            detail.replaceChildren(el('div', this.say('这个版本暂时打不开。', 'This release is unavailable.'), detail));
          }
        })();
      });
      list.append(button);
    }
  }

  private async renderProgress(host: HTMLElement): Promise<void> {
    if (!this.progress) {
      try { this.progress = await this.ctx.invoke<HelpProgressView>('help_progress', []); }
      catch (error) {
        el('div', this.say('开发进度暂时打不开：', 'Development progress is unavailable: ') + String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, ''), host).className = 'bf-help-error';
        return;
      }
    }
    if (this.disposed) return;
    el('p', this.say('开发进度更新于 ', 'Development progress updated ') + this.progress.updatedAt, host).className = 'bf-help-progress-meta';
    for (const item of this.progress.items) {
      const card = el('article', '', host); card.className = 'bf-help-progress';
      const title = el('h3', item.title, card);
      const labels = STATUS_LABEL[item.status] ?? [item.status, item.status];
      const status = el('span', this.say(labels[0], labels[1]), title);
      status.className = 'bf-help-progress-status'; status.dataset.status = item.status;
      const meta = el('p', '', card); meta.className = 'bf-help-progress-meta';
      el('span', this.say('更新于 ', 'Updated ') + item.updatedAt, meta);
      if (item.scope) el('span', item.scope, meta);
      el('p', item.summary, card);
    }
    el('p', this.say('这里只展示有依据的状态，不使用百分比；没有确定日期的项目不会编造发布日期。', 'Only evidenced states are shown, without percentages or invented release dates.'), host).className = 'bf-help-progress-meta';
  }

  dispose(): void {
    this.disposed = true;
    this.onlineRequest += 1;
    this.onlineController?.abort();
    this.releaseCache.clear();
    this.guideCache.clear();
  }
}

/** Open one guide in the host drawer, preserving the current page and unsaved input. */
export async function openGuideDrawer(ctx: WebUiPanelContext, say: Say, id: string): Promise<void> {
  const body = document.createElement('div');
  body.className = 'bf-help';
  const style = document.createElement('style'); style.textContent = helpStyle; body.append(style);
  const content = document.createElement('div'); body.append(content);
  const drawer = ctx.ui.drawer(say('功能说明', 'Feature guide'), body);
  const show = async (guideId: string): Promise<void> => {
    content.replaceChildren(el('p', say('正在加载说明…', 'Loading guide…'), content));
    try {
      const guide = await ctx.invoke<HelpGuideView>('help_guide', [guideId]);
      content.replaceChildren();
      const head = el('div', '', content); head.className = 'bf-help-detail-head';
      el('h2', guide.title, head);
      if (guide.experimental) { const badge = el('span', say('实验功能', 'Experimental'), head); badge.className = 'bf-help-badge'; }
      el('p', guide.summary, content);
      const body = renderMarkdown(guide.markdown, (next) => void show(next), guide.changed?.snippets ?? []);
      const duplicate = body.querySelector('h2');
      if (duplicate?.textContent === guide.title) duplicate.remove();
      content.append(body);
    } catch (error) {
      content.replaceChildren();
      const box = el('div', say('这项说明暂时打不开。', 'This guide is unavailable right now.'), content); box.className = 'bf-help-error';
      el('small', String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, ''), box);
      const retry = el('button', say('重试', 'Retry'), box); retry.type = 'button';
      retry.addEventListener('click', () => void show(guideId));
    }
  };
  await show(id);
  ctx.own(drawer);
}

export function helpButton(ctx: WebUiPanelContext, say: Say, id: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bf-help-question';
  button.textContent = '?';
  button.title = say('查看说明', 'Open guide');
  button.setAttribute('aria-label', say('查看「', 'Open help for “') + label + say('」的说明', '”'));
  button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void openGuideDrawer(ctx, say, id); });
  return button;
}
