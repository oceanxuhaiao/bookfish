import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { BOOKFISH_DEFAULTS, type BookfishConfigSection } from './config.ts';
import { BOOKFISH_TOOL_DECLS } from './tool-schemas.ts';
import { BookfishWorld } from './world.ts';
export const BOOKFISH: WorldDefinition<BookfishConfigSection> = {
  id: 'bookfish', label: '看书吧！大肥鱼', defaults: () => ({ ...BOOKFISH_DEFAULTS }),
  create: (ctx) => new BookfishWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir, persist:patch=>ctx.persist(patch) }),
  describe: {
    tools: describeTools(BOOKFISH_TOOL_DECLS, {
      bookfish_get_status: { zh: '查询阅读进度、暂停状态、预算、分享摘要与等待原因。', en: 'Reports progress, pause, budgets, sharing summary and waiting reasons.' },
      bookfish_list_books: { zh: '列出已导入书籍的版本与进度。', en: 'Lists imported revisions and progress.' },
      bookfish_select_book: { zh: '选择书籍版本，保留各版本的阅读进度。', en: 'Selects a revision while preserving progress.' },
      bookfish_read_next: { zh: '获取下一段正文，创建待确认任务，不增加已读进度。', en: 'Provides the next segment without advancing confirmed progress.' },
      bookfish_finish_reading: { zh: '确认已提供的段落，可附证据手账；重复提交不重复计数。', en: 'Confirms a provided range with an optional evidence-backed episode; idempotent retries.' },
      bookfish_set_paused: { zh: '暂停或继续，取消未完成任务。', en: 'Pauses or resumes and invalidates pending tasks.' },
      bookfish_lookup: { zh: '回查已读原文、手账、感想与修订；不改变进度，不返回未读正文。', en: 'Looks up confirmed text, journal, episodes and revisions without advancing progress or returning unread text.' },
      bookfish_record_reflection: { zh: '追加现在的反思或修订，保留原判断和时间。', en: 'Appends a present-day reflection or revision while preserving the original and its time.' },
      bookfish_defer_reading: { zh: '延后本次机会或休息，保留已确认进度。', en: 'Defers this opportunity or takes a rest without losing confirmed progress.' },
      bookfish_acquire: { zh: '解析链接、自主搜索、按候选获取、读取摘要或安排阅读队列。', en: 'Resolves a source, searches, acquires a candidate, reads a summary or plans the reading queue.' },
      bookfish_share: { zh: '提名、分页查询、放弃分享候选，或登记实际输出回执。', en: 'Nominates, pages, drops a sharing candidate, or records the actual output receipt.' },
      bookfish_claim_share: { zh: '校验机会后预留一次分享尝试，过期或拒绝不得输出。', en: 'Reserves one output attempt after checking the opportunity.' },
      bookfish_review: { zh: '开始、分页回查、保存或结束全书读后感任务，并查看历史版本。', en: 'Starts, pages, saves or ends a full-book review job and lists versions.' },
      bookfish_discussion: { zh: '记录已经通过桌宠说出的讨论短句，或在两条气泡之间等待。', en: 'Records lines already spoken on the desktop, or waits between two bubbles.' },
      bookfish_help: { zh: '按主题读取详细协议；核心规则始终优先。', en: 'Reads the detailed protocol for one topic; the core rules always win.' },
    }),
    events: [
      { type: 'bookfish.discussion', description: { zh: '用户从已读感想发起讨论，要求桌宠用多条短句回答并把说出的内容同步到扩展页；不授权读后文。', en: 'A user discussion linked to a confirmed episode, answered on the desktop in short bubbles and mirrored in the panel; it does not authorize reading ahead.' } },
      { type: 'bookfish.review_opportunity', description: { zh: '全书完成后或用户请求时提供一次读后感任务，不直接输出。', en: 'Offers one review job after completion or a user request; no direct output.' } },
      { type: 'bookfish.sharing_probe', description: { zh: '主动分享开启后等待空闲观测，不请求输出。', en: 'Waits for idle observation after sharing is enabled; requests no output.' } },
      { type: 'bookfish.share_opportunity', description: { zh: '空闲时给予一次可放弃的分享机会，须领取许可后输出。', en: 'Offers one optional share while idle; requires a permit before output.' } },
      { type: 'bookfish.scheduler_probe', description: { zh: '尚无阶段观测时，仅唤醒一次以取得宿主空闲状态，不提供正文。', en: 'Wakes once when the host phase is unknown; provides no novel text.' } },
      { type: 'bookfish.reading_opportunity', description: { zh: '自动空闲或用户明确请求时提供一次阅读机会，不包含小说正文。', en: 'Offers one reading opportunity while idle or on an explicit user request, without novel text.' } },
      { type: 'bookfish.started', description: { zh: '书架已挂载，旧在途任务失效。', en: 'The library was mounted; previous pending tasks were cancelled.' } },
      { type: 'bookfish.serial_updated', description: { zh: '连载检查已追加新章；只陈述事实，不剧透、不强制阅读。', en: 'A serial check appended chapters; states the fact without spoilers or forced reading.' } },
      { type: 'bookfish.selection_opportunity', description: { zh: '空闲时给予一次自主找书机会；可拒绝，不包含书单或正文。', en: 'One optional autonomous book-selection opportunity while idle; may be declined and contains no list or text.' } },
      { type: 'bookfish.acquisition_changed', description: { zh: '自选书搜索或获取到达终态、需要选版本或已入架排队；不表示已读。', en: 'A self-selected search/acquisition reached a terminal state, needs an edition choice, or entered the queue; never means read.' } },
    ],
  },
};
