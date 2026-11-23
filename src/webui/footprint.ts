import type { WebUiPanelContext, WebUiMemo } from 'cortico/web/shared/client-panel.ts';
import type { Library } from '../library.ts';
import type { BrowseItem } from '../journal-browse.ts';
import { moodPrefix } from './mood.ts';

type Say = (zh: string, english: string) => string;
type BrowseResult = ReturnType<Library['journalBrowse']>;
type BooksResult = ReturnType<Library['journalBooks']>;
type ProbeResult = ReturnType<Library['journalProbe']>;
type NewResult = ReturnType<Library['journalNew']>;
type Order = 'desc' | 'asc';
type Limit = 5 | 10 | 20 | 50;

const STORAGE_KEY = 'browse-v1';
const STORAGE_VERSION = 1;
const LIMITS: readonly Limit[] = [5, 10, 20, 50];

interface BrowseState {
  v: number;
  scope: string;
  order: Order;
  limit: Limit;
  anchor: number | null;
  scrollTop: number;
  lastPresented: { all: number | null; books: Record<string, number> };
  savedAt: number;
}

export interface FootprintHandle {
  readonly el: HTMLElement;
  activate(): void;
  deactivate(): void;
  selectScope(bookKey: string): void;
  dispose(): void;
}

function defaults(): BrowseState {
  return { v: STORAGE_VERSION, scope: 'all', order: 'desc', limit: 10, anchor: null, scrollTop: 0,
    lastPresented: { all: null, books: {} }, savedAt: 0 };
}
function isOrder(value: unknown): value is Order { return value === 'desc' || value === 'asc'; }
function isLimit(value: unknown): value is Limit { return LIMITS.includes(value as Limit); }
function isCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** Read the persisted browse position; anything unexpected falls back to defaults instead of throwing. */
function loadState(memo: WebUiMemo | undefined): BrowseState {
  const base = defaults();
  try {
    const raw = memo?.get<unknown>(STORAGE_KEY, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const value = raw as Record<string, unknown>;
    if (value.v !== STORAGE_VERSION) return base;
    const scope = typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 150 ? value.scope : 'all';
    const lastPresentedRaw = value.lastPresented as { all?: unknown; books?: unknown } | undefined;
    const books: Record<string, number> = {};
    if (lastPresentedRaw && typeof lastPresentedRaw === 'object' && !Array.isArray(lastPresentedRaw)
      && lastPresentedRaw.books && typeof lastPresentedRaw.books === 'object' && !Array.isArray(lastPresentedRaw.books)) {
      for (const [key, count] of Object.entries(lastPresentedRaw.books as Record<string, unknown>).slice(0, 500)) {
        if (isCounter(count) && key.length > 0 && key.length <= 150) books[key] = count;
      }
    }
    return {
      v: STORAGE_VERSION, scope,
      order: isOrder(value.order) ? value.order : base.order,
      limit: isLimit(value.limit) ? value.limit : base.limit,
      anchor: isCounter(value.anchor) && value.anchor! > 0 ? value.anchor as number : null,
      scrollTop: typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) && value.scrollTop >= 0 ? value.scrollTop : 0,
      lastPresented: { all: isCounter(lastPresentedRaw?.all) ? lastPresentedRaw!.all as number : null, books },
      savedAt: isCounter(value.savedAt) ? value.savedAt : 0,
    };
  } catch { return base; }
}

export function mountFootprint(ctx: WebUiPanelContext, say: Say): FootprintHandle {
  const memo = ctx.memo;
  let state = loadState(memo);
  let books: BooksResult = { total: 0, books: [] };
  let page: BrowseResult | null = null;
  let banner: number | null = null;
  let preview: { items: BrowseItem[]; count: number; maxSequence: number; truncated: boolean } | null = null;
  let active = false, disposed = false, probeBusy = false;
  let epoch = 0;

  const el = (tag: keyof HTMLElementTagNameMap, text = '', parent?: HTMLElement): HTMLElement => {
    const node = document.createElement(tag); if (text) node.textContent = text; parent?.append(node); return node;
  };
  const root = document.createElement('section'); root.className = 'bf-footprint';
  el('h3', say('阅读足迹', 'Reading journal'), root);

  const toolbar = el('div', '', root) as HTMLDivElement; toolbar.className = 'bf-fp-toolbar';
  const searchLabel = el('label', say('搜索书籍', 'Search books'), toolbar) as HTMLLabelElement;
  const search = document.createElement('input'); search.type = 'search';
  search.setAttribute('aria-label', say('搜索书籍', 'Search books'));
  search.placeholder = say('输入书名或作者', 'Title or author'); searchLabel.append(search);
  const bookLabel = el('label', say('书籍', 'Book'), toolbar) as HTMLLabelElement;
  const bookSelect = document.createElement('select');
  bookSelect.setAttribute('aria-label', say('筛选书籍', 'Filter by book')); bookLabel.append(bookSelect);
  const orderLabel = el('label', say('排序', 'Order'), toolbar) as HTMLLabelElement;
  const orderSelect = document.createElement('select'); orderSelect.setAttribute('aria-label', say('足迹排序', 'Footprint order'));
  for (const [value, label] of [['desc', say('最新在前', 'Newest first')], ['asc', say('最早在前', 'Oldest first')]] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; orderSelect.append(option);
  }
  orderSelect.value = state.order; orderLabel.append(orderSelect);
  const limitLabel = el('label', say('每页', 'Per page'), toolbar) as HTMLLabelElement;
  const limitSelect = document.createElement('select'); limitSelect.setAttribute('aria-label', say('每页数量', 'Per page'));
  for (const value of LIMITS) { const option = document.createElement('option'); option.value = String(value); option.textContent = say(`${value} 条`, `${value} per page`); limitSelect.append(option); }
  limitSelect.value = String(state.limit); limitLabel.append(limitSelect);

  const message = el('p', '', root) as HTMLParagraphElement; message.className = 'bf-fp-message';
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');

  const bannerBox = el('div', '', root) as HTMLDivElement; bannerBox.className = 'bf-fp-banner'; bannerBox.hidden = true;
  bannerBox.setAttribute('role', 'status');
  const bannerText = el('span', '', bannerBox) as HTMLSpanElement;
  const bannerOpen = document.createElement('button'); bannerOpen.type = 'button'; bannerOpen.textContent = say('查看新增', 'View new');
  bannerBox.append(bannerOpen);

  const previewBox = el('section', '', root) as HTMLElement; previewBox.className = 'bf-fp-preview'; previewBox.hidden = true;
  previewBox.setAttribute('aria-label', say('本次新增的足迹', 'New footprints in this batch'));
  const previewHead = el('div', '', previewBox) as HTMLDivElement; previewHead.className = 'bf-fp-preview-head';
  const previewTitle = el('strong', '', previewHead) as HTMLElement;
  const previewCollapse = document.createElement('button'); previewCollapse.type = 'button';
  previewCollapse.textContent = say('整体收起', 'Collapse all'); previewHead.append(previewCollapse);
  const previewList = el('div', '', previewBox) as HTMLDivElement; previewList.className = 'bf-fp-preview-list';

  const list = el('div', '', root) as HTMLDivElement; list.className = 'bf-fp-list';
  list.tabIndex = 0; list.setAttribute('role', 'region');
  list.setAttribute('aria-label', say('阅读足迹列表，可上下滚动', 'Footprint list, scrollable'));

  const pager = el('div', '', root) as HTMLElement; pager.className = 'bf-fp-pager';
  pager.setAttribute('role', 'group');
  pager.setAttribute('aria-label', say('足迹分页', 'Footprint pages'));
  const prevButton = document.createElement('button'); prevButton.type = 'button'; prevButton.textContent = say('上一页', 'Previous page');
  const nextButton = document.createElement('button'); nextButton.type = 'button'; nextButton.textContent = say('下一页', 'Next page');
  const latestButton = document.createElement('button'); latestButton.type = 'button'; latestButton.textContent = say('回到最新', 'Back to latest');
  const pagerText = el('span', '', pager) as HTMLSpanElement;
  pager.append(prevButton, pagerText, nextButton, latestButton);

  const detail = el('section', '', root) as HTMLElement; detail.className = 'bf-fp-detail'; detail.hidden = true;
  detail.setAttribute('aria-label', say('足迹详情', 'Footprint detail'));

  function scopeArg(scope = state.scope): string | { bookKey: string } { return scope === 'all' ? 'all' : { bookKey: scope }; }
  function boundary(scope = state.scope): number | undefined {
    const value = scope === 'all' ? state.lastPresented.all : state.lastPresented.books[scope];
    return value === null || value === undefined ? undefined : value;
  }
  function setBoundary(scope: string, sequence: number): void {
    if (scope === 'all') state.lastPresented.all = sequence;
    else state.lastPresented.books[scope] = sequence;
  }
  function save(): void {
    state.savedAt = Date.now();
    try { memo?.set(STORAGE_KEY, state); } catch { /* storage refused: keep the in-memory state */ }
  }
  function setMessage(text: string): void { message.textContent = text; }

  function bookLabelOf(book: BooksResult['books'][number]): string {
    const author = book.author ? ` · ${book.author}` : '';
    const version = book.revision ? ` · v${book.revision.slice(0, 8)}` : '';
    return `${book.title}${author}${version}（${book.count}）`;
  }
  function renderBookOptions(): void {
    const keyword = search.value.trim().normalize('NFKC').toLowerCase();
    const matches = books.books.filter((book) => !keyword
      || book.title.normalize('NFKC').toLowerCase().includes(keyword)
      || (book.author ?? '').normalize('NFKC').toLowerCase().includes(keyword)
      || book.revision.toLowerCase().startsWith(keyword));
    bookSelect.replaceChildren();
    const all = document.createElement('option'); all.value = ''; all.textContent = say(`全部书籍（${books.total}）`, `All books (${books.total})`);
    bookSelect.append(all);
    for (const book of matches) {
      const option = document.createElement('option'); option.value = book.bookKey; option.textContent = bookLabelOf(book); bookSelect.append(option);
    }
    // Keep a selected book visible even when the keyword no longer matches it.
    if (state.scope !== 'all' && !matches.some((book) => book.bookKey === state.scope)) {
      const selected = books.books.find((book) => book.bookKey === state.scope);
      if (selected) {
        const option = document.createElement('option'); option.value = selected.bookKey; option.textContent = bookLabelOf(selected); bookSelect.append(option);
      }
    }
    bookSelect.value = state.scope === 'all' ? '' : state.scope;
    if (keyword && !matches.length) setMessage(say('没有匹配的书籍，换个关键词试试。', 'No matching book; try another keyword.'));
    else if (!books.books.length) setMessage(say('还没有可浏览的阅读足迹。', 'No footprints to browse yet.'));
    else if (message.textContent?.startsWith(say('没有匹配', 'No matching'))) setMessage('');
  }

  function renderBanner(): void {
    bannerBox.hidden = banner === null || preview !== null;
    if (banner !== null) {
      bannerText.textContent = say(`大肥鱼新增了 ${banner} 条足迹`, `New footprints: ${banner}`);
      bannerOpen.textContent = say('查看新增', 'View new');
    }
  }
  function renderPreview(): void {
    previewBox.hidden = preview === null;
    if (!preview) { previewList.replaceChildren(); return; }
    previewTitle.textContent = preview.truncated
      ? say(`本次新增 ${preview.count} 条，显示 ${preview.items.length} 条`, `${preview.count} new; showing ${preview.items.length}`)
      : say(`本次新增 ${preview.count} 条`, `${preview.count} new`);
    previewList.replaceChildren();
    for (const item of preview.items) card(item, previewList);
    if (!preview.items.length) el('p', say('没有可预览的记录。', 'Nothing to preview.'), previewList);
  }

  function card(item: BrowseItem, parent: HTMLElement): HTMLElement {
    const row = document.createElement('article'); row.className = 'bf-fp-card';
    const when = new Date(item.recordedAt);
    const time = el('small', `${when.toLocaleString(ctx.language)} · ${kindLabel(item.kind)}${state.scope === 'all' ? ` · 《${item.bookTitle}》` : ''}`, row);
    time.className = 'bf-fp-meta';
    if (item.chapters.length) el('small', item.chapters.join(' / '), row).className = 'bf-fp-chapter';
    el('p', item.trigger, row).className = 'bf-fp-trigger';
    el('p', moodPrefix(item.mood?.label) + item.interpretation, row).className = 'bf-fp-thought';
    const actions = el('div', '', row) as HTMLDivElement; actions.className = 'bf-fp-actions';
    const discuss = document.createElement('button'); discuss.type = 'button'; discuss.textContent = say('聊聊这一段', 'Discuss this passage');
    discuss.addEventListener('click', () => {
      row.dispatchEvent(new CustomEvent('bookfish-discuss', { bubbles: true, detail: { id: item.id, text: item.interpretation, bookKey: item.bookKey, bookTitle: item.bookTitle } }));
    }, { signal: ctx.signal });
    const evidence = document.createElement('button'); evidence.type = 'button'; evidence.textContent = say('查看原文依据与理由', 'View evidence and explanation');
    evidence.addEventListener('click', () => { void showEpisode(item.id); }, { signal: ctx.signal });
    actions.append(discuss, evidence);
    parent.append(row);
    return row;
  }
  function kindLabel(kind: BrowseItem['kind']): string {
    return kind === 'reading' ? say('阅读当时', 'While reading') : kind === 'reflection' ? say('后来反思', 'Later reflection') : say('后续修订', 'Revision');
  }

  async function showEpisode(id: string): Promise<void> {
    try {
      const record = await ctx.invoke<ReturnType<Library['episode']>>('episode', [id]);
      if (disposed) return;
      detail.replaceChildren(); detail.hidden = false;
      el('h3', say('原文依据与理由', 'Evidence and explanation'), detail);
      for (const quote of record.evidence) {
        const block = document.createElement('blockquote'); block.textContent = quote.quote; detail.append(block);
        el('small', `${quote.chapter} · 段落 ${quote.segmentId}`, detail);
      }
      el('p', record.episode.content.reason ?? say('未记录当时理由。', 'No reason recorded.'), detail);
      if (record.revisions.length) {
        el('small', say('后续修订：', 'Later revisions: ') + record.revisions.map((revision) => new Date(revision.recordedAt).toLocaleString(ctx.language)).join(' · '), detail);
      }
      detail.scrollIntoView?.({ block: 'nearest' });
    } catch (error) { setMessage(String(error)); }
  }

  function renderList(restoreScroll = false): void {
    list.replaceChildren();
    if (!page) { el('p', say('正在载入阅读足迹…', 'Loading footprints…'), list); return; }
    if (!page.items.length) {
      el('p', say('当前筛选范围没有可显示的阅读足迹。', 'No footprints in this range.'), list);
    } else {
      for (const item of page.items) card(item, list);
    }
    const start = page.position.start, total = page.total, limit = page.limit;
    pagerText.textContent = total === 0
      ? say('共 0 条', '0 records')
      : say(`第 ${Math.floor((Math.max(start, 1) - 1) / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))} 页 · 共 ${total} 条`,
        `Page ${Math.floor((Math.max(start, 1) - 1) / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))} · ${total} records`);
    prevButton.disabled = !page.hasPrev;
    nextButton.disabled = !page.hasNext;
    latestButton.disabled = !page.items.length;
    if (restoreScroll) list.scrollTop = state.scrollTop;
    else list.scrollTop = 0;
  }

  async function browse(filters: { cursor?: BrowseResult['nextCursor']; anchor?: number | null } = {}, restoreScroll = false): Promise<void> {
    const ticket = ++epoch;
    const usedAnchor = filters.anchor !== undefined && filters.anchor !== null;
    try {
      const args: Record<string, unknown> = { scope: scopeArg(), order: state.order, limit: state.limit };
      if (filters.cursor) args.cursor = filters.cursor;
      else if (usedAnchor) args.anchorSequence = filters.anchor;
      const result = await ctx.invoke<BrowseResult>('journal_browse', [args]);
      if (disposed || ticket !== epoch) return;
      if (usedAnchor && result.items.length === 0 && result.total > 0) {
        // The anchored record is gone and no older neighbour exists; show the first page instead.
        await browse({}, restoreScroll);
        return;
      }
      page = result;
      state.anchor = result.page.firstSequence;
      save();
      renderList(restoreScroll);
      setMessage('');
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if (usedAnchor) { await browse({}, restoreScroll); return; }
      page = null; renderList(false);
      setMessage(String(error));
    }
  }

  async function refreshBooks(): Promise<void> {
    try {
      const result = await ctx.invoke<BooksResult>('journal_books', []);
      if (disposed) return;
      books = result;
      if (state.scope !== 'all' && !result.books.some((book) => book.bookKey === state.scope)) {
        state.scope = 'all'; state.anchor = null; save();
      }
      renderBookOptions();
    } catch { /* the next activation retries */ }
  }

  async function probe(): Promise<void> {
    if (!active || disposed || probeBusy || preview !== null) return;
    probeBusy = true;
    const scope = state.scope;
    try {
      const since = boundary(scope);
      const result = await ctx.invoke<ProbeResult>('journal_probe', [{ scope: scopeArg(scope), since: since ?? null }]);
      if (disposed || !active || scope !== state.scope) return;
      if (since === undefined) {
        setBoundary(scope, result.headSequence ?? 0); save(); banner = null;
      } else {
        banner = result.count > 0 ? result.count : null;
        if (banner !== null) void refreshBooks();
      }
      renderBanner();
    } catch { /* a probe failure never advances the boundary and retries next tick */ }
    finally { probeBusy = false; }
  }

  async function openPreview(): Promise<void> {
    const scope = state.scope;
    const since = boundary(scope);
    if (since === undefined) return;
    try {
      const result = await ctx.invoke<NewResult>('journal_new', [{ scope: scopeArg(scope), since, order: state.order, limit: state.limit }]);
      if (disposed || scope !== state.scope) return;
      preview = { items: result.items, count: result.count, maxSequence: result.maxSequence ?? since, truncated: result.truncated };
      banner = null;
      renderPreview(); renderBanner();
    } catch (error) { setMessage(String(error)); }
  }
  function collapsePreview(): void {
    if (!preview) return;
    setBoundary(state.scope, preview.maxSequence); save();
    preview = null; renderPreview(); renderBanner(); setMessage('');
    void probe();
  }

  // ---- events -------------------------------------------------------------
  search.addEventListener('input', () => { renderBookOptions(); }, { signal: ctx.signal });
  bookSelect.addEventListener('change', () => {
    const value = bookSelect.value;
    state.scope = value === '' ? 'all' : value;
    state.anchor = null; preview = null; banner = null;
    renderPreview(); renderBanner(); save();
    void browse();
    void probe();
  }, { signal: ctx.signal });
  orderSelect.addEventListener('change', () => {
    state.order = orderSelect.value === 'asc' ? 'asc' : 'desc';
    const anchor = page?.page.firstSequence ?? state.anchor;
    preview = null; renderPreview(); save();
    void browse({ anchor });
  }, { signal: ctx.signal });
  limitSelect.addEventListener('change', () => {
    const value = Number(limitSelect.value);
    if (!isLimit(value)) return;
    state.limit = value;
    const anchor = page?.page.firstSequence ?? state.anchor;
    preview = null; renderPreview(); save();
    void browse({ anchor });
  }, { signal: ctx.signal });
  bannerOpen.addEventListener('click', () => { void openPreview(); }, { signal: ctx.signal });
  previewCollapse.addEventListener('click', collapsePreview, { signal: ctx.signal });
  prevButton.addEventListener('click', () => { if (page?.prevCursor) void browse({ cursor: page.prevCursor }); }, { signal: ctx.signal });
  nextButton.addEventListener('click', () => { if (page?.nextCursor) void browse({ cursor: page.nextCursor }); }, { signal: ctx.signal });
  latestButton.addEventListener('click', () => { if (page) void browse({ anchor: page.headSequence }); }, { signal: ctx.signal });
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  list.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { if (disposed) return; state.scrollTop = list.scrollTop; save(); }, 250);
  }, { signal: ctx.signal });
  const flush = () => { state.scrollTop = list.scrollTop; save(); };
  globalThis.addEventListener?.('pagehide', flush, { signal: ctx.signal });

  // The lightweight probe shares the existing 2s cadence and only runs while trail is visible.
  ctx.interval(() => { if (active && preview === null) void probe(); }, 2000);

  return {
    el: root,
    activate() {
      if (disposed || active) return;
      active = true;
      void (async () => {
        await refreshBooks();
        if (disposed || !active) return;
        await browse(state.anchor === null ? {} : { anchor: state.anchor }, true);
        await probe();
      })();
    },
    deactivate() {
      active = false;
      flush();
    },
    selectScope(bookKey: string) {
      state.scope = bookKey; state.anchor = null; preview = null; banner = null;
      save(); renderPreview(); renderBanner();
      if (!active) { active = true; }
      void (async () => { await refreshBooks(); bookSelect.value = bookKey; await browse(); await probe(); })();
    },
    dispose() { disposed = true; active = false; if (scrollTimer) clearTimeout(scrollTimer); flush(); },
  };
}
