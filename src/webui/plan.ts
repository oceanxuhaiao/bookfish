/**
 * WebUI: the single reading plan page.
 *
 * Two rules shape this page. Order is presentation only — moving a row never
 * touches text, progress, journal, review or story memory. And the book being
 * read is locked: it can only leave by an explicit "stop reading this one",
 * which is a different promise from skipping, removing or finishing.
 */
import type { LibraryPanelState } from '../status.ts';
import {coverDesign} from './cover.ts';

type PlanView = NonNullable<LibraryPanelState['plan']>;
type PlanItem = PlanView['items'][number];
type Say = (zh: string, english: string) => string;

export interface PlanPageOptions {
  page: HTMLElement;
  say: Say;
  state: LibraryPanelState;
  invoke (method: string, args?: unknown[]): Promise<unknown>;
  confirm (options: { title: string; body: string; danger?: boolean }): Promise<boolean>;
  /** Re-read the panel state after a write. */
  refresh (): Promise<void>;
  onAdd?(): void;
}

const SOURCE_LABEL = { user: ['你加的', 'added by you'], persona: ['她自己想读的', 'her own pick'] } as const;

export function renderPlanPage(options: PlanPageOptions): void {
  const { page, say, state, invoke, confirm, refresh } = options;
  const expanded=new Set([...page.querySelectorAll<HTMLDetailsElement>('details[data-key][open]')].map(node=>node.dataset.key));
  const scroll=page.parentElement?.parentElement?.scrollTop;
  page.replaceChildren();
  // Not mounted yet: the panel has no plan to show and must not invent one.
  if (!state.plan) return;
  const plan = state.plan;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent: HTMLElement = page) => {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  // Failures are shown, never swallowed: a silent no-op looks like a broken page.
  const failure = document.createElement('p'); failure.className = 'plan-error'; failure.hidden = true;
  page.append(failure);
  const report = (error: unknown): void => {
    failure.textContent = String((error as Error)?.message ?? error);
    failure.hidden = false;
  };
  const act = (label: string, parent: HTMLElement, run: () => Promise<void>, hint?: string): HTMLButtonElement => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    if (hint) node.title = hint;
    node.addEventListener('click', () => {
      failure.hidden = true;
      void run().catch(report);
    });
    parent.append(node); return node;
  };
  const write = async (payload: Record<string, unknown>): Promise<void> => {
    await invoke('plan_update', [payload]);
    await refresh();
  };

  const toolbar=el('div','');toolbar.className='order-toolbar';
  el('span',say(`等待阅读 ${plan.items.filter(item=>!item.active).length} 本`,`Waiting: ${plan.items.filter(item=>!item.active).length}`),toolbar);
  act(say('＋ 添加书籍','＋ Add books'),toolbar,async()=>options.onAdd?.());
  // An empty plan is only "empty" when nothing is being read either; a current
  // book outside the plan still has to be shown.
  if (!plan.total && !plan.reading) {
    el('p', say('还没有安排后续书籍。从书架添加，或导入后选择加入阅读顺序。',
      'The plan is empty and nothing is being read. Open a book in the bookshelf and add it to the plan.'), page);
    return;
  }

  const historyDetails=el('details','');historyDetails.dataset.key='history';el('summary',say('最近变动与统计','Recent changes and totals'),historyDetails);
  const summary = el('p', '', historyDetails); summary.className = 'plan-summary';
  // A legacy plan cannot recover history its old version already trimmed, so its
  // counters are a verified lower bound; saying "累计 N 本" there would claim a
  // completeness the data cannot support.
  const complete = plan.statsComplete !== false;
  summary.textContent = say(
    `计划 ${plan.total} 本 · ` + (complete ? `累计读完 ${plan.completedCount} 本` : `至少累计读完 ${plan.completedCount} 本`) +
      (plan.series.length ? ` · ${plan.series.length} 个系列` : ''),
    `${plan.total} planned · ` + (complete ? `${plan.completedCount} finished in total` : `at least ${plan.completedCount} finished in total`) +
      (plan.series.length ? ` · ${plan.series.length} series` : ''));
  const historyNote = el('small', '', historyDetails);
  historyNote.className = 'plan-note plan-history';
  historyNote.textContent = say(
    `历史只保留最近 ${plan.archiveLimit} 条（当前 ${plan.archiveKept} 条）` +
      (plan.truncatedCount ? `，更早的 ${plan.truncatedCount} 条已不再列出，但累计数量仍然计入` : '') +
      `；跳过 ${plan.skippedCount} 本、移出 ${plan.removedCount} 本。` +
      (complete ? '' : '此计划由旧版本迁移而来，更早的完读历史可能已超出保留窗口，以上累计数字是可确认的下界，不是完整总数。'),
    `History keeps the latest ${plan.archiveLimit} entries (now ${plan.archiveKept})` +
      (plan.truncatedCount ? `; ${plan.truncatedCount} older entries are no longer listed but still counted` : '') +
      `; ${plan.skippedCount} skipped, ${plan.removedCount} removed in total.` +
      (complete ? '' : ' This plan was migrated from an older version whose older history may be beyond the retention window; the totals above are a confirmed lower bound, not the full history.'));

  const toggleRow = el('div', '', page); toggleRow.className = 'plan-toggle';
  const enabled = document.createElement('button'); enabled.type = 'button';
  enabled.textContent = plan.enabled ? say('读完后按顺序继续：已开启', 'Continue in order after finishing: on') : say('读完后按顺序继续：已关闭', 'Continue in order after finishing: off');
  enabled.setAttribute('aria-pressed', String(plan.enabled));
  enabled.addEventListener('click', () => { void write({ action: 'enable', enabled: !plan.enabled }).catch(report); });
  toggleRow.append(enabled);
  el('small', say('关掉只影响“自动按计划接着读”，不会改动计划本身。', 'Turning this off only stops automatic plan following; the plan itself is untouched.'), toggleRow).className = 'plan-note';

  const currentCard = el('section', '', page); currentCard.className = 'card plan-current';
  el('h3', say('正在读', 'Reading now'), currentCard);
  const current = plan.current;
  const reading = plan.reading;
  if (reading) {
    const head = el('p', '', currentCard); head.className = 'plan-current-head';
    el('strong', `《${reading.title}》`, head);
    const badge = el('span', '', head); badge.className = 'plan-badge' + (reading.inPlan ? ' is-active' : '');
    badge.textContent = reading.inPlan
      ? say(`第 ${current?.position ?? 1} / ${plan.total} 位 · 已读 ${Math.round(reading.progress * 100)}%`,
        `#${current?.position ?? 1} of ${plan.total} · ${Math.round(reading.progress * 100)}% read`)
      : say(`计划外 · 已读 ${Math.round(reading.progress * 100)}%`, `outside the plan · ${Math.round(reading.progress * 100)}% read`);
    el('small', reading.inPlan
      ? say(`进度按${reading.progressUnit === 'chapters' ? '章节' : '字符'}计算。这本书读完之前不会被重排挤掉。`,
        `Progress is counted in ${reading.progressUnit === 'chapters' ? 'chapters' : 'characters'}. It cannot be displaced by a reorder before it is finished.`)
      : say('这本书正在读，但不在阅读计划里：它不计入计划本数，也不会挤掉计划里的下一本。',
        'This book is being read but is not in the plan: it does not count towards the plan, and it does not displace the next planned book.'),
    currentCard).className = 'plan-note';
    if (!reading.inPlan) {
      el('small', `《${reading.title}》${reading.chapter ? ' · ' + reading.chapter : ''}`, currentCard).className = 'plan-note';
      act(say('把这本书加入阅读顺序', 'Add this book to the plan'), currentCard, async () => {
        await invoke('plan_add', [{ bookKeys: [reading.bookKey] }]);
        await refresh();
      });
    }
    const meter=el('progress','',currentCard);meter.max=1;meter.value=reading.progress;meter.setAttribute('aria-label',say('已确认阅读进度','Confirmed reading progress'));
    const currentMenu=el('details','',currentCard);currentMenu.className='order-more';currentMenu.dataset.key='current';el('summary',say('更多操作','More actions'),currentMenu);
    if (reading.inPlan && current) {
      // Two distinct promises: hand over to the next book, or leave the playlist
      // and keep reading this one. Both keep the text and the progress.
      const readable = plan.items.filter((item) => !item.active && !item.complete && item.present
        && !(item.notBefore !== undefined && item.notBefore > Date.now()));
      const stop = act(say('停止读这本，改读下一本', 'Stop this one and read the next'), currentMenu, async () => {
        const ok = await confirm({ title: say('停止读这本书？', 'Stop reading this book?'), danger: true,
          body: say('它会从计划移到“已停止”，进度、手账和读后感都保留；不算读完，也不会删除书架上的原件。',
            'It moves to “stopped”. Progress, journal and reviews are kept; it is not marked finished and the shelf copy is not deleted.') });
        if (!ok) return;
        await write({ action: 'remove', itemId: current.id, status: 'skipped', stop: true, reason: 'stopped_by_user_in_panel' });
      }, say('这不是跳过，是明确结束当前这本的阅读', 'This is not skipping: it explicitly ends reading this book'));
      stop.className = 'plan-stop';
      if (!readable.length) {
        // Refusing is the honest answer; say why instead of failing silently.
        stop.disabled = true;
        el('small', say('没有其他可读的下一本，所以不能“换下一本”。如果你只想让它离开计划但仍继续读这本，用下面的按钮。',
          'There is no other readable book to hand over to. If you only want it out of the plan while still reading it, use the button below.'), currentMenu).className = 'plan-note';
      }
      act(say('移出阅读顺序，继续读这本', 'Remove from the plan, keep reading this'), currentMenu, async () => {
        const ok = await confirm({ title: say('移出阅读顺序但继续读？', 'Remove from the plan but keep reading?'),
          body: say('它不再排在计划里，但仍然是当前在读的书，进度和手账都保留。',
            'It leaves the playlist but stays the current book; progress and journal are kept.') });
        if (!ok) return;
        await write({ action: 'remove', itemId: current.id, status: 'removed', keepReading: true, reason: 'removed_but_still_reading' });
      }, say('不切换书，只把它移出阅读顺序', 'No switch: it only leaves the playlist'));
    }
  } else if (current) {
    // Plan says an item is active but nothing is selected: show the entry, not a lie.
    const head = el('p', '', currentCard); head.className = 'plan-current-head';
    el('strong', `《${current.title}》`, head);
    el('span', say(`第 ${current.position} / ${plan.total} 位`, `#${current.position} of ${plan.total}`), head).className = 'plan-badge';
    el('small', say('这本书在计划里排到了，但还没有被选中阅读。', 'This entry is next in the plan but has not been selected yet.'), currentCard).className = 'plan-note';
  } else {
    el('p', say('现在没有在读的书。计划里的第一本会在你选一本书，或她按计划开始读时生效。',
      'No book is being read right now. The first planned book takes effect when you pick one or she starts following the plan.'), currentCard);
  }

  const renderSeriesBlock = (): void => {
    if (!plan.series.length) return;
    const box = el('div', '', seriesManager); box.className = 'plan-series';
    el('h3', say('系列分组', 'Series'), box);
    el('small', say('分组只是组织方式，不会另外排一套阅读顺序；整组移动时组内顺序保持不变。',
      'A series only organises rows; it never creates a second schedule, and moving a group keeps its inner order.'), box).className = 'plan-note';
    for (const series of plan.series) {
      const group = document.createElement('details'); group.className = 'plan-series-group';
      const head = document.createElement('summary');
      head.textContent = `${series.name} · ${series.count}`;
      group.dataset.key=series.id;group.append(head); box.append(group);
      const members = plan.items.filter((item) => item.seriesId === series.id);
      for (const member of members) {
        const row = el('p', '', group); row.className = 'plan-series-member';
        el('span', `${member.position}. 《${member.title}》`, row);
        if (member.active) el('small', say('正在读', 'Reading'), row).className = 'plan-badge is-active';
        const order = el('span', '', row); order.className = 'plan-actions';
        // Inner order is just plan order, so it moves with the same rule: no
        // member may be placed above the book being read.
        if (!member.active && member.position > (plan.current ? plan.current.position + 1 : 1)) {
          act(say('上移', 'Up'), order, async () => write({ action: 'move', itemId: member.id, to: member.position - 1 }));
        }
        if (!member.active && member.position < plan.total) {
          act(say('下移', 'Down'), order, async () => write({ action: 'move', itemId: member.id, to: member.position + 1 }));
        }
        act(say('移出本系列', 'Remove from series'), order, async () => {
          await invoke('plan_series', [{ action: 'assign', seriesId: null, itemIds: [member.id] }]);
          await refresh();
        });
      }
      const renameRow = el('div', '', group); renameRow.className = 'plan-actions';
      const renameField = document.createElement('input'); renameField.type = 'text'; renameField.value = series.name;
      renameField.setAttribute('aria-label', say('系列名称', 'Series name'));
      renameRow.append(renameField);
      act(say('重命名', 'Rename'), renameRow, async () => {
        const name = renameField.value.trim();
        if (!name || name === series.name) return;
        await invoke('plan_series', [{ action: 'rename', seriesId: series.id, name }]);
        await refresh();
      });
      const actions = el('div', '', group); actions.className = 'plan-actions';
      if (members.length && !members.some(member=>member.active)) {
        const moveGroup=async(to:number)=>{
          const rest=plan.items.filter(item=>item.seriesId!==series.id);
          const at=Math.max(plan.current?rest.findIndex(item=>item.active)+1:0,Math.min(rest.length,to-1));
          const preview=[...rest.slice(0,at),...members,...rest.slice(at)];
          if(!await confirm({title:say('确认整组移动后的顺序','Confirm the new reading order'),body:preview.map((item,index)=>`${index+1}. ${item.title}`).join('\n')}))return;
          await write({action:'move_series',seriesId:series.id,to});
        };
        const first = Math.min(...members.map((member) => member.position));
        const last = Math.max(...members.map((member) => member.position));
        if (first > (plan.current?.position??0)+1) act(say('整组上移', 'Move group up'), actions, async () => moveGroup(first-1));
        if (last < plan.total) act(say('整组下移', 'Move group down'), actions, async () => moveGroup(last+1));
      }
      act(say('解散分组', 'Ungroup'), actions, async () => {
        const ok = await confirm({ title: say('解散这个分组？', 'Ungroup this series?'),
          body: say('只取消分组，书的顺序和进度都不变。', 'Only the grouping is removed; order and progress stay.') });
        if (!ok) return;
        await invoke('plan_series', [{ action: 'delete', seriesId: series.id }]);
        await refresh();
      });
    }
  };

  /**
   * Grouping proposals are proposals. Adopting one creates a series with the
   * rows the user picked; nothing is merged automatically, and an ambiguous
   * proposal says so before it is adopted.
   */
  const renderSuggestions = (): void => {
    const card = el('section', '', seriesManager); card.className = 'plan-suggest';
    el('h3', say('系列建议', 'Grouping proposals'), card);
    const box = el('div', '', card); box.className = 'plan-suggestions';
    const load = async (): Promise<void> => {
      box.replaceChildren();
      const result = await invoke('plan_suggest', []) as { suggestions: { key: string; name: string; bookKeys: string[]; evidence: string; ambiguous: boolean }[] };
      const known = plan.items;
      const usable = result.suggestions
        .map((row) => ({ ...row, itemIds: row.bookKeys.flatMap((key: string) => known.filter((item) => item.bookKey === key).map((item) => item.id)) }))
        .filter((row) => row.itemIds.length > 1 && !known.some((item) => item.seriesId && plan.series.find((group) => group.id === item.seriesId)?.name === row.name));
      if (!usable.length) return;
      el('small', say('自动识别只提供建议，确认后才会建立分组。', 'Automatic detection only proposes; a series is created after you confirm.'), box).className = 'plan-note';
      for (const row of usable) {
        const line = el('div', '', box); line.className = 'plan-suggestion';
        el('span', `${row.name}（${row.itemIds.length} 本，${row.evidence === 'folder' ? '同文件夹' : row.evidence === 'title' ? '同书名' : '同文件名'}${row.ambiguous ? '，可能是同一本拆开' : ''}）`, line);
        act(say('采用建议', 'Use this grouping'), line, async () => {
          await invoke('plan_series', [{ action: 'create', name: row.name, itemIds: row.itemIds }]);
          await refresh();
        });
      }
    };
    act(say('看分组建议', 'Suggest groupings'), box, load);
  };

  const renderOrderBlock = (): void => {
    const list = el('section', '', page); list.className = 'card plan-order';
    el('h3', say('接下来读', 'Next to read'), list);
    el('small',say('拖动调整顺序，也可在更多操作中上下移动。','Drag to reorder, or use Move up/down in More actions.'),list);
    if (!plan.items.some(item=>!item.active)) {
      el('p', say('计划里还没有等待阅读的书。', 'No book is waiting in the plan.'), list);
      return;
    }
    let dragged:string|null=null;
    plan.items.filter(item=>!item.active).forEach((item: PlanItem) => {
      const card = el('article', '', list); card.className = 'plan-item' + (item.active ? ' is-active' : '');
      card.dataset.itemId=item.id;
      const grip=el('span','⋮⋮',card);grip.className='order-grip';grip.draggable=true;grip.title=say('拖动调整顺序','Drag to reorder');grip.setAttribute('aria-hidden','true');
      grip.addEventListener('dragstart',event=>{dragged=item.id;event.dataTransfer?.setData('text/plain',item.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
      grip.addEventListener('dragend',()=>{dragged=null;list.querySelectorAll('.is-drop').forEach(node=>node.classList.remove('is-drop'));});
      card.addEventListener('dragover',event=>{if(dragged&&dragged!==item.id){event.preventDefault();card.classList.add('is-drop');}});
      card.addEventListener('dragleave',()=>card.classList.remove('is-drop'));
      card.addEventListener('drop',event=>{event.preventDefault();card.classList.remove('is-drop');const id=dragged;dragged=null;if(id&&id!==item.id)void write({action:'move',itemId:id,to:item.position}).catch(report);});
      const head = el('div', '', card); head.className = 'plan-item-head';
      const design=coverDesign({key:item.bookKey,title:item.title,author:item.author});
      const cover=el('span','',card);cover.className='book-cover order-cover';cover.dataset.palette=String(design.palette);cover.setAttribute('aria-hidden','true');el('span',Array.from(item.title).slice(0,8).join(''),cover).className='cover-title';
      el('strong', `${item.position}. 《${item.title}》`, head);
      const deferred = item.notBefore !== undefined && item.notBefore > Date.now();
      if (item.active) el('span', say('正在读', 'Reading'), head).className = 'plan-badge is-active';
      else if (item.complete) el('span', say('已读完，等待换书', 'Finished; hand-off pending'), head).className = 'plan-badge';
      else if (deferred) el('span', say('已暂缓', 'Deferred'), head).className = 'plan-badge';
      else if (!item.present) el('span', say('书架已删除', 'Not on the shelf'), head).className = 'plan-badge is-error';
      const meta: string[] = [];
      if (item.author) meta.push(item.author);
      if (item.seriesName) meta.push(say(`系列：${item.seriesName}`, `Series: ${item.seriesName}`));
      meta.push(SOURCE_LABEL[item.source][0]);
      meta.push(say(`已读 ${Math.round(item.progress * 100)}%`, `${Math.round(item.progress * 100)}% read`));
      if (item.chapter) meta.push(item.chapter);
      el('small', meta.join(' · '), card).className = 'plan-meta';
      if (deferred) el('small', say(`最早 ${new Date(item.notBefore!).toLocaleString()} 之后才排到`, `Not before ${new Date(item.notBefore!).toLocaleString()}`), card).className = 'plan-note';

      // The book being read stays put: only an explicit stop can move it out.
      if (item.active) return;

      const quick=el('div','',card);quick.className='order-quick';
      act(say('设为下一本','Read next'),quick,async()=>write({action:'place',itemId:item.id,place:'next'}));
      const more=el('details','',quick);more.className='order-more';more.dataset.key=item.id;el('summary','···',more).setAttribute('aria-label',say('书籍操作：','Book actions: ')+item.title);
      const row = el('div', '', more); row.className = 'plan-actions';
      // Series membership is a per-row decision; creating one happens inline so
      // the user never has to leave the page to organise a playlist.
      const selector = document.createElement('select');
      selector.setAttribute('aria-label', say('这本书的系列', 'Series for this book'));
      const none = document.createElement('option'); none.value = ''; none.textContent = say('不分组', 'No series'); selector.append(none);
      for (const group of plan.series) {
        const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; selector.append(option);
      }
      const create = document.createElement('option'); create.value = '__new'; create.textContent = say('新建系列…', 'New series…'); selector.append(create);
      selector.value = item.seriesId ?? '';
      selector.addEventListener('change', () => {
        void (async () => {
          if (selector.value === '__new') {
            const name = window.prompt(say('新系列名称', 'New series name'), item.title.slice(0, 20));
            if (!name?.trim()) { selector.value = item.seriesId ?? ''; return; }
            await invoke('plan_series', [{ action: 'create', name: name.trim(), itemIds: [item.id] }]);
            await refresh();
            return;
          }
          await invoke('plan_series', [{ action: 'assign', seriesId: selector.value || null, itemIds: [item.id] }]);
          await refresh();
        })().catch(report);
      });
      row.append(selector);
      if (!item.present) el('small', say('原件已从书架删除，这一条不会再推进；可以移除它。', 'The revision is gone from the shelf, so this entry cannot advance. You can remove it.'), row).className = 'plan-note';
      // Nothing may be placed before the book being read, so "up" only exists
      // below that fixed head.
      const lockedHead = plan.current ? plan.current.position : 0;
      if (item.position > lockedHead + 1) act(say('上移一位', 'Move up'), row, async () => write({ action: 'move', itemId: item.id, to: item.position - 1 }));
      if(item.position<plan.total)act(say('下移一位','Move down'),row,async()=>write({action:'move',itemId:item.id,to:item.position+1}));
      act(say('移到最后', 'Move to end'), row, async () => write({ action: 'place', itemId: item.id, place: 'bottom' }));
      act(say('暂时跳过', 'Skip for now'), row, async () => {
        const ok = await confirm({ title: say('暂时跳过这本？', 'Skip this book for now?'),
          body: say('跳过不等于读完：进度和手账都保留，之后还可以再加回计划。', 'Skipping is not finishing: progress and journal stay, and you can add it back later.') });
        if (!ok) return;
        await write({ action: 'remove', itemId: item.id, status: 'skipped', reason: 'skipped_in_panel' });
      });
      act(say('移出阅读顺序', 'Remove from plan'), row, async () => {
        const ok = await confirm({ title: say('把这本移出阅读顺序？', 'Remove this book from the plan?'), danger: true,
          body: say('只改计划，不删除书架上的书，也不清空已经读过的进度。', 'This only changes the plan; the book and its progress stay.') });
        if (!ok) return;
        await write({ action: 'remove', itemId: item.id, status: 'removed', reason: 'removed_in_panel' });
      });
    });
  };

  renderOrderBlock();
  const seriesManager=el('details','');seriesManager.className='order-series-manager';seriesManager.dataset.key='series';el('summary',say('管理系列','Manage series'),seriesManager);
  renderSeriesBlock();renderSuggestions();
  page.append(historyDetails);
  for(const node of page.querySelectorAll<HTMLDetailsElement>('details[data-key]'))node.open=expanded.has(node.dataset.key);
  if(scroll!==undefined&&page.parentElement?.parentElement)page.parentElement.parentElement.scrollTop=scroll;

  const archive = plan.archive.slice(0, 10);
  if (!archive.length) return;
  const box = document.createElement('div'); box.className = 'plan-archive';
  const title = document.createElement('h4');
  title.textContent = say(`最近的计划变动（${archive.length} 条）`, `Recent plan changes (${archive.length})`);
  box.append(title); historyDetails.append(box);
  for (const entry of archive) {
    const row = el('div', '', box); row.className = 'plan-archive-row';
    const status = entry.status === 'completed' ? say('已读完', 'Finished') : entry.status === 'skipped' ? say('已跳过', 'Skipped') : say('已移除', 'Removed');
    el('span', `《${entry.title}》`, row);
    el('small', status + (entry.reason ? ` · ${archiveReason(entry.reason, say)}` : ''), row);
  }
}

function archiveReason(reason: string, say: Say): string {
  switch (reason) {
    case 'skipped_by_user': case 'skipped_in_panel': return say('你选择暂时跳过', 'you skipped it');
    case 'removed_by_user': case 'removed_in_panel': return say('你移出了计划', 'you removed it');
    case 'stopped_by_user_in_panel': return say('你明确停止了这本', 'you stopped it');
    case 'book_removed': return say('书架上的原件已删除', 'the shelf copy was deleted');
    case 'legacy_cancelled': return say('历史记录里的取消', 'cancelled in an older version');
    case 'cancelled_after_import': return say('导入后取消', 'cancelled after import');
    case 'self_selected_abandoned': case 'self_selected_cancelled': return say('放弃了她自选的书', 'her own pick was abandoned');
    default: return reason;
  }
}
