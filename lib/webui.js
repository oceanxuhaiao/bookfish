// src/config.ts
var BOOKFISH_DEFAULTS = {
  enabled: false,
  readingMode: "auto",
  allowNetwork: true,
  automaticReading: true,
  autonomousAcquisition: false,
  autonomousAcquisitionMode: "auto",
  autonomousSourceIds: "",
  autonomousDiskBudgetMb: 1024,
  textStoreDir: "",
  dailyChapterGoal: 0,
  readingSessionMinutes: 10,
  realRoutineEnabled: true,
  speed: "normal",
  readingCharsPerMinute: 0,
  dailyTasks: 40,
  dailyChars: 48e3,
  automaticSharing: true,
  automaticReview: true,
  shareCooldownMinutes: 60,
  shareQuietEnabled: true,
  shareQuietStart: 22,
  shareQuietEnd: 8,
  shareMaxSentenceChars: 80,
  shareQuietStartMinute: -1,
  shareQuietEndMinute: -1
};
function sharingLimits(cfg) {
  const integer = (v, fallback, min, max) => Number.isSafeInteger(v) && v >= min && v <= max ? v : fallback;
  return {
    cooldownMs: integer(cfg.shareCooldownMinutes, 60, 1, 1440) * 6e4,
    maxSentenceChars: integer(cfg.shareMaxSentenceChars, 80, 10, 300),
    startMinute: integer(cfg.shareQuietStartMinute, integer(cfg.shareQuietStart, 22, 0, 23) * 60, 0, 1439),
    endMinute: integer(cfg.shareQuietEndMinute, integer(cfg.shareQuietEnd, 8, 0, 23) * 60, 0, 1439),
    quiet: cfg.shareQuietEnabled !== false,
    start: integer(cfg.shareQuietStart, 22, 0, 23),
    end: integer(cfg.shareQuietEnd, 8, 0, 23)
  };
}

// src/webui/style.ts
var style = `
.bf{max-width:960px;margin:auto;color:#283d3a;background:#f5f6f0;padding:24px;border-radius:16px;font:15px/1.75 system-ui,sans-serif}
.bf .shelf-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 18px}.bf .shelf-header h2,.bf .shelf-header h3{margin:0}.bf .shelf-header>button{flex-shrink:0}.bf *{box-sizing:border-box}.bf [hidden]{display:none!important}.bf h2{font-size:23px;margin:0 0 8px}.bf h3{font-size:18px;margin:0 0 12px}.bf p{margin:8px 0}.bf small{color:#738179;font-size:13px}.bf button{cursor:pointer;border:1px solid #d9e1d4;border-radius:9px;background:#fffefa;color:#365b48;padding:8px 14px;font:inherit}.bf button:hover{background:#e9efdf}.bf button:disabled{opacity:.5;cursor:default}.bf .primary{background:#386c58;color:white}.bf nav{display:flex;gap:22px;border-bottom:1px solid #dde5d8;margin:18px 0 24px}.bf nav button{border:0;border-radius:0;background:none;padding:10px 0}.bf nav button[aria-current=page]{border-bottom:3px solid #386c58;font-weight:bold}.bf .card,.bf .shelf article,.bf .notebook article{background:#fffefa;padding:24px;border:1px solid #e0e6d9;border-radius:16px;margin-bottom:16px}.bf .controls{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.bf .timeline{height:270px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 14px 0 5px;margin-top:16px}.bf .timeline article{border-left:2px solid #d4dfcd;padding:0 0 20px 20px;position:relative}.bf .timeline article:before{content:'';width:8px;height:8px;background:#739267;border-radius:50%;position:absolute;left:-5px;top:9px}.bf .timeline time{font-size:13px;color:#47765d;display:block}.bf .timeline p{font-size:14px}.bf .mood{font-size:21px}.bf .thought{font-size:18px;line-height:1.9}.bf progress{width:100%;height:7px;accent-color:#76986a;margin:16px 0}.bf details{margin:14px 0}.bf summary{cursor:pointer;color:#416e52}.bf input:not([type=checkbox]),.bf select,.bf textarea{border:1px solid #d5dfce;border-radius:8px;padding:9px;font:inherit;background:#fffefa;color:#283d3a;max-width:100%}.bf label{display:block;margin:12px 0}.bf textarea{width:100%;min-height:100px}.bf blockquote{border-left:3px solid #b7c7ac;padding:10px 18px;margin:16px 0;background:#f0f4e9}.bf .setting{border-bottom:1px solid #e1e7da;padding:15px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.bf .setting label{margin:0}.bf :focus-visible{outline:3px solid #a5beaa;outline-offset:3px}.bf .messages:not(:empty){padding:10px 14px;border-radius:9px;background:#e7edde;overflow-wrap:anywhere}.bf .shelf{display:grid;gap:12px}.bf .shelf article{margin:0}.bf .settings-help{font-size:13px;color:#738179}.bf .badge{display:inline-block;background:#e7efdc;padding:2px 10px;border-radius:20px;font-size:12px}.bf .badge.experimental{background:#f3e6c4;color:#76551b}.bf .import-method{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0 10px;padding:12px 14px;border:1px solid #d7e0d0;border-radius:10px;background:#f4f7ee}.bf .import-method label{display:flex;align-items:center;gap:10px;margin:0;font-weight:600}.bf .import-method select{min-width:190px}.bf .import-method-panel{margin-top:8px}.bf .novel-engine-gate{padding:12px 14px;border:1px solid #d9c992;border-radius:9px;background:#fbf5df;color:#6d551c}.bf .source-result{padding:12px;background:#edf3e4;border-radius:9px;margin:12px 0}
.bf .conversation{display:flex;flex-direction:column;gap:4px;margin:8px 0}.bf .chat-line{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.bf .chat-line.you{color:#5c6a60}.bf .chat-line.pet{color:#283d3a}.bf .chat-line.pet.unavailable{color:#8b3b2e}
@media(max-width:600px){.bf{padding:16px}.bf .card,.bf .notebook article{padding:18px}.bf nav{gap:20px}.bf .thought{font-size:16px}.bf .reading-hero.is-empty .detail-info{grid-template-columns:1fr;grid-template-areas:"title" "chapter" "actions"}.bf .reading-hero.is-empty .hero-actions{justify-content:flex-start}}
.bf .support-grid{display:grid;gap:16px}.bf .support-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch}.bf .support-actions .support-card{height:100%;margin:0}.bf .support-community{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;margin:0}.bf .support-community .qq-group-code{margin:0;width:220px}.bf .support-link{display:block;color:#386c58;margin:8px 0;overflow-wrap:anywhere}.bf .support-number{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:600}.bf .support-copy{font-size:13px;padding:5px 10px}.bf .qq-group-code{display:block;width:min(250px,100%);height:auto;margin:10px 0;border-radius:10px}.bf .support-note{display:block;margin-top:4px}@media(max-width:760px){.bf .support-actions{grid-template-columns:1fr}.bf .support-community{grid-template-columns:1fr;justify-items:start}.bf .support-community .qq-group-code{width:min(250px,100%)}}
.bf .reading-hero.is-empty{grid-template-columns:minmax(0,1fr)}.bf .reading-hero.is-empty .detail-info{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title actions" "chapter actions";gap:4px 24px;align-items:center;max-width:760px}.bf .reading-hero.is-empty .detail-info>h2{grid-area:title;font-size:30px;line-height:1.25;margin:0}.bf .reading-hero.is-empty .detail-info>p:not(.hero-footer){grid-area:chapter;margin:0}.bf .reading-hero.is-empty .hero-footer{grid-area:actions;margin:0}.bf .reading-hero.is-empty .hero-actions{justify-content:flex-end;margin:0}.bf .hero-actions details{margin:0}
.bf .reading-hero{display:grid;grid-template-columns:112px minmax(0,1fr);gap:24px;align-items:start}.bf .cover-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:24px;margin:22px 0}.bf .cover-grid article{min-width:0;position:relative}.bf .cover-grid strong,.bf .cover-grid small{display:block}.bf .cover-button{display:block;width:100%;padding:0;border:0;background:none;text-align:left}.bf .book-cover{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:14px;aspect-ratio:2/3;border-radius:5px 12px 12px 5px;padding:22px 16px 15px 27px;overflow:hidden;isolation:isolate;color:var(--cover-ink,#f7f2e7);background:linear-gradient(155deg,var(--cover-a,#3d4a3c),var(--cover-b,#5c6b52));box-shadow:inset 8px 0 #0002,inset 10px 0 #fff1,0 8px 18px #232d231f;max-width:180px}.bf .book-cover:before{content:'';position:absolute;inset:0 auto 0 0;width:8px;background:linear-gradient(180deg,#fff3,#0003);z-index:1;pointer-events:none}.bf .book-cover:after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 4px);opacity:.55;pointer-events:none;z-index:0}.bf .book-cover[data-palette="0"]{--cover-a:#2f4a3d;--cover-b:#56745e}.bf .book-cover[data-palette="1"]{--cover-a:#532c31;--cover-b:#7a4648}.bf .book-cover[data-palette="2"]{--cover-a:#2b3c58;--cover-b:#4b5f7f}.bf .book-cover[data-palette="3"]{--cover-a:#6a4a29;--cover-b:#8b653b}.bf .book-cover[data-palette="4"]{--cover-a:#472f48;--cover-b:#684763}.bf .book-cover[data-palette="5"]{--cover-a:#23494b;--cover-b:#3f6f6f}.bf .book-cover[data-palette="6"]{--cover-a:#33373a;--cover-b:#555b5e}.bf .book-cover[data-palette="7"]{--cover-a:#3d4a2c;--cover-b:#5f7044}.bf .cover-copy{position:relative;z-index:2;display:flex;flex-direction:column;gap:8px;min-width:0}.bf .cover-title{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font:600 18px/1.4 "Noto Serif SC","Songti SC",serif;letter-spacing:.03em;overflow-wrap:anywhere}.bf .cover-rule{display:block;width:28px;height:1px;background:currentColor;opacity:.55}.bf .cover-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.5 system-ui,sans-serif;letter-spacing:.08em;opacity:.82}.bf .cover-foot{position:relative;z-index:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px/1.4 system-ui,sans-serif;letter-spacing:.08em;opacity:.64}.bf .cover-mark{position:absolute;right:10px;top:4px;z-index:0;font:72px/1 "Noto Serif SC",serif;color:#fff2;pointer-events:none}.bf .reading-hero .book-cover{padding:18px 12px 12px 21px;gap:10px}.bf .reading-hero .cover-title{font-size:15px;line-height:1.38}.bf .reading-hero .cover-author{font-size:10px}.bf .reading-hero .cover-foot{font-size:8px;letter-spacing:.08em}.bf .reading-hero .cover-mark{font-size:52px;right:7px}.bf .shelf-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.bf .shelf-toolbar input{flex:1;min-width:100px}.bf .shelf-toolbar>button{flex-shrink:0}.bf .detail-head{display:grid;grid-template-columns:140px minmax(0,1fr);gap:24px;align-items:start;margin:16px 0 12px}.bf .detail-head .book-cover{width:140px;max-width:none;margin:0}.bf .detail-info{min-width:0}.bf .detail-info h2{margin-top:0}.bf .detail-actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 8px}.bf button.danger{color:#8b3b2e;border-color:#e3c6bd;background:#fff8f4}.bf button.danger:hover{background:#f8e7e0}.bf .cover-grid details{margin:2px 0}.bf .cover-grid summary{list-style:none}.bf .cover-grid .book-cover{max-width:none}.bf .cover-grid .cover-button:focus-visible{outline-offset:5px}
@media(max-width:420px){.bf .reading-hero{grid-template-columns:76px minmax(0,1fr);gap:14px}.bf .reading-hero .book-cover{padding:12px 8px 8px 15px;gap:6px}.bf .reading-hero .cover-title{font-size:12px;line-height:1.35;-webkit-line-clamp:3}.bf .reading-hero .cover-author{font-size:8px}.bf .reading-hero .cover-foot{display:none}.bf .reading-hero .cover-mark{font-size:34px;right:5px}.bf .cover-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.bf .detail-head{grid-template-columns:96px minmax(0,1fr);gap:14px}.bf .detail-head .book-cover{width:96px}.bf .detail-head .cover-title{font-size:15px}.bf .detail-head .cover-author,.bf .detail-head .cover-foot{font-size:9px}}
@media(max-height:600px){.bf{padding:14px}.bf h2{font-size:20px}.bf nav{margin:8px 0 14px}.bf nav button{padding:5px 0}.bf .card{padding:18px}.bf .cover-grid{margin:14px 0;gap:16px}.bf .shelf-toolbar input,.bf .shelf-toolbar select{padding:6px}}
.bf [data-page=reader]{background:#f8f3e8;border-radius:12px;padding:22px;color:#322f29}.bf [data-page=reader][data-theme=green]{background:#dfebdb}.bf [data-page=reader][data-theme=night]{background:#252925;color:#d4d8ce}.bf .reader-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.bf .reader-text{max-width:720px;margin:28px auto;line-height:2;font-family:'Noto Serif SC','Microsoft YaHei',serif;overflow-wrap:anywhere}.bf .reader-text p{text-indent:2em;margin:0 0 1em;white-space:pre-wrap}.bf .reader-text:focus{outline:none}.bf .reader-directory>div{max-height:300px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px}.bf .reader-directory button{text-align:left}.bf .source-result:empty{display:none}.bf .source-result progress{display:block;height:8px}
.bf .reading-state{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;margin:0 0 20px;border:1px solid #d7e0d0;border-radius:12px;background:#eef2e8}.bf .reading-state strong{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}.bf .reading-state strong:before{content:'';width:9px;height:9px;border-radius:50%;background:#8b9487;flex-shrink:0}.bf .reading-state span{font-size:13px;color:#647268}.bf .reading-state[data-state=reading]{background:#e1efdf;border-color:#9cbd94}.bf .reading-state[data-state=reading] strong{color:#28643c}.bf .reading-state[data-state=reading] strong:before{background:#34814b;box-shadow:0 0 0 4px #34814b18}.bf .reading-state[data-state=queued] strong:before{background:#ba8b39}.bf .reading-state[data-state=routine] strong:before{background:#7e79a6}.bf .reading-state[data-state=error] strong:before{background:#b2644c}
.bf .hero-footer{display:flex;align-items:center;gap:12px 18px;flex-wrap:wrap;margin-top:2px}.bf .hero-footer>p{margin:0}.bf .hero-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-left:auto}
.bf .hero-actions button:disabled{background:#e3e6e0;color:#8b9387;border-color:#daddd6;opacity:1}
.bf .novel-form{display:grid;gap:8px;border-top:1px solid #8886;padding-top:12px}.bf .novel-search-progress{height:8px;margin:4px 0}.bf .novel-candidates{display:grid;gap:10px;margin:12px 0}.bf .novel-candidate{border:1px solid #d8e0d2;border-radius:10px;padding:10px 12px;display:grid;gap:4px;background:#fbfcf7}.bf .novel-candidate button{justify-self:start}.bf .novel-alternative{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-top:1px solid #e4e9de;padding:8px 0}.bf .novel-alternative button{justify-self:auto}.bf .novel-task-list{display:grid;gap:10px}.bf .novel-resume{display:grid;gap:10px;margin:12px 0}.bf .novel-resume>small{opacity:.8}.bf .novel-task{border:1px solid #d8e0d2;border-radius:10px;padding:10px 12px;display:grid;gap:4px;background:#fbfcf7}.bf .novel-task progress{height:6px;margin:4px 0}.bf .shelf-header{flex-wrap:wrap}.bf .shelf-header>button{margin-left:0}
.bf .selection-panel{display:grid;gap:10px;margin:0 0 22px}.bf .selection-panel>h3{margin:0}.bf .selection-history,.bf .novel-resume-history{border-top:1px solid #e4e9de;padding-top:8px}.bf .selection-history>summary,.bf .novel-resume-history>summary{font-size:13px;color:#6e7b70}.bf .selection-history>article,.bf .novel-resume-history>article{margin-top:10px}.bf .selection-intent,.bf .selection-queue{border:1px solid #d8e0d2;border-radius:12px;padding:12px 14px;background:#fbfcf7;display:grid;gap:6px}.bf .selection-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.bf .selection-badge{font-size:12px;border-radius:99px;padding:2px 10px;background:#e7ece2;color:#58705f}.bf .selection-intent blockquote{margin:0;padding:8px 12px;border-left:3px solid #b7c7ac;background:#f2f5ed}.bf .selection-intent progress{height:6px;margin:0}.bf .selection-error{color:#8b3b2e}.bf .selection-gate{border-left:3px solid #ba8b39;background:#faf3e2;padding:8px 12px;border-radius:6px}.bf .selection-notice{margin:0 0 18px;padding:10px 14px;border-radius:9px;background:#faf3e2;color:#6f5521}
`;

// src/webui/runtime.ts
var PHASE_LABEL = {
  preparing: ["\u51C6\u5907\u5B89\u88C5", "Preparing"],
  downloading: ["\u4E0B\u8F7D\u8FD0\u884C\u65F6", "Downloading runtime"],
  uploading: ["\u63A5\u6536\u79BB\u7EBF\u5305", "Receiving offline package"],
  verifying: ["\u6821\u9A8C\u6458\u8981", "Verifying digest"],
  extracting: ["\u5B89\u5168\u89E3\u538B", "Extracting safely"],
  probing: ["\u542F\u52A8\u81EA\u68C0", "Startup self-check"],
  waiting_idle: ["\u7B49\u5F85\u5728\u9014\u4EFB\u52A1\u7ED3\u675F", "Waiting for running tasks"],
  activating: ["\u542F\u7528\u65B0\u8FD0\u884C\u65F6", "Activating"],
  ready: ["\u5B89\u88C5\u5B8C\u6210", "Ready"],
  failed: ["\u5B89\u88C5\u5931\u8D25", "Install failed"],
  cancelled: ["\u5DF2\u53D6\u6D88", "Cancelled"],
  interrupted: ["\u4E0A\u6B21\u5B89\u88C5\u88AB\u4E2D\u65AD", "Last install was interrupted"],
  idle: ["\u672A\u5F00\u59CB", "Idle"]
};
var PHASE_DETAIL = {
  preparing: ["\u68C0\u67E5\u5E73\u53F0\u4E0E\u5B89\u88C5\u76EE\u5F55\uFF0C\u51C6\u5907\u4E0B\u8F7D\u3002", "Checking the platform and install folder; preparing the download."],
  downloading: ["\u6B63\u5728\u4E0B\u8F7D\u56FA\u5B9A\u7248\u672C\u7684\u8FD0\u884C\u65F6\u538B\u7F29\u5305\uFF1B\u5B8C\u6210\u540E\u81EA\u52A8\u6821\u9A8C\u3002", "Downloading the pinned runtime archive; verification starts when it finishes."],
  uploading: ["\u6B63\u5728\u63A5\u6536\u4F60\u9009\u62E9\u7684\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\u3002", "Receiving the offline runtime ZIP you selected."],
  verifying: ["\u6838\u5BF9\u538B\u7F29\u5305\u6458\u8981\u4E0E\u6587\u4EF6\u6E05\u5355\uFF0C\u9632\u6B62\u635F\u574F\u6216\u88AB\u66FF\u6362\u3002", "Checking the archive digest and file list for damage or substitution."],
  extracting: ["\u5728\u4E34\u65F6\u76EE\u5F55\u5B89\u5168\u89E3\u538B\uFF0C\u4E0D\u8986\u76D6\u5F53\u524D\u7248\u672C\u3002", "Safely extracting into a staging folder; the current runtime stays untouched."],
  probing: ["\u542F\u52A8\u968F\u5305 Java \u4E0E\u5F15\u64CE\u505A\u81EA\u68C0\uFF0C\u786E\u8BA4\u80FD\u8FD0\u884C\u3002", "Starting the bundled Java and engine for a self-check."],
  waiting_idle: ["\u7B49\u5F85\u5728\u9014\u4E0B\u8F7D\u6216\u9605\u8BFB\u4EFB\u52A1\u7ED3\u675F\u540E\u518D\u5207\u6362\u3002", "Waiting for running downloads or reads before switching."],
  activating: ["\u539F\u5B50\u5207\u6362\u5230\u65B0\u7248\u672C\uFF1B\u5931\u8D25\u4F1A\u4FDD\u7559\u65E7\u7248\u3002", "Atomically switching to the new runtime; the old one stays on failure."],
  ready: ["\u5B89\u88C5\u5B8C\u6210\uFF0C\u53EF\u4EE5\u6309\u4E66\u540D\u6216\u4F5C\u8005\u641C\u7D22\u3002", "Ready; title/author search is enabled."],
  failed: ["\u5B89\u88C5\u5931\u8D25\uFF0C\u67E5\u770B\u4E0B\u9762\u7684\u9519\u8BEF\u539F\u56E0\u3002", "Install failed; see the error below."],
  cancelled: ["\u5B89\u88C5\u5DF2\u53D6\u6D88\uFF0C\u65E7\u7248\u4FDD\u6301\u4E0D\u53D8\u3002", "Install cancelled; the previous runtime is unchanged."],
  interrupted: ["\u4E0A\u6B21\u5B89\u88C5\u88AB\u4E2D\u65AD\uFF0C\u53EF\u91CD\u8BD5\u6216\u5BFC\u5165\u79BB\u7EBF\u5305\u3002", "The last install was interrupted; retry or import an offline ZIP."],
  idle: ["\u5C1A\u672A\u5F00\u59CB\u5B89\u88C5\u3002", "Not started."]
};
function formatBytes(value) {
  if (value === null || value === void 0 || !Number.isFinite(value)) return "\u2014";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
function toBase64(bytes) {
  let binary = "";
  const step = 32768;
  for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(binary);
}
function isActive(phase) {
  return !["ready", "failed", "cancelled", "interrupted", "idle"].includes(phase);
}
function mountRuntimeCard(container, ctx, options = {}) {
  const en = ctx.language !== "zh" && ctx.language !== "zh-Hant";
  const say = (zh, english) => en ? english : zh;
  const root = document.createElement("section");
  root.className = "card bf-runtime";
  const css = document.createElement("style");
  css.textContent = `
.bf-runtime{display:grid;gap:10px}.bf-runtime .runtime-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.bf-runtime h3{margin:0}.bf-runtime .runtime-badge{font-size:12px;border-radius:99px;padding:2px 10px;background:#e7ece2;color:#58705f;font-weight:600}.bf-runtime .runtime-badge[data-state=ok]{background:#dcefdc;color:#28643c}.bf-runtime .runtime-badge[data-state=busy]{background:#f4ecd7;color:#7c5c1c}.bf-runtime .runtime-badge[data-state=bad]{background:#f6e2dc;color:#8b3b2e}.bf-runtime .runtime-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px 18px;margin:0}.bf-runtime .runtime-meta div{font-size:13px;color:#5f7064}.bf-runtime .runtime-meta strong{color:#283d3a}.bf-runtime .runtime-actions{display:flex;gap:8px;flex-wrap:wrap}.bf-runtime progress{height:8px;margin:2px 0}.bf-runtime .runtime-error{border-left:3px solid #b2644c;background:#fbf0ec;padding:8px 12px;border-radius:6px;color:#7d3324;font-size:14px}.bf-runtime .runtime-note{font-size:13px;color:#6e7b70}.bf-runtime .runtime-phase-detail{color:#5f7064;font-size:13px;line-height:1.55}.bf-runtime .runtime-availability{margin:0;padding:9px 12px;border:1px solid #e2c98f;border-radius:7px;background:#fbf5df;color:#6d551c;font-size:13px;line-height:1.55}.bf-runtime .runtime-offline-link{color:#386c58;font-size:13px;text-decoration:underline;text-underline-offset:3px}.bf-runtime a.runtime-link{color:#386c58}
`;
  root.append(css);
  const head = document.createElement("div");
  head.className = "runtime-head";
  root.append(head);
  const title = document.createElement("h3");
  title.textContent = say("\u5C0F\u8BF4\u83B7\u53D6\u5F15\u64CE", "Novel fetch engine");
  head.append(title);
  const badge = document.createElement("span");
  badge.className = "runtime-badge";
  head.append(badge);
  const intro = document.createElement("p");
  intro.style.margin = "0";
  root.append(intro);
  const meta = document.createElement("div");
  meta.className = "runtime-meta";
  root.append(meta);
  const progress = document.createElement("progress");
  progress.hidden = true;
  progress.setAttribute("aria-label", say("\u5B89\u88C5\u8FDB\u5EA6", "Install progress"));
  root.append(progress);
  const availability = document.createElement("p");
  availability.className = "runtime-availability";
  availability.hidden = true;
  root.insertBefore(availability, progress);
  const offlineLink = document.createElement("a");
  offlineLink.className = "runtime-offline-link";
  offlineLink.target = "_blank";
  offlineLink.rel = "noreferrer";
  offlineLink.hidden = true;
  root.insertBefore(offlineLink, progress);
  const progressText = document.createElement("small");
  progressText.hidden = true;
  root.append(progressText);
  const phaseDetail = document.createElement("small");
  phaseDetail.className = "runtime-phase-detail";
  phaseDetail.hidden = true;
  phaseDetail.setAttribute("role", "status");
  phaseDetail.setAttribute("aria-live", "polite");
  root.append(phaseDetail);
  const errorBox = document.createElement("div");
  errorBox.className = "runtime-error";
  errorBox.hidden = true;
  root.append(errorBox);
  const note = document.createElement("div");
  note.className = "runtime-note";
  root.append(note);
  const actions = document.createElement("div");
  actions.className = "runtime-actions";
  root.append(actions);
  let status;
  let lastUsable = false;
  let disposed = false;
  let pollTimer;
  let actionKey = "";
  let busyMessage = "";
  let updateInfo = null;
  const invoke = async (method, args = []) => ctx.invoke(method, args);
  function metaRow(label, value) {
    const row = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = value;
    row.append(document.createTextNode(`${label}\uFF1A`), strong);
    return row;
  }
  function addButton(label, primary, action, disabled = false, starting) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.disabled = disabled;
    button.addEventListener("click", () => {
      void run(action, starting);
    }, { signal: ctx.signal });
    return button;
  }
  async function run(action, starting = say("\u6B63\u5728\u5904\u7406\u2026", "Working\u2026")) {
    if (disposed || ctx.signal.aborted) return;
    busyMessage = starting;
    note.textContent = busyMessage;
    try {
      await action();
      busyMessage = "";
      await refresh();
    } catch (error) {
      busyMessage = "";
      errorBox.hidden = false;
      errorBox.textContent = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, "");
      await refresh();
    } finally {
      if (!disposed && status?.install && isActive(status.install.phase)) startPolling();
    }
  }
  function renderActions() {
    const current = status;
    const install = current.install;
    const phase = install?.phase ?? "idle";
    const active = install !== null && isActive(phase);
    const key = [current.usable, current.installed, current.canRollback, current.canUninstall, current.online.available, phase, current.error?.code ?? "", updateInfo?.available?.runtimeId ?? "", options.compact ? "c" : "f"].join("|");
    if (key === actionKey) return;
    actionKey = key;
    actions.replaceChildren();
    if (active) {
      actions.append(addButton(say("\u53D6\u6D88\u5B89\u88C5", "Cancel install"), false, async () => invoke("runtime_cancel")));
      return;
    }
    if (!current.usable) {
      const installButton = addButton(say("\u4E00\u952E\u5B89\u88C5\u5C0F\u8BF4\u5F15\u64CE", "Install novel engine"), true, async () => invoke("runtime_install"), !current.online.available || !current.platform.supported, say("\u6B63\u5728\u8FDE\u63A5\u4E0B\u8F7D\u6E90\u5E76\u51C6\u5907\u5B89\u88C5\u2026", "Contacting the download source and preparing the install\u2026"));
      if (installButton.disabled) installButton.title = !current.platform.supported ? say("\u5F53\u524D\u5E73\u53F0\u4E0D\u652F\u6301\u4E00\u952E\u5B89\u88C5\uFF1B\u8BF7\u7528\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\u3002", "One-click install is unavailable on this platform; use an offline runtime ZIP.") : say("\u4E0B\u8F7D\u6765\u6E90\u5C1A\u672A\u914D\u7F6E\uFF1B\u8BF7\u7528\u201C\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\u201D\u3002", "No download source is configured; use \u201CImport offline runtime ZIP\u201D.");
      actions.append(installButton);
      const file = document.createElement("input");
      file.type = "file";
      file.accept = ".zip,application/zip";
      file.hidden = true;
      file.addEventListener("change", () => {
        const selected = file.files?.[0];
        if (selected) void run(() => importZip(selected));
      }, { signal: ctx.signal });
      actions.append(file);
      const importButton = addButton(say("\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305", "Import offline runtime ZIP"), false, async () => {
        file.click();
      });
      actions.append(importButton);
      if (current.online.available) actions.append(addButton(say("\u4E0B\u8F7D\u79BB\u7EBF\u5305", "Download offline ZIP"), false, async () => {
        await downloadOffline();
      }));
      if (current.installed) actions.append(addButton(say("\u4FEE\u590D\u5B89\u88C5", "Repair install"), false, async () => {
        if (current.online.available) await invoke("runtime_install");
        else file.click();
      }));
      return;
    }
    if (!options.compact) {
      if (updateInfo?.available) actions.append(addButton(say(`\u5347\u7EA7\u5230 ${updateInfo.available.runtimeVersion}`, `Upgrade to ${updateInfo.available.runtimeVersion}`), true, async () => {
        await invoke("runtime_install", [updateInfo.available.runtimeId]);
        updateInfo = null;
      }));
      actions.append(addButton(say("\u91CD\u65B0\u68C0\u6D4B", "Check again"), false, async () => {
        await invoke("runtime_probe");
        await invoke("runtime_check_source");
      }));
      actions.append(addButton(say("\u68C0\u67E5\u66F4\u65B0", "Check for updates"), false, async () => {
        const result = await invoke("runtime_check_update");
        updateInfo = result;
        note.textContent = result.reason ?? (result.available ? say(`\u53D1\u73B0\u65B0\u7248\u672C ${result.available.runtimeVersion}`, `New runtime ${result.available.runtimeVersion} available`) : say("\u5DF2\u662F\u6700\u65B0\u7248\u672C", "Up to date"));
        actionKey = "";
        renderActions();
      }));
      const repairFile = document.createElement("input");
      repairFile.type = "file";
      repairFile.accept = ".zip,application/zip";
      repairFile.hidden = true;
      repairFile.addEventListener("change", () => {
        const selected = repairFile.files?.[0];
        if (selected) void run(() => importZip(selected));
      }, { signal: ctx.signal });
      actions.append(repairFile);
      actions.append(addButton(say("\u4FEE\u590D", "Repair"), false, async () => {
        if (current.online.available) await invoke("runtime_install", [current.runtimeId]);
        else repairFile.click();
      }));
      if (current.canRollback) actions.append(addButton(say("\u56DE\u9000\u5230\u4E0A\u4E00\u7248\u672C", "Roll back"), false, async () => {
        if (await ctx.ui.confirm({ title: say("\u56DE\u9000\u8FD0\u884C\u65F6\uFF1F", "Roll back the runtime?"), body: say("\u53EA\u5207\u6362\u8FD0\u884C\u65F6\uFF0C\u4E0D\u6539\u52A8\u4E66\u67B6\u3001\u9605\u8BFB\u8FDB\u5EA6\u548C\u5C0F\u8BF4\u4E0B\u8F7D\u7F13\u5B58\u3002", "Only the runtime changes; books, progress and download cache stay.") })) await invoke("runtime_rollback");
      }));
      if (current.canUninstall) actions.append(addButton(say("\u5378\u8F7D\u8FD0\u884C\u65F6", "Uninstall runtime"), false, async () => {
        if (await ctx.ui.confirm({ title: say("\u5378\u8F7D\u5C0F\u8BF4\u5F15\u64CE\u8FD0\u884C\u65F6\uFF1F", "Uninstall the novel engine runtime?"), body: say("\u5DF2\u52A0\u5165\u4E66\u67B6\u7684\u4E66\u7C4D\u548C\u9605\u8BFB\u8FDB\u5EA6\u4F1A\u4FDD\u7559\uFF0C\u4E4B\u540E\u53EF\u91CD\u65B0\u5B89\u88C5\u3002", "Shelved books and progress stay; you can reinstall later."), danger: true })) {
          await invoke("runtime_uninstall");
          options.onReady?.();
        }
      }));
    }
  }
  async function importZip(file) {
    if (!/\.zip$/iu.test(file.name)) throw new Error(say("\u8BF7\u9009\u62E9 .zip \u683C\u5F0F\u7684\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305", "Choose an offline runtime .zip"));
    const begin = await invoke("runtime_import_begin", [{ size: file.size, filename: file.name }]);
    await refresh();
    startPolling();
    let offset = 0;
    while (offset < file.size) {
      if (ctx.signal.aborted || disposed) return;
      const slice = new Uint8Array(await file.slice(offset, offset + begin.chunkBytes).arrayBuffer());
      const result = await invoke("runtime_import_chunk", [begin.id, offset, toBase64(slice)]);
      offset = result.offset;
      progress.hidden = false;
      progress.max = file.size;
      progress.value = offset;
      progressText.hidden = false;
      progressText.textContent = `${say("\u4E0A\u4F20\u79BB\u7EBF\u5305", "Uploading offline package")} ${formatBytes(offset)} / ${formatBytes(file.size)}`;
    }
    await invoke("runtime_import_finish", [begin.id]);
    await refresh();
    startPolling();
  }
  async function downloadOffline() {
    const info = await invoke("runtime_download_info");
    if (!info.available || !info.url) throw new Error(info.reason ?? say("\u4E0B\u8F7D\u5730\u5740\u5C1A\u672A\u914D\u7F6E", "Download URL is not configured"));
    const anchor = document.createElement("a");
    anchor.href = info.url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.download = info.fileName ?? "";
    anchor.click();
  }
  function apply(next) {
    status = next;
    const install = next.install;
    const phase = install?.phase ?? "idle";
    const active = install !== null && isActive(phase);
    const state = !next.platform.supported ? "bad" : active ? "busy" : next.usable ? "ok" : next.installed ? "bad" : "plain";
    badge.dataset.state = state;
    badge.textContent = !next.platform.supported ? say("\u5E73\u53F0\u4E0D\u652F\u6301", "Unsupported platform") : active ? say("\u5B89\u88C5\u4E2D", "Installing") : next.usable ? say("\u53EF\u7528", "Ready") : next.installed ? say("\u9700\u8981\u4FEE\u590D", "Needs repair") : say("\u672A\u5B89\u88C5", "Not installed");
    intro.textContent = !next.platform.supported ? say(`\u5F53\u524D\u5BBF\u4E3B\u4E3A ${next.platform.platform}-${next.platform.arch}\uFF0C\u9996\u53D1\u53EA\u652F\u6301 Windows x64\u3002\u4ECD\u53EF\u7EE7\u7EED\u4F7F\u7528\u6587\u4EF6\u5BFC\u5165\u3002`, `This host is ${next.platform.platform}-${next.platform.arch}; the first release supports Windows x64 only. File import still works.`) : next.usable ? say("\u6309\u4E66\u540D\u6216\u4F5C\u8005\u641C\u7D22\u4E0E\u83B7\u53D6\u65F6\u4F7F\u7528\u8FD9\u4E2A\u672C\u5730\u5F15\u64CE\u3002\u5B83\u5305\u542B\u56FA\u5B9A\u7248\u672C\u7684 Java\u3001\u5F15\u64CE\u548C\u4E66\u6E90\u89C4\u5219\uFF0C\u4E0D\u4F9D\u8D56\u7CFB\u7EDF Java\u3002", "Title/author search and fetching use this local engine. It bundles pinned Java, engine and rules; no system Java needed.") : say("\u7528\u4E8E\u6309\u4E66\u540D/\u4F5C\u8005\u641C\u7D22\u4E0E\u83B7\u53D6\u3002\u5B89\u88C5\u5305\u8F83\u5927\uFF0C\u4E0B\u8F7D\u4E0E\u5B89\u88C5\u53EA\u5728\u4F60\u70B9\u51FB\u540E\u8FDB\u884C\uFF1B\u5F15\u64CE\u5C31\u7EEA\u4E0E\u4E66\u6E90\u7F51\u7EDC\u53EF\u8FBE\u5206\u5F00\u5224\u65AD\u3002", "Used for search and fetching by title/author. The download is large and only starts when you click. Engine readiness and source reachability are checked separately.");
    meta.replaceChildren();
    meta.append(metaRow(say("\u7248\u672C", "Version"), next.runtimeVersion ?? "\u2014"));
    meta.append(metaRow(say("\u5F15\u64CE", "Engine"), next.soNovelVersion ?? "\u2014"));
    meta.append(metaRow(say("Java", "Java"), next.javaVersion ?? "\u2014"));
    meta.append(metaRow(say("\u5E73\u53F0", "Platform"), `${next.platform.platform}-${next.platform.arch}`));
    meta.append(metaRow(say("\u4E0B\u8F7D\u5927\u5C0F", "Download"), formatBytes(next.archiveBytes)));
    meta.append(metaRow(say("\u89E3\u538B\u540E", "Unpacked"), formatBytes(next.payloadBytes)));
    meta.append(metaRow(say("\u4E0A\u6B21\u81EA\u68C0", "Last check"), next.health.checkedAt ? new Date(next.health.checkedAt).toLocaleString() : "\u2014"));
    if (next.busyTasks) meta.append(metaRow(say("\u5728\u9014\u4EFB\u52A1", "Running tasks"), String(next.busyTasks)));
    const unsupported = !next.platform.supported;
    const unavailable = !next.usable && (unsupported || !next.online.available);
    availability.hidden = !unavailable;
    if (unavailable) availability.textContent = unsupported ? say(`\u4E00\u952E\u5B89\u88C5\u4E0D\u53EF\u7528\uFF1A\u5F53\u524D\u5E73\u53F0 ${next.platform.platform}-${next.platform.arch} \u4E0D\u5728\u9996\u53D1\u652F\u6301\u8303\u56F4\u3002\u8BF7\u7528\u201C\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\u201D\u3002`, `One-click install is unavailable on ${next.platform.platform}-${next.platform.arch}. Use \u201CImport offline runtime ZIP\u201D.`) : say(`\u4E00\u952E\u5B89\u88C5\u4E0D\u53EF\u7528\uFF1A${next.online.reason ?? "\u6B63\u5F0F\u4E0B\u8F7D\u6765\u6E90\u5C1A\u672A\u914D\u7F6E"}\u3002\u8BF7\u7528\u201C\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\u201D\u3002`, `One-click install is unavailable: ${next.online.reason ?? "no trusted download source is configured"}. Use \u201CImport offline runtime ZIP\u201D.`);
    const offlineUrl = next.online.offlineUrl ?? null;
    offlineLink.hidden = !offlineUrl;
    if (offlineUrl) {
      offlineLink.href = offlineUrl;
      offlineLink.title = offlineUrl;
      offlineLink.textContent = say(`\u4E0B\u8F7D\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\uFF08Windows x64\uFF0C${formatBytes(next.online.offlineSizeBytes)}\uFF09`, `Download offline runtime ZIP (Windows x64, ${formatBytes(next.online.offlineSizeBytes)})`);
    }
    if (install && phase !== "ready") {
      const labels = PHASE_LABEL[phase] ?? [phase, phase];
      const detail = PHASE_DETAIL[phase] ?? ["\u6B63\u5728\u5904\u7406\u5B89\u88C5\u6B65\u9AA4\u3002", "Processing an install step."];
      progress.hidden = false;
      progressText.hidden = false;
      phaseDetail.hidden = false;
      if (install.percent !== null) {
        progress.max = 100;
        progress.value = install.percent;
      } else {
        progress.removeAttribute("value");
      }
      const speed = install.speedBytesPerSecond ? ` \xB7 ${formatBytes(install.speedBytesPerSecond)}/s` : "";
      const bytes = install.bytesTotal ? ` \xB7 ${formatBytes(install.bytesReceived)} / ${formatBytes(install.bytesTotal)}` : "";
      progressText.textContent = `${say(labels[0], labels[1])}${bytes}${speed}`;
      phaseDetail.textContent = say(detail[0], detail[1]);
    } else {
      progress.hidden = true;
      progressText.hidden = true;
      phaseDetail.hidden = true;
    }
    errorBox.hidden = !next.error;
    if (next.error) errorBox.textContent = next.error.message;
    const notes = [];
    if (next.note) notes.push(next.note);
    if (next.usable && next.health.message) notes.push(next.health.message);
    if (!next.online.available && next.online.reason) notes.push(next.online.reason);
    if (next.source === "legacy") notes.push(say("\u5F53\u524D\u6CBF\u7528\u65E7\u7248\u76EE\u5F55\uFF1B\u5347\u7EA7\u4F1A\u5B89\u88C5\u5230\u53D7\u7BA1\u7248\u672C\u76EE\u5F55\u3002", "Currently using the legacy directory; upgrading installs a managed version."));
    note.textContent = busyMessage || notes.join(" \xB7 ");
    renderActions();
    if (next.usable && !lastUsable) options.onReady?.();
    lastUsable = next.usable;
  }
  async function refresh() {
    if (disposed || ctx.signal.aborted) return;
    try {
      const next = await invoke("runtime_status");
      if (disposed || ctx.signal.aborted) return;
      apply(next);
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, "");
    }
  }
  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    const tick = async () => {
      if (disposed || ctx.signal.aborted) return;
      await refresh();
      if (disposed || ctx.signal.aborted || !status) return;
      const install = status.install;
      const active = install !== null && isActive(install.phase);
      if (active) pollTimer = setTimeout(() => {
        void tick();
      }, 1100);
    };
    pollTimer = setTimeout(() => {
      void tick();
    }, 700);
  }
  container.append(root);
  void refresh().then(() => {
    if (status?.install) startPolling();
  });
  return {
    refresh,
    dispose() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = void 0;
    }
  };
}

// src/webui/settings.ts
var settingsPanel = { async mount(ctx) {
  const en = ctx.language !== "zh" && ctx.language !== "zh-Hant", say = (zh, english) => en ? english : zh;
  const root = document.createElement("section");
  root.className = "bf bf-settings";
  ctx.root.append(root);
  const css = document.createElement("style");
  css.textContent = style + `
.bf-settings{max-width:900px}.bf-settings .intro{color:#738179;margin:0 0 26px}.bf-settings .card{padding:12px 28px 8px;border-radius:22px}.bf-settings .setting-row{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:24px 0;border-bottom:1px solid #e0e6d9}.bf-settings .setting-row:last-child{border:0}.bf-settings .setting-copy{flex:1;min-width:0}.bf-settings label{margin:0;font-size:16px;font-weight:600}.bf-settings .setting-copy small{display:block;margin-top:6px;line-height:1.7;max-width:540px}.bf-settings .setting-control{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.bf-settings input[type=number]{width:100px}.bf-settings input[type=time]{width:125px}.bf-settings select{min-width:200px}.bf-settings .toggle{appearance:none;width:44px;height:26px;border:0;border-radius:20px;background:#c8d1c4;position:relative;cursor:pointer;flex-shrink:0;transition:background .15s}.bf-settings .toggle:before{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transition:transform .15s}.bf-settings .toggle:checked{background:#386c58}.bf-settings .toggle:checked:before{transform:translateX(18px)}.bf-settings .toggle:focus-visible{outline:3px solid #97b392;outline-offset:3px}.bf-settings .custom-speed{background:#f2f5ed;padding:18px;border-radius:12px;margin:0 0 18px}.bf-settings .custom-speed input[type=range]{width:100%;accent-color:#386c58}.bf-settings .quiet-times{padding:0 0 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bf-settings .quiet-times label{font-size:13px;font-weight:400;color:#738179}.bf-settings details.card{padding:22px 28px}.bf-settings summary{font-weight:600}.bf-settings .save-bar{position:static;background:#f5f6f0f5;padding:16px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bf-settings .save-bar p{flex:1;font-size:14px}.bf-settings button.primary{padding:11px 24px}.bf-settings fieldset{border:0;padding:0;margin:0;min-width:0}.bf-settings .section-title{font-size:16px;margin:8px 2px 14px}.bf-settings .unit{color:#738179;font-size:14px}.bf-settings .error{color:#a54332}@media(max-width:600px){.bf-settings .card{padding:6px 18px}.bf-settings .setting-row{gap:12px}.bf-settings .setting-copy small{font-size:12px}.bf-settings select{min-width:0;width:150px}.bf-settings .setting-control{max-width:50%}.bf-settings .quiet-times{gap:8px}.bf-settings input[type=time]{width:115px}.bf-settings details.card{padding:18px}.bf-settings .save-bar p{flex-basis:100%}}
`;
  root.append(css);
  function el(tag, text, parent) {
    const n = document.createElement(tag);
    n.textContent = text;
    parent.append(n);
    return n;
  }
  el("h2", say("\u9605\u8BFB\u914D\u7F6E", "Reading settings"), root);
  el("p", say("\u6309\u5979\u7684\u8282\u594F\uFF0C\u6162\u6162\u8BFB\u3002", "Let her read at her own pace."), root).className = "intro";
  const runtimeHost = document.createElement("div");
  runtimeHost.className = "bf-runtime-host";
  root.append(runtimeHost);
  const runtimeCard = mountRuntimeCard(runtimeHost, ctx);
  const form = el("form", "", root), fields = el("fieldset", "", form);
  fields.disabled = true;
  const reading = el("section", "", fields);
  reading.className = "card";
  const controls = /* @__PURE__ */ new Map();
  function row(parent, key, title, hint, input) {
    const r = el("div", "", parent);
    r.className = "setting-row";
    const copy = el("div", "", r);
    copy.className = "setting-copy";
    const label = el("label", title, copy);
    input.id = "bf-config-" + key;
    label.htmlFor = input.id;
    if (hint) el("small", hint, copy);
    const holder = el("div", "", r);
    holder.className = "setting-control";
    holder.append(input);
    controls.set(key, input);
    return holder;
  }
  function toggle(parent, key, title, hint) {
    const i = document.createElement("input");
    i.type = "checkbox";
    i.className = "toggle";
    i.setAttribute("role", "switch");
    row(parent, key, title, hint, i);
    return i;
  }
  function number(parent, key, title, hint, min, max, unit) {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.step = "1";
    i.required = true;
    const holder = row(parent, key, title, hint, i);
    el("span", unit, holder).className = "unit";
    return i;
  }
  function select(parent, key, title, hint, options) {
    const i = document.createElement("select");
    for (const [value, label] of options) {
      const o = el("option", label, i);
      o.value = value;
    }
    row(parent, key, title, hint, i);
    return i;
  }
  function textInput(parent, key, title, hint, max) {
    const i = document.createElement("input");
    i.type = "text";
    i.maxLength = max;
    const holder = row(parent, key, title, hint, i);
    i.style.minWidth = "240px";
    return holder;
  }
  toggle(reading, "automaticReading", say("\u81EA\u4E3B\u9605\u8BFB", "Automatic reading"), say("\u6709\u7A7A\u65F6\u8BFB\u4E00\u70B9\uFF0C\u804A\u5929\u65F6\u5148\u966A\u4F60\u3002", "She reads while idle and pauses for your conversations."));
  toggle(reading, "autonomousAcquisition", say("\u8BA9\u5979\u81EA\u5DF1\u627E\u4E66\uFF08\u5B9E\u9A8C\u529F\u80FD\uFF09", "Let her find her own books (Experimental)"), say("\u5B9E\u9A8C\u529F\u80FD\uFF0C\u9ED8\u8BA4\u5173\u95ED\u3002\u5979\u81EA\u5DF1\u63D0\u51FA\u4E66\u540D\u548C\u7406\u7531\uFF0C\u540E\u53F0\u641C\u7D22\u3001\u83B7\u53D6\u3001\u6821\u9A8C\u5E76\u5165\u67B6\uFF0C\u6392\u5728\u5F53\u524D\u4E66\u4E4B\u540E\uFF1B\u83B7\u53D6\u4E0D\u7B49\u4E8E\u8BFB\u8FC7\u3002", "Experimental and off by default. She proposes a title and reason; the World searches, acquires, verifies and shelves it, then queues it after the current book. Acquiring is never reading."));
  select(reading, "autonomousAcquisitionMode", say("\u627E\u5230\u4EE5\u540E", "When found"), say("\u81EA\u52A8\u6A21\u5F0F\u53EA\u63A5\u53D7\u7CBE\u786E\u4E66\u540D\u3001\u4F5C\u8005\u548C\u5141\u8BB8\u4E66\u6E90\uFF1B\u901A\u77E5\u6A21\u5F0F\u505C\u5728\u5019\u9009\uFF0C\u7B49\u4F60\u51B3\u5B9A\u3002", "Auto accepts only an exact title/author from allowed sources; notify stops at candidates for your decision."), [["auto", say("\u81EA\u52A8\u83B7\u53D6\u5E76\u6392\u961F", "Acquire and queue automatically")], ["notify", say("\u627E\u5230\u540E\u544A\u8BC9\u6211", "Tell me when found")]]);
  textInput(reading, "autonomousSourceIds", say("\u5141\u8BB8\u81EA\u4E3B\u4F7F\u7528\u7684\u4E66\u6E90 ID", "Allowed source ids"), say("\u9017\u53F7\u5206\u9694\uFF0C\u4F8B\u5982 5,7,8\uFF1B\u7559\u7A7A\u8868\u793A\u5168\u90E8\u5DF2\u6536\u5F55\u4E66\u6E90\u3002\u4E0D\u4F1A\u81EA\u52A8\u767B\u5F55\u3001\u8D2D\u4E70\u6216\u7ED5\u8FC7\u9650\u5236\u3002", "Comma-separated, e.g. 5,7,8; empty means all curated sources. No automatic login, purchase or restriction bypass."), 100);
  number(reading, "autonomousDiskBudgetMb", say("\u81EA\u4E3B\u4E0B\u8F7D\u524D\u6700\u4F4E\u53EF\u7528\u78C1\u76D8", "Minimum free disk before an autonomous download"), say("\u8FD9\u662F\u53EF\u7528\u7A7A\u95F4\u5B89\u5168\u7EBF\uFF0C\u4E0D\u662F\u7CBE\u786E\u4E0B\u8F7D\u914D\u989D\uFF1B\u4F4E\u4E8E\u6B64\u503C\u4F1A\u6682\u505C\u83B7\u53D6\u3002", "A free-space safety floor, not an exact download quota; below it acquisition pauses."), 128, 102400, say("MiB", "MiB"));
  const speed = select(reading, "pace", say("\u9605\u8BFB\u901F\u5EA6", "Reading speed"), say("\u666E\u901A\u4EE5 400 \u5B57\uFF0F\u5206\u949F\u4E3A\u53C2\u8003\uFF0C\u53EF\u968F\u65F6\u8C03\u6574\u3002", "Normal uses 400 characters per minute; adjust whenever you like."), [["slow", say("\u6162\u4E00\u70B9 \xB7 200 \u5B57\uFF0F\u5206\u949F", "Slow \xB7 200 chars/min")], ["normal", say("\u666E\u901A \xB7 400 \u5B57\uFF0F\u5206\u949F", "Normal \xB7 400 chars/min")], ["fast", say("\u5FEB\u4E00\u70B9 \xB7 600 \u5B57\uFF0F\u5206\u949F", "Fast \xB7 600 chars/min")], ["custom", say("\u81EA\u5B9A\u4E49\u901F\u5EA6", "Custom speed")]]);
  const custom = el("div", "", reading);
  custom.className = "custom-speed";
  const rate = number(custom, "readingCharsPerMinute", say("\u6BCF\u5206\u949F\u9605\u8BFB\u5B57\u6570", "Characters per minute"), say("100\u20141200 \u5B57\uFF0F\u5206\u949F\uFF1B\u804A\u5929\u3001\u4F11\u606F\u548C\u6A21\u578B\u5904\u7406\u65F6\u95F4\u4E0D\u8BA1\u5165\u3002", "100\u20131200 chars/min; excludes chatting, resting and model processing."), 100, 1200, say("\u5B57\uFF0F\u5206\u949F", "chars/min"));
  const slider = el("input", "", custom);
  slider.type = "range";
  slider.min = "100";
  slider.max = "1200";
  slider.step = "50";
  slider.setAttribute("aria-label", say("\u8C03\u6574\u9605\u8BFB\u901F\u5EA6", "Adjust reading speed"));
  number(reading, "readingSessionMinutes", say("\u6BCF\u8F6E\u9605\u8BFB\u65F6\u957F", "Reading session"), say("\u8BFB\u4E00\u4F1A\u513F\u6B47\u4E00\u4F1A\u513F\uFF0C\u4F11\u606F\u7EA6\u4E3A\u672C\u8F6E\u9605\u8BFB\u65F6\u957F\u7684 1/4\u20141/2\u3002", "Rest for about a quarter to half of each reading session."), 1, 120, say("\u5206\u949F", "min"));
  number(reading, "dailyChapterGoal", say("\u6BCF\u65E5\u9605\u8BFB\u76EE\u6807", "Daily chapter goal"), say("0 \u8868\u793A\u4E0D\u9650\u5236\uFF1B\u8BBE\u7F6E\u540E\uFF0C\u81EA\u4E3B\u9605\u8BFB\u8FBE\u5230\u5F53\u5929\u5DF2\u8BFB\u5B8C\u7684\u7AE0\u8282\u6570\u5C31\u505C\u3002\u4E3B\u52A8\u8BF7\u6C42\u53EF\u518D\u8BFB\u4E00\u6BB5\u3002", "0 means unlimited. Automatic reading stops at the goal; an explicit request can add one passage."), 0, 1e4, say("\u7AE0\uFF0F\u5929", "chapters/day"));
  const shares = el("section", "", fields);
  shares.className = "card";
  toggle(shares, "automaticSharing", say("\u5076\u5C14\u5206\u4EAB\u8BFB\u4E66\u611F\u60F3", "Occasional reading shares"), say("\u5979\u9047\u5230\u5728\u610F\u7684\u60C5\u8282\u65F6\uFF0C\u4E3B\u52A8\u8BF4\u51E0\u53E5\u3002", "She may share a few thoughts about a passage that stays with her."));
  const routine = el("section", "", fields);
  routine.className = "card";
  shares.before(routine);
  el("h3", say("\u5927\u80A5\u9C7C\u7684\u4F5C\u606F", "Her daily routine"), routine);
  toggle(routine, "realRoutineEnabled", say("\u771F\u5B9E\u4F5C\u606F", "Real daily routine"), say("\u9ED8\u8BA4\u5F00\u542F\u3002\u5979\u4F1A\u6309\u89C4\u5F8B\u5403\u996D\u3001\u7761\u89C9\uFF0C\u8FD9\u4E9B\u65F6\u95F4\u91CC\u4E0D\u4F1A\u8BFB\u4E66\uFF0C\u4E5F\u4E0D\u80FD\u624B\u52A8\u7EE7\u7EED\u3002\u5173\u95ED\u540E\uFF0C\u5979\u4E0D\u518D\u5B89\u6392\u5403\u996D\u548C\u7761\u89C9\u3002", "On by default. She follows regular meals and sleep, when reading cannot be forced. Turn off to remove meals and sleep."));
  el("p", say("\u7761\u89C9 23:00\u201408:00 \xB7 \u65E9\u9910 08:00\u201408:30 \xB7 \u5348\u9910 12:00\u201413:00 \xB7 \u665A\u9910 18:00\u201419:00", "Sleep 23:00\u201308:00 \xB7 Breakfast 08:00\u201308:30 \xB7 Lunch 12:00\u201313:00 \xB7 Dinner 18:00\u201319:00"), routine).className = "settings-help";
  const routineZone = el("small", say("\u6309\u90E8\u7F72\u65F6\u533A\u6267\u884C\uFF1B\u4F5C\u606F\u65F6\u95F4\u56FA\u5B9A\uFF0C\u65E0\u9700\u8BBE\u7F6E\u3002\u8BFB\u4E66\u95F4\u6B47\u7684\u77ED\u4F11\u606F\u4ECD\u4F1A\u4FDD\u7559\u3002", "Uses deployment timezone; routine hours are fixed. Short reading breaks remain enabled."), routine);
  number(shares, "shareCooldownMinutes", say("\u6700\u77ED\u5206\u4EAB\u95F4\u9694", "Minimum share interval"), say("\u6709\u611F\u60F3\u65F6\u624D\u5206\u4EAB\uFF0C\u5E76\u975E\u5230\u70B9\u5FC5\u53D1\u3002", "A minimum interval, not a scheduled message."), 1, 1440, say("\u5206\u949F", "min"));
  number(shares, "shareMaxSentenceChars", say("\u6BCF\u53E5\u8BDD\u6700\u591A\u5B57\u6570", "Maximum sentence length"), "", 10, 300, say("\u5B57", "chars"));
  const quiet = el("section", "", fields);
  quiet.className = "card";
  toggle(quiet, "shareQuietEnabled", say("\u5B89\u9759\u65F6\u6BB5", "Quiet hours"), say("\u8FD9\u6BB5\u65F6\u95F4\u4E0D\u4E3B\u52A8\u5206\u4EAB\uFF1B\u4F60\u6765\u804A\u5929\uFF0C\u5979\u4ECD\u4F1A\u56DE\u5E94\u3002", "No unsolicited reading shares; she can still respond when you chat."));
  const times = el("div", "", quiet);
  times.className = "quiet-times";
  function time(key, title) {
    const label = el("label", title, times);
    const i = document.createElement("input");
    i.type = "time";
    i.step = "60";
    i.required = true;
    i.id = "bf-config-" + key;
    label.htmlFor = i.id;
    label.append(i);
    controls.set(key, i);
    return i;
  }
  const quietStart = time("shareQuietStartMinute", say("\u5F00\u59CB", "From"));
  el("span", "\u2014", times);
  const quietEnd = time("shareQuietEndMinute", say("\u7ED3\u675F", "Until"));
  const zone = el("small", "", quiet);
  zone.style.display = "block";
  zone.style.paddingBottom = "18px";
  const advanced = el("details", "", fields);
  advanced.className = "card";
  el("summary", say("\u9AD8\u7EA7\u8BBE\u7F6E", "Advanced settings"), advanced);
  toggle(advanced, "automaticReview", say("\u5B8C\u8BFB\u540E\u5199\u8BFB\u540E\u611F", "Write a review after finishing"), say("\u81EA\u4E3B\u9605\u8BFB\u5B8C\u672C\u540E\uFF0C\u7ED9\u5979\u4E00\u6B21\u5199\u8BFB\u540E\u611F\u7684\u673A\u4F1A\u3002", "Offers one review opportunity after automatic completion."));
  toggle(advanced, "allowNetwork", say("\u5141\u8BB8\u8BBF\u95EE\u5C0F\u8BF4\u4E66\u6E90", "Allow novel source requests"), say("\u5173\u95ED\u540E\uFF0C\u4ECD\u53EF\u9605\u8BFB\u5DF2\u7F13\u5B58\u7684\u6B63\u6587\u3002", "Cached text remains available when disabled."));
  select(advanced, "readingMode", say("\u9605\u8BFB\u65B9\u5F0F", "Reading mode"), "", [["auto", say("\u81EA\u52A8\u9009\u62E9", "Automatic")], ["main", say("\u4E3B\u4F1A\u8BDD", "Main session")]]);
  const storeHolder = textInput(advanced, "textStoreDir", say("\u4E66\u7C4D\u5168\u6587\u4FDD\u5B58\u4F4D\u7F6E", "Full-text storage folder"), say("\u53EA\u653E\u5168\u6587\uFF1B\u4E66\u540D\u3001\u8FDB\u5EA6\u548C\u624B\u8D26\u4ECD\u5728\u6570\u636E\u76EE\u5F55\u3002\u7559\u7A7A\u7528\u9ED8\u8BA4\u4F4D\u7F6E\u3002\u5DF2\u6709\u5168\u6587\u5728\u4E0B\u6B21\u542F\u52A8\u6216\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55\u65F6\u590D\u5236\u5230\u65B0\u76EE\u5F55\uFF0C\u65E7\u76EE\u5F55\u4FDD\u7559\u4F5C\u4E3A\u56DE\u9000\uFF0C\u786E\u8BA4\u65B0\u76EE\u5F55\u53EF\u8BFB\u540E\u53EF\u624B\u52A8\u5220\u9664\u3002", "Only full text; titles, progress and history stay in the data folder. Leave blank for default. Existing text is copied on the next start or extension reload; the old folder is kept as a fallback until you remove it."), 500);
  const storeInput = controls.get("textStoreDir");
  storeInput.placeholder = say("\u7559\u7A7A\uFF1A\u6570\u636E\u76EE\u5F55/bookfish/books", "Blank: data folder/bookfish/books");
  storeInput.style.minWidth = "320px";
  const useDefault = el("button", say("\u7528\u9ED8\u8BA4\u4F4D\u7F6E", "Use default"), storeHolder);
  useDefault.type = "button";
  useDefault.onclick = () => {
    storeInput.value = "";
    storeInput.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const storageNote = el("small", "", advanced);
  storageNote.style.display = "block";
  storageNote.style.padding = "0 2px 14px";
  const bar = el("div", "", form);
  bar.className = "save-bar";
  const message = el("p", say("\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026", "Loading settings\u2026"), bar);
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const reset = el("button", say("\u53D6\u6D88\u4FEE\u6539", "Discard changes"), bar);
  reset.type = "button";
  const save = el("button", say("\u4FDD\u5B58\u914D\u7F6E", "Save settings"), bar);
  save.type = "submit";
  save.className = "primary";
  save.disabled = true;
  reset.disabled = true;
  let baseline, dirty = false, saving = false, disposed = false;
  const formatTime = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  const toMinute = (s) => {
    if (!/^\d{2}:\d{2}$/.test(s)) throw Error(say("\u8BF7\u586B\u5199\u6709\u6548\u65F6\u95F4\u3002", "Enter a valid time."));
    const [h, m] = s.split(":").map(Number);
    if (h > 23 || m > 59) throw Error("Invalid time");
    return h * 60 + m;
  };
  function refreshVisibility() {
    custom.hidden = speed.value !== "custom";
    rate.required = !custom.hidden;
    slider.value = rate.value;
    times.hidden = !controls.get("shareQuietEnabled").checked;
    quietStart.required = quietEnd.required = !times.hidden;
  }
  function read() {
    const patch = {};
    for (const [key, c] of controls) {
      if (key === "pace" || key === "readingCharsPerMinute") continue;
      patch[key] = c instanceof HTMLInputElement && c.type === "checkbox" ? c.checked : c instanceof HTMLInputElement && c.type === "number" ? Number(c.value) : key.endsWith("Minute") ? toMinute(c.value) : c.value;
    }
    patch.speed = speed.value === "custom" ? baseline.speed : speed.value;
    patch.readingCharsPerMinute = speed.value === "custom" ? Number(rate.value) : 0;
    return patch;
  }
  function show(data) {
    baseline = { ...BOOKFISH_DEFAULTS, ...data.config };
    const limits = sharingLimits(baseline);
    for (const [key, c] of controls) {
      if (key === "pace") continue;
      const value = baseline[key];
      if (c instanceof HTMLInputElement && c.type === "checkbox") c.checked = value === true;
      else c.value = String(value ?? "");
    }
    if (data.storage) {
      storageNote.className = data.storage.error ? "error" : "settings-help";
      storageNote.textContent = data.storage.error ? say("\u5F53\u524D\u5168\u6587\u76EE\u5F55\u4E0D\u53EF\u7528\uFF0C\u5DF2\u56DE\u9000\u5230\u9ED8\u8BA4\u76EE\u5F55\uFF1A", "Storage folder unavailable; using the default: ") + data.storage.error : say("\u5F53\u524D\u5B9E\u9645\u5168\u6587\u76EE\u5F55\uFF1A", "Current full-text folder: ") + data.storage.dir;
    }
    routineZone.textContent = say("\u6309\u90E8\u7F72\u65F6\u533A ", "Timezone: ") + data.timezone + say("\u6267\u884C\uFF1B\u4F5C\u606F\u65F6\u95F4\u56FA\u5B9A\uFF0C\u65E0\u9700\u8BBE\u7F6E\u3002\u8BFB\u4E66\u95F4\u6B47\u7684\u77ED\u4F11\u606F\u4ECD\u4F1A\u4FDD\u7559\u3002", "; routine hours are fixed. Short reading breaks remain enabled.");
    quietStart.value = formatTime(limits.startMinute);
    quietEnd.value = formatTime(limits.endMinute);
    speed.value = baseline.readingCharsPerMinute ? "custom" : baseline.speed;
    rate.value = String(baseline.readingCharsPerMinute || { slow: 200, normal: 400, fast: 600 }[baseline.speed]);
    zone.textContent = say("\u6309\u90E8\u7F72\u65F6\u533A ", "Timezone: ") + data.timezone + say(" \xB7 \u652F\u6301\u8DE8\u5929\uFF1B\u8D77\u6B62\u76F8\u540C\u4E3A\u5168\u5929\u5B89\u9759\u3002", " \xB7 May cross midnight; equal times mean quiet all day.");
    refreshVisibility();
    dirty = false;
    fields.disabled = false;
    save.disabled = reset.disabled = true;
  }
  function mark() {
    if (!baseline || saving) return;
    dirty = true;
    save.disabled = reset.disabled = false;
    message.className = "";
    message.textContent = say("\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539", "Unsaved changes");
    refreshVisibility();
  }
  form.addEventListener("input", mark, { signal: ctx.signal });
  form.addEventListener("change", mark, { signal: ctx.signal });
  slider.addEventListener("input", () => {
    rate.value = slider.value;
    mark();
  }, { signal: ctx.signal });
  rate.addEventListener("input", () => {
    slider.value = rate.value;
  }, { signal: ctx.signal });
  reset.addEventListener("click", () => {
    if (baseline) {
      show({ config: baseline, timezone: lastTimezone });
      message.textContent = say("\u5DF2\u53D6\u6D88\u4FEE\u6539\u3002", "Changes discarded.");
    }
  }, { signal: ctx.signal });
  let lastTimezone = "";
  async function load() {
    try {
      const data = await ctx.invoke("get", []);
      if (disposed || ctx.signal.aborted) return;
      lastTimezone = data.timezone;
      show(data);
      message.textContent = say("\u914D\u7F6E\u5DF2\u52A0\u8F7D", "Settings loaded");
    } catch (e) {
      if (!disposed) {
        message.textContent = say("\u8BFB\u53D6\u5931\u8D25\uFF1A", "Could not load: ") + String(e);
        message.className = "error";
        const retry = el("button", say("\u91CD\u8BD5", "Retry"), bar);
        retry.type = "button";
        retry.onclick = () => {
          retry.remove();
          void load();
        };
      }
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (saving || !dirty || !baseline || !form.reportValidity()) return;
    void (async () => {
      saving = true;
      save.disabled = reset.disabled = true;
      message.textContent = say("\u6B63\u5728\u4FDD\u5B58\u2026", "Saving\u2026");
      try {
        const all = read(), patch = Object.fromEntries(Object.entries(all).filter(([key, value]) => {
          if (key === "shareQuietStartMinute" || key === "shareQuietEndMinute") {
            const l = sharingLimits(baseline);
            return value !== (key === "shareQuietStartMinute" ? l.startMinute : l.endMinute);
          }
          return value !== baseline[key];
        }));
        fields.disabled = true;
        if (Object.keys(patch).length) {
          const data = await ctx.invoke("save", [patch]);
          if (disposed || ctx.signal.aborted) return;
          lastTimezone = data.timezone;
          show(data);
        } else show({ config: baseline, timezone: lastTimezone });
        message.textContent = "textStoreDir" in patch ? say("\u5DF2\u4FDD\u5B58\u3002\u5168\u6587\u5C06\u5728\u4E0B\u6B21\u542F\u52A8\u6216\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55\u65F6\u590D\u5236\u5230\u65B0\u76EE\u5F55\uFF1B\u65E7\u76EE\u5F55\u4FDD\u7559\u4F5C\u4E3A\u56DE\u9000\uFF0C\u786E\u8BA4\u65B0\u76EE\u5F55\u53EF\u8BFB\u540E\u53EF\u624B\u52A8\u5220\u9664\u3002", "Saved. Full text will be copied on the next start or extension reload; the old folder is kept as a fallback until you remove it.") : say("\u5DF2\u4FDD\u5B58\uFF0C\u4E0B\u6B21\u9605\u8BFB\u4E0E\u5206\u4EAB\u8C03\u5EA6\u4F1A\u4F7F\u7528\u65B0\u914D\u7F6E\u3002", "Saved. Reading and sharing will use these settings.");
        message.className = "";
      } catch (e) {
        if (!disposed) {
          message.textContent = say("\u4FDD\u5B58\u5931\u8D25\uFF0C\u4FEE\u6539\u5DF2\u4FDD\u7559\uFF1A", "Save failed; your edits are preserved: ") + String(e);
          message.className = "error";
          save.disabled = reset.disabled = false;
        }
      } finally {
        saving = false;
        if (!disposed) fields.disabled = false;
      }
    })();
  }, { signal: ctx.signal });
  await load();
  return { dispose() {
    disposed = true;
    runtimeCard.dispose();
  } };
} };

// src/webui/mood.ts
function moodPrefix(label) {
  if (!label) return "";
  const categories = [
    [/不平|愤怒|气愤|生气|恼火|愤慨|不服气|憋.{0,3}气|angry|indignant|outraged/i, "\u{1F620}"],
    [/担心|担忧|紧张|捏.{0,2}汗|忐忑|不安|着急|咯噔|发紧|worried|anxious|nervous/i, "\u{1F61F}"],
    [/怅然|难过|失落|心酸|忧伤|心疼|难受|闷闷|悲伤|心里空|sad|sorrow|melanchol/i, "\u{1F614}"],
    [/逗|好笑|笑|欢乐|amused|funny/i, "\u{1F604}"],
    [/佩服|服气|敬佩|admiration|impressed/i, "\u{1F929}"],
    [/发暖|温暖|感动|warm|moved|touched/i, "\u{1F970}"],
    [/开心|喜悦|高兴|痛快|畅快|happy|joy|delighted/i, "\u{1F60A}"],
    [/惊讶|吃惊|震惊|惊奇|surpris|astonish|shock/i, "\u{1F62F}"],
    [/好奇|疑惑|困惑|curious|puzzled/i, "\u{1F914}"],
    [/期待|兴奋|激动|excited|eager/i, "\u{1F917}"],
    [/平静|安心|放松|释然|calm|relieved|peaceful/i, "\u{1F60C}"]
  ];
  const match = categories.find(([pattern]) => pattern.test(label));
  return match ? match[1] + " " : "";
}

// src/webui/legacy.ts
var legacy_default = {
  panels: {
    status: {
      async mount(ctx) {
        const en = ctx.language !== "zh" && ctx.language !== "zh-Hant";
        const say = (zh, english) => en ? english : zh;
        const sourceLabel = (status2) => en ? status2 : {
          partial: "\u90E8\u5206\u7AE0\u8282\u5DF2\u7F13\u5B58",
          cached: "\u76EE\u5F55\u5185\u7AE0\u8282\u5DF2\u7F13\u5B58",
          needs_login: "\u9700\u8981\u767B\u5F55",
          restricted: "\u7AD9\u70B9\u62D2\u7EDD\u8BBF\u95EE\u6216\u9700\u8981\u9A8C\u8BC1",
          missing: "\u7AE0\u8282\u6216\u5206\u9875\u7F3A\u5931",
          temporary: "\u83B7\u53D6\u6216\u4FDD\u5B58\u6682\u65F6\u5931\u8D25",
          invalid_content: "\u9875\u9762\u7ED3\u6784\u6216\u6B63\u6587\u4E0D\u5339\u914D",
          limit: "\u8FBE\u5230\u7F13\u5B58\u6216\u8BF7\u6C42\u9650\u5236",
          cancelled: "\u83B7\u53D6\u5DF2\u53D6\u6D88",
          unsupported: "\u6682\u672A\u9002\u914D"
        }[status2] ?? status2;
        const section = document.createElement("section");
        section.style.cssText = "max-width:900px;display:grid;gap:16px;padding:8px;line-height:1.6";
        ctx.root.append(section);
        const heading = document.createElement("h2");
        heading.textContent = say("\u4E66\u67B6\u4E0E\u9605\u8BFB\u8FDB\u5EA6", "Library and reading progress");
        section.append(heading);
        const status = document.createElement("p");
        section.append(status);
        const notice = document.createElement("p");
        notice.textContent = say("\u652F\u6301\u672C\u5730\u6587\u4EF6\u3001\u5DF2\u9002\u914D\u7B14\u8DA3\u9601\u94FE\u63A5\u4E0E\u6709\u539F\u6587\u4F9D\u636E\u7684\u9605\u8BFB\u624B\u8D26\u3002\u81EA\u4E3B\u9605\u8BFB\u65B0\u914D\u7F6E\u9ED8\u8BA4\u5F00\u542F\uFF0C\u53EF\u5728\u5BBF\u4E3B\u914D\u7F6E\u4E2D\u8C03\u6574\u3002\u5FC3\u60C5\u548C\u89E3\u91CA\u662F\u6A21\u578B\u81EA\u62A5\uFF1B\u6700\u8FD1\u5FC3\u60C5\u4E0D\u662F\u5B9E\u65F6\u5FC3\u7406\u72B6\u6001\u3002\u6B63\u6587\u4F1A\u4EA4\u7ED9\u5BBF\u4E3B\u6A21\u578B\u3002\u7F13\u5B58\u4E0D\u7B49\u4E8E\u5DF2\u8BFB\u3002", "Supports local files, adapted Biquge links and an evidence-backed reading journal. Automatic reading defaults on for new configurations; use host configuration to adjust. Mood and interpretation are model reports, not live mental state. Text goes to the host model. Cached does not mean read.");
        section.append(notice);
        const schedule = document.createElement("p");
        schedule.setAttribute("aria-label", say("\u81EA\u4E3B\u9605\u8BFB\u72B6\u6001", "Automatic reading status"));
        section.append(schedule);
        const messages = document.createElement("p");
        messages.setAttribute("role", "status");
        section.append(messages);
        const controls = document.createElement("div");
        controls.dataset.bookfish = "controls";
        controls.style.cssText = "display:flex;gap:12px;flex-wrap:wrap";
        section.append(controls);
        const notebook = document.createElement("section");
        notebook.setAttribute("aria-label", say("\u9605\u8BFB\u624B\u8D26", "Reading journal"));
        section.append(notebook);
        const shares = document.createElement("section");
        shares.setAttribute("aria-label", say("\u9605\u8BFB\u5206\u4EAB", "Reading shares"));
        section.append(shares);
        const articles = document.createElement("section");
        articles.setAttribute("aria-label", say("\u5168\u4E66\u8BFB\u540E\u611F", "Full-book reviews"));
        section.append(articles);
        const articleDetail = document.createElement("section");
        articleDetail.style.whiteSpace = "pre-wrap";
        section.append(articleDetail);
        const detail = document.createElement("section");
        detail.setAttribute("aria-label", say("\u611F\u60F3\u4E0E\u539F\u6587\u4F9D\u636E", "Episode and evidence"));
        section.append(detail);
        const shelf = document.createElement("div");
        shelf.dataset.bookfish = "shelf";
        shelf.style.cssText = "display:grid;gap:12px";
        section.append(shelf);
        let disposed = false;
        let working = false;
        let request = 0;
        let shelfRevision = "";
        let state;
        let journalBefore;
        let journalBook;
        let journalRevision = "";
        let shareRevision = "";
        let reviewRevision = "";
        const kindLabel = (kind) => en ? kind : { reading: "\u9605\u8BFB\u5F53\u65F6\u8BB0\u5F55", reflection: "\u73B0\u5728\u91CD\u8BFB\u7684\u53CD\u601D", revision: "\u540E\u7EED\u4FEE\u8BA2\uFF08\u539F\u8BB0\u5F55\u4FDD\u7559\uFF09" }[kind] ?? kind;
        function line(parent, label, value) {
          const p = document.createElement("p");
          p.textContent = `${label}: ${value}`;
          parent.append(p);
        }
        function download(text, filename, mime = "application/json") {
          const url = URL.createObjectURL(new Blob([text], { type: mime }));
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          section.append(link);
          link.click();
          link.remove();
          ctx.timeout(() => URL.revokeObjectURL(url), 1e3);
          ctx.own({ dispose: () => URL.revokeObjectURL(url) });
        }
        async function showReview(id) {
          const data = await ctx.invoke("review", [id]);
          if (disposed || ctx.signal.aborted || data.book.key !== journalBook) return;
          articleDetail.replaceChildren();
          line(articleDetail, `${data.review.title} \xB7 v${data.review.version}`, new Date(data.review.recordedAt).toLocaleString());
          const body = document.createElement("p");
          body.textContent = data.review.text;
          articleDetail.append(body);
          button(say("\u5BFC\u51FA\u8FD9\u7248\u8BFB\u540E\u611F", "Export this review"), async () => {
            download(`# ${data.review.title}

${data.review.text}
`, `bookfish-review-v${data.review.version}.md`, "text/markdown;charset=utf-8");
          }, articleDetail);
          const sources = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = say("\u67E5\u770B\u5199\u4F5C\u4F9D\u636E", "View writing sources");
          sources.append(summary);
          articleDetail.append(sources);
          line(sources, say("\u8D44\u6599\u8986\u76D6", "Material coverage"), JSON.stringify(data.review.coverage));
          line(sources, say("\u611F\u60F3\u7F16\u53F7", "Episode ids"), data.review.episodeIds.join(", ") || say("\u65E0\u65E7\u611F\u60F3", "No prior episodes"));
          for (const evidence of data.evidence) line(sources, `${evidence.chapter} \xB7 ${evidence.segmentId} [${evidence.start},${evidence.end})`, evidence.quote);
          line(sources, say("\u89E3\u91CA\u8FB9\u754C", "Interpretation boundary"), say("\u5F15\u7528\u6821\u9A8C\u4E0D\u8BC1\u660E\u89E3\u91CA\u6216\u5FC3\u7406\u72B6\u6001\uFF1B\u8D44\u6599\u5DF2\u63D0\u4F9B\u4E0D\u7B49\u4E8E\u7406\u89E3\u88AB\u72EC\u7ACB\u9A8C\u8BC1\u3002", "Quote matching does not verify interpretation or mental state; offering material is not proof of understanding."));
          button(say("\u5BFC\u51FA\u5199\u4F5C\u4F9D\u636E\uFF08JSON\uFF09", "Export writing sources (JSON)"), async () => {
            download(JSON.stringify(data, null, 2), `bookfish-review-v${data.review.version}.json`);
          }, sources);
        }
        const searchForm = document.createElement("form");
        section.insertBefore(searchForm, shelf);
        const searchTitle = document.createElement("h3");
        searchTitle.textContent = say("\u56DE\u67E5\u5DF2\u8BFB\u5185\u5BB9", "Search confirmed reading");
        searchForm.append(searchTitle);
        const inputs = ["\u5173\u952E\u8BCD\uFF08\u7A7A\u683C\u5206\u9694\uFF09", "\u4EBA\u7269\u6216\u5DF2\u8BB0\u5F55\u522B\u540D", "\u7AE0\u8282"].map((label, i) => {
          const wrapper = document.createElement("label");
          wrapper.textContent = en ? ["Keywords", "Character / recorded alias", "Chapter"][i] : label;
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 160;
          wrapper.append(input);
          searchForm.append(wrapper);
          return input;
        });
        const searchSubmit = document.createElement("button");
        searchSubmit.type = "submit";
        searchSubmit.textContent = say("\u68C0\u7D22\u5DF2\u8BFB\u8BB0\u5F55", "Search confirmed records");
        searchForm.append(searchSubmit);
        const searchResults = document.createElement("div");
        searchForm.append(searchResults);
        let searchArgs;
        let searchCursor;
        async function searchPage(cursor) {
          const bookKey = journalBook;
          if (!bookKey || !searchArgs) throw new Error(say("\u8BF7\u5148\u9009\u62E9\u4E66\u7C4D\u5E76\u68C0\u7D22\u3002", "Select a book and search first."));
          const result = await ctx.invoke("search", [{ ...searchArgs, bookKey, ...cursor ? { cursor } : {} }]);
          if (disposed || ctx.signal.aborted || journalBook !== bookKey) return;
          searchResults.replaceChildren();
          searchCursor = result.nextCursor ?? void 0;
          line(searchResults, say("\u5339\u914D", "Matches"), `${result.total} \xB7 ${say("\u4EC5\u4E3A\u5B57\u9762\u68C0\u7D22\uFF1B\u96F6\u5339\u914D\u4E0D\u8BC1\u660E\u6CA1\u6709\u76F8\u5173\u5185\u5BB9", "Lexical search; no matches does not prove absence")}`);
          for (const hit of result.items) {
            line(searchResults, `${hit.kind} \xB7 ${hit.id}`, hit.snippet);
            button(say("\u67E5\u770B\u5B8C\u6574\u8BB0\u5F55\u4E0E\u5DF2\u8BFB\u539F\u6587", "View complete records and confirmed source"), async () => {
              const args = hit.kind === "episode" ? { episodeIds: [hit.id] } : hit.kind === "receipt" ? { taskIds: [hit.id] } : { segmentIds: hit.segmentIds };
              const context = await ctx.invoke("context", [{ ...args, bookKey }]);
              if (disposed || ctx.signal.aborted || journalBook !== bookKey) return;
              detail.replaceChildren();
              for (const record of context.accounts) {
                line(detail, say("\u8BB0\u5F55\u4E0E\u65F6\u95F4", "Record / time"), `${record.id} \xB7 ${kindLabel(String(record.kind))} \xB7 ${record.recordedAt}`);
                line(detail, say("\u611F\u60F3", "Interpretation"), String(record.interpretation));
                line(detail, say("\u5F53\u6B21\u81EA\u8FF0\u7406\u7531", "Stated reason"), record.reason === null ? say("\u672A\u8BB0\u5F55\uFF1B\u4E0D\u80FD\u786E\u8BA4\u5F53\u65F6\u7406\u7531", "Not recorded; original reason unknown") : String(record.reason));
                for (const quote of record.evidence) {
                  const block = document.createElement("blockquote");
                  block.textContent = quote.quote;
                  detail.append(block);
                  line(detail, say("\u539F\u6587\u5B9A\u4F4D", "Source anchor"), `${quote.segmentId} \xB7 [${quote.start}, ${quote.end})`);
                }
                button(say("\u67E5\u770B\u539F\u6587\u4F9D\u636E\u4E0E\u7406\u7531", "View evidence and explanation"), () => showEpisode(String(record.id)), detail);
              }
              for (const receipt of context.receipts) {
                line(detail, say("\u7406\u89E3\u56DE\u6267", "Understanding receipt"), String(receipt.understanding));
                line(detail, say("\u7406\u7531", "Reason"), say("\u672A\u5355\u72EC\u8BB0\u5F55\uFF1B\u6709\u611F\u60F3\u94FE\u63A5\u65F6\u4EE5\u5BF9\u5E94\u8BB0\u5F55\u4E3A\u51C6", "Not separately recorded; consult the linked episode if present"));
              }
              for (const source of context.sources) line(detail, `${say("\u5DF2\u8BFB\u539F\u6587", "Confirmed source")} ${source.id}`, String(source.text));
              if (context.omittedCount || context.additionalRelatedRecords || context.additionalSourceSegments) line(detail, say("\u6750\u6599\u672A\u5168\u90E8\u8F7D\u5165", "Incomplete context"), say("\u8BF7\u6309\u68C0\u7D22\u7ED3\u679C\u9010\u6761\u67E5\u770B\u5B8C\u6574\u8BB0\u5F55\uFF1B\u5F53\u524D\u7ED3\u679C\u4E0D\u4EE3\u8868\u5B8C\u6574\u5224\u65AD\u5386\u53F2\u3002", "Open individual search hits; this bundle is not the complete judgment history."));
            }, searchResults);
          }
          if (searchCursor) button(say("\u4E0B\u4E00\u9875\u5339\u914D", "Next matches"), () => searchPage(searchCursor), searchResults);
        }
        searchForm.addEventListener("submit", (event) => {
          event.preventDefault();
          searchArgs = Object.fromEntries(inputs.map((input, i) => [["query", "character", "chapter"][i], input.value.trim()]).filter(([, value]) => value));
          void perform(() => searchPage());
        }, { signal: ctx.signal });
        async function showEpisode(id) {
          const result = await ctx.invoke("episode", [id]);
          if (disposed || ctx.signal.aborted || result.episode.bookKey !== journalBook) return;
          detail.replaceChildren();
          const e = result.episode, content = e.content;
          line(detail, say("\u8BB0\u5F55", "Record"), `${e.id} \xB7 ${kindLabel(e.kind)} \xB7 ${new Date(e.recordedAt).toLocaleString()}`);
          line(detail, say("\u89E6\u53D1\u60C5\u8282\uFF08\u6A21\u578B\u63D0\u53D6\uFF09", "Trigger (model account)"), content.trigger);
          line(detail, say("\u5F53\u6B21\u89E3\u91CA\uFF08\u6A21\u578B\u81EA\u62A5\uFF09", "Reported interpretation"), content.interpretation);
          line(detail, say("\u5148\u524D\u5224\u65AD", "Prior judgment"), content.priorJudgment ?? say("\u672A\u8BB0\u5F55", "Not recorded"));
          line(detail, say("\u7B80\u77ED\u81EA\u8FF0\u7406\u7531", "Stated explanation"), content.reason ?? say("\u672A\u8BB0\u5F55\uFF1B\u4E0D\u80FD\u63A8\u65AD\u5F53\u65F6\u7406\u7531", "Not recorded; do not infer an earlier reason"));
          line(detail, say("\u672C\u6761\u5FC3\u60C5", "Mood in this record"), content.mood ? `${content.mood.label}${content.mood.intensity ? ` (${content.mood.intensity}/5)` : ""}` : say("\u672A\u62A5\u544A\u5FC3\u60C5", "No mood reported"));
          for (const evidence of result.evidence) {
            const quote = document.createElement("blockquote");
            quote.textContent = evidence.quote;
            detail.append(quote);
            line(detail, say("\u539F\u6587\u5B9A\u4F4D", "Source anchor"), `${evidence.chapter} \xB7 ${say("\u6BB5\u843D", "segment")} ${evidence.segmentId} \xB7 [${evidence.start}, ${evidence.end}) \xB7 ${say("\u7248\u672C", "revision")} ${result.book.revision.slice(0, 12)} \xB7 SHA256 ${evidence.segmentHash}`);
            line(detail, say("\u6765\u6E90", "Source"), JSON.stringify(evidence.source));
          }
          line(detail, say("\u8BC1\u636E\u8FB9\u754C", "Evidence boundary"), say("\u4EC5\u6821\u9A8C\u5F15\u7528\u4E0E\u539F\u6587\u5B57\u9762\u4E00\u81F4\uFF1B\u4E0D\u8BC1\u660E\u89E3\u91CA\u3001\u56E0\u679C\u3001\u4EBA\u7269\u8EAB\u4EFD\u6216\u5FC3\u60C5\u4E3A\u771F\u3002", "Exact text matching does not verify interpretation, cause, identity or mood."));
          line(detail, say("\u4EBA\u7269\u4E0E\u522B\u540D\uFF08\u6A21\u578B\u63D0\u53D6\uFF09", "Characters / aliases (model account)"), content.characters.map((c) => `${c.name}${c.aliases.length ? ` (${c.aliases.join(", ")})` : ""}`).join(" \xB7 ") || "\u2014");
          line(detail, say("\u672A\u51B3\u95EE\u9898", "Open questions"), content.questions.join(" \xB7 ") || "\u2014");
          if (e.revises) button(say("\u67E5\u770B\u88AB\u4FEE\u8BA2\u539F\u8BB0\u5F55", "View original record"), () => showEpisode(e.revises), detail);
          for (const id2 of content.relatedEpisodeIds) button(`${say("\u5173\u8054\u8BB0\u5F55", "Related record")} ${id2.slice(0, 8)}`, () => showEpisode(id2), detail);
          for (const revision of result.revisions) button(`${say("\u67E5\u770B\u540E\u7EED\u4FEE\u8BA2", "View revision")} ${new Date(revision.recordedAt).toLocaleString()}`, () => showEpisode(revision.id), detail);
        }
        function renderJournal(journal) {
          const signature = JSON.stringify(journal);
          if (signature === journalRevision) return;
          journalRevision = signature;
          notebook.replaceChildren();
          const title = document.createElement("h3");
          title.textContent = say("\u9605\u8BFB\u8DB3\u8FF9", "Reading journal");
          notebook.append(title);
          const metadata = document.createElement("details"), summary = document.createElement("summary");
          summary.textContent = say("\u8BB0\u5F55\u8303\u56F4\u4E0E\u4EBA\u7269\u7D22\u5F15", "Coverage and character index");
          metadata.append(summary);
          notebook.append(metadata);
          if (!journal) {
            line(metadata, say("\u624B\u8D26", "Journal"), say("\u9009\u4E66\u540E\u67E5\u770B\u3002", "Select a book."));
            return;
          }
          line(metadata, say("\u8BB0\u5F55\u8303\u56F4", "Coverage"), `${journal.total} ${say("\u6761\u8BB0\u5F55", "records")} \xB7 ${journal.rangesWithoutReadingEpisode} ${say("\u4E2A\u5DF2\u8BFB\u6BB5\u843D\u672A\u8BB0\u5F55\u9605\u8BFB\u5F53\u65F6\u7684\u611F\u60F3\uFF1B\u4E0D\u8865\u9020\u5FC3\u60C5", "confirmed ranges without a reading-time episode; no invented mood")}`);
          line(metadata, say("\u6700\u8FD1\u4E00\u6B21\u81EA\u62A5\u5FC3\u60C5", "Last reported mood"), journal.mood ? `${journal.mood.label} \xB7 ${new Date(journal.mood.recordedAt).toLocaleString()} \xB7 ${kindLabel(journal.mood.kind)} \xB7 ${say("\u4E0D\u662F\u5B9E\u65F6\u5FC3\u7406\u72B6\u6001", "not a live mental state")}` : say("\u5C1A\u672A\u62A5\u544A\u5FC3\u60C5", "No mood has been reported"));
          if (journal.mood) button(say("\u67E5\u770B\u5FC3\u60C5\u4F9D\u636E", "View mood evidence"), () => showEpisode(journal.mood.episodeId), metadata);
          line(metadata, say("\u4EBA\u7269\u7D22\u5F15\uFF08\u6A21\u578B\u63D0\u53D6\uFF09", "Character index (model account)"), journal.characters.map((c) => `${c.name}${c.aliases.length ? ` (${c.aliases.join(", ")})` : ""}`).join(" \xB7 ") || "\u2014");
          for (const entry of journal.items) {
            const row = document.createElement("article");
            notebook.append(row);
            line(row, entry.kind === "reading" ? say("\u8BFB\u5230\u8FD9\u91CC\u65F6", "While reading") : say("\u540E\u6765\u53C8\u60F3\u5230\u2026\u2026", "A later thought"), `${new Date(entry.recordedAt).toLocaleString()} \xB7 ${entry.chapters.join(" / ")}`);
            line(row, say("\u8BFB\u5230\u7684\u60C5\u8282", "Plot"), entry.trigger);
            line(row, say("\u5F53\u65F6\u7684\u611F\u60F3", "Her thought"), moodPrefix(entry.mood?.label) + entry.interpretation);
            button(say("\u804A\u804A\u8FD9\u4E00\u6BB5", "Discuss this passage"), async () => {
              row.dispatchEvent(new CustomEvent("bookfish-discuss", { bubbles: true, detail: { id: entry.id, text: entry.interpretation } }));
            }, row);
            button(say("\u67E5\u770B\u539F\u6587\u4F9D\u636E\u4E0E\u7406\u7531", "View evidence and explanation"), () => showEpisode(entry.id), row);
          }
          if (journal.nextBefore) button(say("\u66F4\u65E9\u7684\u8BB0\u5F55", "Earlier records"), async () => {
            journalBefore = journal.nextBefore;
          }, notebook);
          if (journalBefore !== void 0) button(say("\u8FD4\u56DE\u6700\u65B0\u8BB0\u5F55", "Latest records"), async () => {
            journalBefore = void 0;
          }, notebook);
        }
        function button(label, action, parent = controls) {
          const el = document.createElement("button");
          el.type = "button";
          el.textContent = label;
          el.addEventListener("click", () => {
            void perform(action);
          }, { signal: ctx.signal });
          parent.append(el);
          return el;
        }
        async function perform(action) {
          if (working) return;
          working = true;
          messages.textContent = say("\u6B63\u5728\u5904\u7406\u2026", "Working\u2026");
          setDisabled(true);
          try {
            await action();
            if (!disposed) messages.textContent = say("\u64CD\u4F5C\u5B8C\u6210\u3002", "Done.");
          } catch (error) {
            if (!disposed) messages.textContent = String(error);
          } finally {
            working = false;
            if (!disposed) {
              setDisabled(false);
              await refresh();
            }
          }
        }
        function setDisabled(value) {
          section.querySelectorAll("button,input").forEach((control) => {
            control.disabled = value || control.dataset.permanentDisabled === "true";
          });
        }
        const pause = button(say("\u6682\u505C\u9605\u8BFB", "Pause"), async () => {
          await ctx.invoke("pause", [!state?.status.library.paused]);
        });
        button(say("\u8BF7\u6C42\u5199\u4E00\u7248\u5168\u4E66\u8BFB\u540E\u611F", "Request a full-book review"), async () => {
          await ctx.invoke("request_review", []);
        });
        button(say("\u5BFC\u51FA\u5206\u4EAB\u5386\u53F2\uFF08\u5F52\u6863\uFF09", "Export share history (archive)"), async () => {
          const archive = await ctx.invoke("export_shares", []);
          if (!disposed && !ctx.signal.aborted) download(archive, "bookfish-share-history.json");
        });
        button(say("\u7ED3\u675F\u4F11\u606F", "End rest"), async () => {
          await ctx.invoke("resume_rest", []);
        });
        button(say("\u5237\u65B0", "Refresh"), async () => {
          await refresh();
        });
        button(say("\u5BFC\u51FA\u5B8C\u6574\u5907\u4EFD", "Export backup"), async () => {
          const task = await ctx.invoke("backup_begin", []);
          const parts = [];
          let offset = 0;
          try {
            while (offset < task.size) {
              if (disposed || ctx.signal.aborted) throw Error("Cancelled");
              const chunk = await ctx.invoke("backup_read", [task.id, offset]);
              if (chunk.nextOffset <= offset) throw Error("Backup transfer stalled");
              parts.push(Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0)));
              offset = chunk.nextOffset;
              messages.textContent = say("\u5907\u4EFD\u4E0B\u8F7D ", "Downloading backup ") + Math.round(offset / task.size * 100) + "%";
            }
          } finally {
            if (!ctx.signal.aborted) await ctx.invoke("transfer_cancel", [task.id]);
          }
          if (disposed || ctx.signal.aborted) return;
          const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = "bookfish-backup.bfbak";
          section.append(link);
          link.click();
          link.remove();
          ctx.timeout(() => URL.revokeObjectURL(url), 1e3);
          ctx.own({ dispose: () => URL.revokeObjectURL(url) });
        });
        const form = document.createElement("form");
        form.style.cssText = "display:grid;gap:8px;border-top:1px solid #8886;padding-top:12px";
        section.append(form);
        function field(label, type) {
          const wrapper = document.createElement("label");
          wrapper.textContent = label;
          const input = document.createElement("input");
          input.type = type;
          wrapper.append(input);
          form.append(wrapper);
          return input;
        }
        const importStatus = document.createElement("section");
        importStatus.dataset.bookfish = "import-status";
        importStatus.hidden = true;
        section.append(importStatus);
        const importText = document.createElement("p"), importProgress = document.createElement("progress"), cancelImport = document.createElement("button");
        importProgress.max = 100;
        importProgress.setAttribute("aria-label", say("\u5BFC\u5165\u8FDB\u5EA6", "Import progress"));
        cancelImport.type = "button";
        cancelImport.textContent = say("\u53D6\u6D88\u5BFC\u5165", "Cancel import");
        importStatus.append(importText, importProgress, cancelImport);
        let uploadId, selectedImportId, cancelledUpload = false;
        cancelImport.addEventListener("click", () => {
          void (async () => {
            if (!uploadId) return;
            cancelledUpload = true;
            cancelImport.disabled = true;
            try {
              await ctx.invoke("transfer_cancel", [uploadId]);
              importText.textContent = say("\u5DF2\u53D6\u6D88\u5BFC\u5165\uFF0C\u4E66\u67B6\u4FDD\u6301\u539F\u6837\u3002", "Import cancelled; bookshelf unchanged.");
            } catch (e) {
              importText.textContent = String(e);
            } finally {
              await refreshImport();
            }
          })();
        }, { signal: ctx.signal });
        async function refreshImport() {
          try {
            const job = await ctx.invoke("transfer_status", []);
            if (disposed || ctx.signal.aborted || !job) return;
            uploadId = job.id;
            importStatus.hidden = false;
            importProgress.value = job.percent;
            if (job.state === "done" && job.id === selectedImportId && job.result?.book) {
              metadataResult.hidden = false;
              metadataTitle.textContent = job.result.book.title;
              metadataAuthor.textContent = job.result.book.author || say("\u672A\u8BC6\u522B\u5230\u4F5C\u8005", "Author not found");
            }
            const labels = { normalize: say("\u6B63\u5728\u6574\u7406\u6B63\u6587", "Normalizing text"), index: say("\u6B63\u5728\u5EFA\u7ACB\u7AE0\u8282\u7D22\u5F15", "Building chapter index"), validate: say("\u6B63\u5728\u5B8C\u6574\u6821\u9A8C\u6B63\u6587", "Validating source"), commit: say("\u6B63\u5728\u52A0\u5165\u4E66\u67B6", "Adding to bookshelf") };
            importText.textContent = job.state === "done" ? job.result?.duplicate ? say("\u8FD9\u4E2A\u7248\u672C\u5DF2\u5728\u4E66\u67B6\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u7559\u3002", "Revision already exists; progress preserved.") : say("\u5BFC\u5165\u5B8C\u6210\uFF0C\u5DF2\u52A0\u5165\u4E66\u67B6\u3002", "Import complete; added to bookshelf.") : job.state === "failed" ? say("\u5BFC\u5165\u5931\u8D25\uFF1A", "Import failed: ") + job.error : job.state === "cancelled" ? say("\u5DF2\u53D6\u6D88\u5BFC\u5165\u3002", "Import cancelled.") : (labels[job.stage] ?? job.stage) + " \xB7 " + job.percent + "%";
            cancelImport.hidden = !["processing", "committing"].includes(job.state);
            cancelImport.disabled = job.state !== "processing";
          } catch (e) {
            if (!disposed) importText.textContent = say("\u6682\u65F6\u65E0\u6CD5\u67E5\u8BE2\u5BFC\u5165\u8FDB\u5EA6\uFF0C\u53EF\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002", "Progress unavailable; refresh to retry.");
          }
        }
        async function uploadFile(selected, kind, meta) {
          const task = await ctx.invoke("upload_begin", [{ ...meta, kind, size: selected.size }]);
          uploadId = task.id;
          cancelledUpload = false;
          if (kind === "book") {
            selectedImportId = task.id;
            importStatus.hidden = false;
            cancelImport.hidden = false;
            cancelImport.disabled = false;
            importText.textContent = say("\u6B63\u5728\u4E0A\u4F20\u6B63\u6587\u2026", "Uploading source\u2026");
            importProgress.value = 0;
          }
          try {
            for (let offset = 0; offset < selected.size; offset += task.chunkBytes) {
              if (disposed || ctx.signal.aborted || cancelledUpload) throw Error("Cancelled");
              const bytes = new Uint8Array(await selected.slice(offset, offset + task.chunkBytes).arrayBuffer());
              let binary = "";
              for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
              const ack = await ctx.invoke("upload_chunk", [task.id, offset, btoa(binary)]);
              if (ack.offset !== offset + bytes.length) throw Error("Upload acknowledgement mismatch");
              messages.textContent = say("\u6B63\u5728\u4E0A\u4F20 ", "Uploading ") + Math.round(ack.offset / selected.size * 100) + "%";
              if (kind === "book") {
                importText.textContent = messages.textContent;
                importProgress.value = Math.round(ack.offset / selected.size * 100);
              }
            }
            messages.textContent = say("\u6B63\u5728\u6821\u9A8C\u6B63\u6587\u4E0E\u5EFA\u7ACB\u7D22\u5F15\u2026", "Validating text and building index\u2026");
            if (cancelledUpload) throw Error("Cancelled");
            const started = await ctx.invoke("upload_finish", [task.id]);
            if (kind === "book") await refreshImport();
            return started.state === "done" ? started.result : started;
          } catch (error) {
            if (!ctx.signal.aborted) await ctx.invoke("transfer_cancel", [task.id]).catch(() => {
            });
            throw error;
          }
        }
        const file = field(say("\u5C0F\u8BF4\u6587\u4EF6\uFF08UTF-8 TXT / Markdown\uFF0C\u6700\u5927100 MiB\uFF09", "Novel file (UTF-8 TXT / Markdown, up to 100 MiB)"), "file");
        file.accept = ".txt,.md";
        file.required = true;
        const metadataResult = document.createElement("section");
        metadataResult.className = "import-metadata";
        metadataResult.hidden = true;
        metadataResult.setAttribute("aria-label", say("\u5C0F\u8BF4\u8BC6\u522B\u7ED3\u679C", "Detected book metadata"));
        form.append(metadataResult);
        const metadataTitle = document.createElement("p"), metadataAuthor = document.createElement("p");
        const titleLabel = document.createElement("strong");
        titleLabel.textContent = say("\u8BC6\u522B\u4E66\u540D", "Detected title");
        const authorLabel = document.createElement("strong");
        authorLabel.textContent = say("\u8BC6\u522B\u4F5C\u8005", "Detected author");
        metadataResult.append(titleLabel, metadataTitle, authorLabel, metadataAuthor);
        const hint = document.createElement("small");
        hint.textContent = say("\u9009\u62E9\u5C0F\u8BF4\u6587\u4EF6\u540E\u5BFC\u5165\uFF0C\u4E66\u540D\u548C\u4F5C\u8005\u5C06\u4ECE\u6587\u4EF6\u5F00\u5934\u6216\u6587\u4EF6\u540D\u81EA\u52A8\u8BC6\u522B\uFF1B\u6CA1\u6709\u4F5C\u8005\u4FE1\u606F\u65F6\u663E\u793A\u672A\u8BC6\u522B\uFF0C\u4E0D\u731C\u6D4B\u3002", "Choose a novel file to import. Title and author are detected from its header or filename; missing authors remain unknown.");
        form.append(hint);
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = say("\u5BFC\u5165\u4E66\u67B6", "Import");
        submit.disabled = true;
        submit.dataset.permanentDisabled = "true";
        form.append(submit);
        file.addEventListener("change", () => {
          selectedImportId = void 0;
          metadataResult.hidden = true;
          submit.disabled = !file.files?.[0];
          submit.dataset.permanentDisabled = String(!file.files?.[0]);
        }, { signal: ctx.signal });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void perform(async () => {
            const selected = file.files?.[0];
            if (!selected || selected.size > 100 * 1024 * 1024) throw new Error(say("\u8BF7\u9009\u62E9\u4E0D\u8D85\u8FC7100 MiB\u7684\u5C0F\u8BF4\u6587\u4EF6\u3002", "Select a novel up to 100 MiB."));
            const result = await uploadFile(selected, "book", { filename: selected.name, autoMetadata: true });
            if (result.duplicate) throw new Error(say("\u8FD9\u4E2A\u7248\u672C\u5DF2\u5728\u4E66\u67B6\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u7559\u3002", "This revision is already in the library; progress is preserved."));
          });
        }, { signal: ctx.signal });
        const recovery = document.createElement("label");
        recovery.textContent = say("\u6062\u590D\u5907\u4EFD\uFF08\u4EC5\u5141\u8BB8\u7A7A\u4E66\u67B6\uFF1B\u5907\u4EFD\u5305\u542B\u5C0F\u8BF4\u6B63\u6587\uFF09", "Restore backup (empty library only; includes book text)");
        section.append(recovery);
        const backupFile = document.createElement("input");
        backupFile.type = "file";
        backupFile.accept = ".json,.bfbak";
        recovery.append(backupFile);
        button(say("\u6062\u590D\u5230\u7A7A\u4E66\u67B6", "Restore to empty library"), async () => {
          const selected = backupFile.files?.[0];
          if (!selected || selected.size > 1024 * 1024 * 1024) throw new Error(say("\u8BF7\u9009\u62E9\u4E0D\u8D85\u8FC71 GiB\u7684\u5907\u4EFD\u3002", "Select a backup up to 1 GiB."));
          if (selected.name.toLowerCase().endsWith(".json")) {
            if (selected.size > 25 * 1024 * 1024) throw Error("Legacy JSON backup must be at most 25 MiB; use .bfbak for large libraries");
            const text = await selected.text();
            if (!disposed && !ctx.signal.aborted) await ctx.invoke("restore", [text]);
          } else await uploadFile(selected, "backup", { filename: selected.name });
        }, section);
        const remoteForm = document.createElement("form");
        remoteForm.style.cssText = "display:grid;gap:8px;border-top:1px solid #8886;padding-top:12px";
        section.append(remoteForm);
        const urlLabel = document.createElement("label");
        urlLabel.textContent = say("\u94FE\u63A5\u83B7\u53D6\uFF08\u76EE\u524D\u4EC5\u652F\u6301\u7B14\u8DA3\u9601\uFF09\uFF1A", "Link fetch (Biquge only): ");
        const siteLink = document.createElement("a");
        siteLink.href = "https://www.02345.cc/";
        siteLink.target = "_blank";
        siteLink.rel = "noreferrer";
        siteLink.textContent = "www.02345.cc";
        siteLink.className = "source-site";
        urlLabel.append(siteLink);
        const urlInput = document.createElement("input");
        urlInput.type = "url";
        urlInput.required = true;
        urlInput.maxLength = 2e3;
        urlInput.placeholder = "https://www.02345.cc/\u2026/";
        urlLabel.append(urlInput);
        remoteForm.append(urlLabel);
        const example = document.createElement("small");
        example.textContent = say("\u7F51\u5740\u793A\u4F8B\uFF08\u300A\u897F\u6E38\u8BB0\u300B\u76EE\u5F55\uFF09\uFF1Ahttps://www.02345.cc/xiyouji/", "Example (Journey to the West): https://www.02345.cc/xiyouji/");
        remoteForm.append(example);
        const useExample = document.createElement("button");
        useExample.type = "button";
        useExample.textContent = say("\u586B\u5165\u793A\u4F8B", "Use example");
        useExample.onclick = () => {
          urlInput.value = "https://www.02345.cc/xiyouji/";
          urlInput.focus();
        };
        remoteForm.append(useExample);
        const sourceResult = document.createElement("div");
        sourceResult.className = "source-result";
        sourceResult.setAttribute("role", "status");
        sourceResult.setAttribute("aria-live", "polite");
        remoteForm.append(sourceResult);
        const resolve = document.createElement("button");
        resolve.type = "submit";
        resolve.textContent = say("\u68C0\u6D4B\u94FE\u63A5\u80FD\u5426\u83B7\u53D6\u6B63\u6587", "Check source readability");
        remoteForm.append(resolve);
        const remoteHelp = document.createElement("p");
        remoteHelp.textContent = say("\u4F1A\u8BBF\u95EE\u76EE\u5F55\u4E0E\u9996\u7AE0\u7684\u5168\u90E8\u5206\u9875\uFF0C\u5176\u4F59\u7AE0\u8282\u6309\u9700\u83B7\u53D6\u3002\u9700\u767B\u5F55\u3001\u9A8C\u8BC1\u6216\u7F3A\u7AE0\u65F6\u4F1A\u505C\u6B62\uFF0C\u4E0D\u8DF3\u8FC7\u3002\u76EE\u5F55\u53D8\u5316\u5F62\u6210\u65B0\u7248\u672C\uFF1B\u4E2D\u95F4\u7AE0\u8282\u94FE\u63A5\u4E5F\u4ECE\u7B2C\u4E00\u7AE0\u5F00\u59CB\u3002", "Loads the complete catalog and all pages of the first chapter, then fetches on demand. Login, verification and missing pages stop retrieval. Changed catalogs create new revisions; a middle-chapter link still starts from chapter one.");
        remoteForm.append(remoteHelp);
        remoteForm.addEventListener("submit", (event) => {
          event.preventDefault();
          if (resolve.disabled) return;
          void perform(async () => {
            resolve.disabled = true;
            useExample.disabled = true;
            urlInput.readOnly = true;
            resolve.textContent = say("\u6B63\u5728\u68C0\u6D4B\u2026", "Checking\u2026");
            sourceResult.setAttribute("aria-busy", "true");
            sourceResult.textContent = say("\u6B63\u5728\u8FDE\u63A5\u4E66\u6E90\uFF0C\u8BFB\u53D6\u76EE\u5F55\u4E0E\u9996\u7AE0\u5206\u9875\uFF0C\u8BF7\u7A0D\u5019\u3002\u68C0\u6D4B\u6210\u529F\u524D\u4E0D\u4F1A\u52A0\u5165\u4E66\u67B6\u3002", "Connecting and checking the catalog and first chapter pages. Nothing is imported until confirmed.");
            const progress = document.createElement("progress");
            progress.setAttribute("aria-label", say("\u94FE\u63A5\u68C0\u6D4B\u8FDB\u884C\u4E2D", "Source check in progress"));
            sourceResult.append(progress);
            try {
              const preview = await ctx.invoke("detect", [urlInput.value]);
              if (disposed || ctx.signal.aborted) return;
              sourceResult.replaceChildren();
              line(sourceResult, say("\u68C0\u6D4B\u6210\u529F", "Check succeeded"), preview.title + " \xB7 " + preview.note);
              button(say("\u786E\u8BA4\u52A0\u5165\u4E66\u67B6", "Add to library"), async () => {
                await ctx.invoke("accept_source", [preview.token]);
                sourceResult.textContent = say("\u5DF2\u52A0\u5165\u4E66\u67B6\u3002", "Added to library.");
              }, sourceResult);
            } catch (error) {
              sourceResult.textContent = say("\u68C0\u6D4B\u5931\u8D25\uFF1A\u65E0\u6CD5\u83B7\u53D6\u6B63\u6587\uFF0C\u94FE\u63A5\u5DF2\u4FDD\u7559\uFF1B\u53EF\u91CD\u8BD5\u6216\u6539\u7528\u6587\u4EF6\u5BFC\u5165\u3002", "Check failed. URL preserved; retry or import a file.");
              throw error;
            } finally {
              resolve.disabled = false;
              useExample.disabled = false;
              urlInput.readOnly = false;
              sourceResult.setAttribute("aria-busy", "false");
              resolve.textContent = say("\u68C0\u6D4B\u94FE\u63A5\u80FD\u5426\u83B7\u53D6\u6B63\u6587", "Check source readability");
            }
          });
        }, { signal: ctx.signal });
        button(say("\u91CD\u8BD5\u5F53\u524D\u7F3A\u5931\u7AE0\u8282", "Retry current missing chapter"), async () => {
          await ctx.invoke("fetch", []);
        }, remoteForm);
        async function refresh() {
          const revision = ++request;
          try {
            const received = await ctx.invoke("get", []);
            if (disposed || ctx.signal.aborted || revision !== request) return;
            state = received;
            const lib = state.status.library;
            const current = lib.current;
            if (journalBook !== current?.key) {
              journalBook = current?.key;
              journalBefore = void 0;
              detail.replaceChildren();
              articleDetail.replaceChildren();
              journalRevision = "";
              searchResults.replaceChildren();
              searchArgs = void 0;
              searchCursor = void 0;
            }
            if (journalBefore !== void 0 && current) {
              const page = await ctx.invoke("journal", [{ bookKey: current.key, before: journalBefore, limit: 5 }]);
              if (disposed || ctx.signal.aborted || revision !== request) return;
              state.journal = page;
            }
            renderJournal(state.journal);
            if (JSON.stringify(state.reviews) !== reviewRevision) {
              reviewRevision = JSON.stringify(state.reviews);
              articles.replaceChildren();
              const title = document.createElement("h3");
              title.textContent = say("\u5168\u4E66\u8BFB\u540E\u611F\u4E0E\u7248\u672C", "Full-book review versions");
              articles.append(title);
              line(articles, say("\u5B8C\u8BFB\u5224\u5B9A", "Completion"), state.reviews?.complete ? say("\u672C\u7248\u672C\u5168\u4E66\u5DF2\u8FDE\u7EED\u786E\u8BA4\u5B8C\u6210", "This finished revision is continuously confirmed complete") : say("\u5C1A\u672A\u5B8C\u6210\uFF0C\u9636\u6BB5\u611F\u60F3\u4E0D\u80FD\u4F5C\u4E3A\u5168\u4E66\u8BFB\u540E\u611F", "Incomplete; a stage reaction is not a full-book review"));
              for (const job of state.reviews?.jobs.slice(-5).reverse() ?? []) {
                line(articles, say("\u4EFB\u52A1", "Job"), `${job.id} \xB7 ${job.status} \xB7 ${job.error ?? ""}`);
                if (job.status === "pending") button(say("\u53D6\u6D88\u8FD9\u6B21\u6587\u7AE0\u4EFB\u52A1", "Cancel this article job"), async () => {
                  await ctx.invoke("cancel_review", [job.id]);
                }, articles);
              }
              for (const v of [...state.reviews?.versions ?? []].reverse()) button(`v${v.version} \xB7 ${v.title}`, () => showReview(v.id), articles);
            }
            const sharing = state.status.sharing;
            if (sharing && JSON.stringify(sharing) !== shareRevision) {
              shareRevision = JSON.stringify(sharing);
              shares.replaceChildren();
              const title = document.createElement("h3");
              title.textContent = say("\u9605\u8BFB\u5206\u4EAB\u5019\u9009\u4E0E\u8F93\u51FA\u8BB0\u5F55", "Reading share candidates and output");
              shares.append(title);
              line(shares, say("\u4E3B\u52A8\u5206\u4EAB", "Automatic shares"), `${sharing.enabled ? say("\u5F00\u542F", "On") : say("\u5173\u95ED", "Off")} \xB7 ${sharing.reason} \xB7 ${say("\u5C1D\u8BD5", "attempts")} ${sharing.budget.attempts} \xB7 ${sharing.timezone}`);
              line(shares, say("\u8F93\u51FA\u8FB9\u754C", "Output evidence"), say("\u5DE5\u5177\u62A5\u544A\u5DF2\u63A5\u6536\u4E0D\u7B49\u4E8E\u5DF2\u663E\u793A\uFF1B\u53EA\u6709\u4F60\u786E\u8BA4\u770B\u89C1\u624D\u6807\u4E3A\u5DF2\u76EE\u51FB\u3002\u6700\u8FD120\u6761\uFF1B\u5B8C\u6574\u5386\u53F2\u4E0E\u9884\u7B97\u4E0D\u5728\u4E66\u67B6\u5907\u4EFD\u4E2D\u3002", "Tool acceptance is not proven display; only your confirmation marks it witnessed. Latest 20; history/budget are outside library backups."));
              const labels = { candidate: "\u5F85\u9009\u5206\u4EAB", reserved: "\u5DF2\u9884\u7559\u5C1D\u8BD5\uFF0C\u8F93\u51FA\u672A\u786E\u8BA4", accepted: "\u5DE5\u5177\u62A5\u544A\u5DF2\u63A5\u6536\uFF08\u672A\u8BC1\u660E\u663E\u793A\uFF09", unknown: "\u8F93\u51FA\u672A\u77E5\uFF0C\u4E0D\u81EA\u52A8\u91CD\u8BD5", unavailable: "\u8F93\u51FA\u4E0D\u53EF\u7528\uFF0C\u4FDD\u7559\u624B\u8D26", dropped: "\u5DF2\u653E\u5F03\u6216\u8FC7\u671F" };
              for (const item of sharing.items) {
                const row = document.createElement("article");
                shares.append(row);
                line(row, item.visibleAt ? say("\u7528\u6237\u5DF2\u76EE\u51FB", "User witnessed") : en ? item.state : labels[item.state], `${item.text} \xB7 ${new Date(item.createdAt).toLocaleString()}`);
                line(row, say("\u8BE6\u60C5", "Details"), `${item.note}${item.receipt ? ` \xB7 ${item.receipt}` : ""}`);
                if (item.state === "candidate") button(say("\u653E\u5F03\u8FD9\u6761\u5206\u4EAB", "Dismiss this share"), async () => {
                  await ctx.invoke("share_drop", [item.id]);
                }, row);
                if (["accepted", "unknown", "reserved"].includes(item.state) && !item.visibleAt) button(say("\u6211\u5DF2\u770B\u5230\u8FD9\u6761\u5206\u4EAB", "I saw this share"), async () => {
                  await ctx.invoke("share_visible", [item.id]);
                }, row);
              }
            }
            status.textContent = current ? `${current.title} \xB7 ${current.chapter} \xB7 ${(current.progress * 100).toFixed(1)}% ${current.source ? say("\uFF08\u7AE0\u8282\u8FDB\u5EA6\uFF09", "(chapters)") : ""} \xB7 ${say("\u5DF2\u786E\u8BA4", "Confirmed")} ${current.confirmedSegments}/${current.totalSegments} ${current.source ? say("\u4E2A\u7F13\u5B58\u6BB5\u843D", "cached segments") : ""} \xB7 ${say("\u5DF2\u63D0\u4F9B\u6B63\u6587", "Provided text")} ${lib.providedChars}/${current.totalChars} ${current.source ? say("\u4E2A\u7F13\u5B58\u5B57\u7B26", "cached characters") : ""} \xB7 ${lib.paused ? say("\u5DF2\u6682\u505C", "Paused") : say("\u53EF\u7EE7\u7EED", "Ready")}${current.source?.error ? ` \xB7 ${sourceLabel(current.source.error.code)}: ${current.source.error.message}` : ""}` : say("\u5C1A\u672A\u9009\u62E9\u4E66\u7C4D\u3002\u5BFC\u5165\u540E\u70B9\u51FB\u201C\u5F00\u59CB\u8BFB\u8FD9\u672C\u201D\u3002", "No book selected. Import and select a book.");
            pause.textContent = lib.paused ? say("\u7EE7\u7EED\u9605\u8BFB", "Resume") : say("\u6682\u505C\u9605\u8BFB", "Pause");
            const run = state.status.scheduler;
            const reasons = { routine: "\u6309\u4F5C\u606F\u6682\u505C\u9605\u8BFB", stopped: "\u672A\u8FD0\u884C", waiting_for_host_idle: "\u7B49\u5F85\u5BBF\u4E3B\u62A5\u544A\u7A7A\u95F2", disabled: "\u81EA\u4E3B\u9605\u8BFB\u672A\u5F00\u542F", paused: "\u5DF2\u6682\u505C", no_book: "\u5C1A\u672A\u9009\u4E66", complete: "\u5DF2\u5168\u90E8\u786E\u8BA4", resting: "\u6B63\u5728\u4F11\u606F", daily_goal: "\u4ECA\u5929\u7684\u7AE0\u8282\u76EE\u6807\u5DF2\u5B8C\u6210", chapter_goal_unavailable: "\u672C\u4E66\u7AE0\u8282\u672A\u8BC6\u522B\uFF0C\u65E0\u6CD5\u6309\u7AE0\u5B89\u6392", awaiting_model: "\u7B49\u5F85\u6A21\u578B\u5904\u7406", chat_priority: "\u804A\u5929\u4F18\u5148\uFF0C\u7B49\u5F85\u7A7A\u95F230\u79D2", waiting: "\u7B49\u5F85\u4E0B\u6B21\u673A\u4F1A", failed: "\u8FD0\u884C\u5931\u8D25" };
            schedule.textContent = `${say("\u81EA\u4E3B\u9605\u8BFB", "Automatic reading")}: ${en ? run.reason : reasons[run.reason] ?? run.reason} \xB7 ${state.status.selectedMode} \xB7 ${say("\u4ECA\u65E5\u63D0\u4F9B", "Supplied today")} ${run.budget.tasks} ${say("\u6BB5", "tasks")}, ${run.budget.chars} ${say("\u5B57\u7B26", "characters")} \xB7 ${say("\u4E0B\u6B21\u6700\u65E9", "Next earliest")} ${run.nextAt ? new Date(run.nextAt).toLocaleString() : "\u2014"}${run.error ? ` \xB7 ${run.error}` : ""}`;
            const signature = JSON.stringify([state.books, current?.key]);
            if (signature === shelfRevision) {
              if (working) setDisabled(true);
              return;
            }
            shelfRevision = signature;
            shelf.replaceChildren();
            let group = "";
            for (const book of [...state.books].sort((a, b) => (a.key === current?.key ? 0 : a.complete ? 2 : 1) - (b.key === current?.key ? 0 : b.complete ? 2 : 1))) {
              const nextGroup = book.key === current?.key ? say("\u6B63\u5728\u8BFB", "Reading") : book.complete ? say("\u5DF2\u8BFB\u5B8C", "Finished") : say("\u51C6\u5907\u8BFB", "To read");
              if (group !== nextGroup) {
                group = nextGroup;
                const heading2 = document.createElement("h3");
                heading2.textContent = group;
                shelf.append(heading2);
              }
              const card = document.createElement("article");
              card.style.cssText = "display:grid;gap:8px";
              shelf.append(card);
              const name = document.createElement("strong");
              name.textContent = `${book.title}${book.author ? ` \xB7 ${book.author}` : ""}`;
              card.append(name);
              button(say("\u67E5\u770B\u8FD9\u672C\u4E66", "View this book"), async () => {
                card.dispatchEvent(new CustomEvent("bookfish-book", { bubbles: true, detail: { key: book.key } }));
              }, card);
              const pages = document.createElement("p");
              pages.textContent = say("\u5DF2\u8BFB ", "Read ") + Math.ceil(book.confirmedChars / 600) + (book.source && book.source.cachedChapters !== book.source.totalChapters ? say(" \u9875 \xB7 \u6B63\u6587\u672A\u5B8C\u6574\u83B7\u53D6\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u603B\u9875\u6570", " pages \xB7 Total unknown") : " / " + Math.ceil(book.totalChars / 600) + say(" \u9875", " pages"));
              card.append(pages);
              const maintenance = document.createElement("details");
              const more = document.createElement("summary");
              more.textContent = say("\u4E66\u7C4D\u8BE6\u60C5\u4E0E\u7BA1\u7406", "Book details and management");
              maintenance.append(more);
              card.append(maintenance);
              const description = document.createElement("p");
              description.textContent = `${say("\u7248\u672C", "Revision")} ${book.revision.slice(0, 8)} \xB7 ${book.totalChars} ${book.source ? say("\u7F13\u5B58\u5B57\u7B26", "cached characters") : say("\u5B57\u7B26", "characters")} \xB7 ${(book.progress * 100).toFixed(1)}% \xB7 ${book.source ? `${say("\u5DF2\u8BFB\u7AE0\u8282", "Confirmed chapters")} ${book.source.confirmedChapters}/${book.source.totalChapters} \xB7 ${say("\u5DF2\u7F13\u5B58", "Cached")} ${book.source.cachedChapters}` : `${book.confirmedSegments}/${book.totalSegments}`}${book.complete ? say(" \xB7 \u672C\u7248\u672C\u5168\u90E8\u6B63\u6587\u5DF2\u786E\u8BA4", " \xB7 All text in this revision confirmed") : ""}`;
              maintenance.append(description);
              if (book.source) {
                const publication = book.source.publicationStatus === "finished" ? say("\u7AD9\u70B9\u6807\u6CE8\u5B8C\u672C", "Source says finished") : book.source.publicationStatus === "ongoing" ? say("\u7AD9\u70B9\u6807\u6CE8\u8FDE\u8F7D", "Source says ongoing") : say("\u5B8C\u7ED3\u72B6\u6001\u672A\u77E5", "Publication status unknown");
                const origin = document.createElement("p");
                origin.textContent = `${book.source.bookUrl} \xB7 ${sourceLabel(book.source.status)} \xB7 ${publication}${book.source.error ? ` \xB7 ${book.source.error.message}` : ""}`;
                maintenance.append(origin);
              }
              const meter = document.createElement("progress");
              meter.max = 1;
              meter.value = book.progress;
              meter.setAttribute("aria-label", say("\u5DF2\u786E\u8BA4\u9605\u8BFB\u8FDB\u5EA6", "Confirmed reading progress"));
              maintenance.append(meter);
              const select = button(current?.key === book.key ? say("\u5F53\u524D\u4E66\u7C4D", "Selected") : say("\u5F00\u59CB\u8BFB\u8FD9\u672C", "Select book"), async () => {
                await ctx.invoke("select", [book.key]);
              }, card);
              select.disabled = working || current?.key === book.key;
              select.dataset.permanentDisabled = String(current?.key === book.key);
              const approval = document.createElement("label");
              const check = document.createElement("input");
              check.type = "checkbox";
              approval.append(check, document.createTextNode(say("\u786E\u8BA4\u5220\u9664\u6B64\u7248\u672C\u53CA\u5176\u8FDB\u5EA6", "Confirm removal of this revision and progress")));
              maintenance.append(approval);
              button(say("\u5220\u9664", "Remove"), async () => {
                if (!check.checked) throw new Error(say("\u8BF7\u5148\u52FE\u9009\u5220\u9664\u786E\u8BA4\u3002", "Check the removal confirmation first."));
                await ctx.invoke("remove", [book.key]);
              }, maintenance);
            }
            if (working) setDisabled(true);
          } catch (error) {
            if (!disposed && !ctx.signal.aborted && revision === request) messages.textContent = String(error);
          }
        }
        section.append(searchForm);
        await refresh();
        await refreshImport();
        ctx.interval(() => {
          if (!working) {
            void refresh();
            void refreshImport();
          }
        }, 5e3);
        return { dispose() {
          disposed = true;
          request++;
        } };
      }
    }
  }
};

// src/webui/reader.ts
function readerPanel(ctx, parent, back) {
  const en = ctx.language !== "zh" && ctx.language !== "zh-Hant", say = (zh, enText) => en ? enText : zh;
  const node = (tag, text = "", into = parent) => {
    const n = document.createElement(tag);
    n.textContent = text;
    into.append(n);
    return n;
  };
  const top = node("div");
  top.className = "reader-toolbar";
  const btn = (text, fn, into = top) => {
    const b = node("button", text, into);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  btn(say("\u2190 \u4E66\u7C4D\u8BE6\u60C5", "\u2190 Book details"), back);
  const directory = node("details");
  directory.className = "reader-directory";
  node("summary", say("\u76EE\u5F55", "Contents"), directory);
  const list = node("div", "", directory);
  const font = node("select", "", top);
  font.setAttribute("aria-label", say("\u6B63\u6587\u5B57\u53F7", "Text size"));
  for (const size of [18, 20, 24, 28]) {
    const o = node("option", size + " px", font);
    o.value = String(size);
  }
  font.value = String(ctx.memo?.get("reader-font", 20) ?? 20);
  const theme = node("select", "", top);
  theme.setAttribute("aria-label", say("\u9605\u8BFB\u80CC\u666F", "Reading background"));
  for (const [value, label] of [["paper", "\u7EB8\u5F20"], ["green", "\u62A4\u773C"], ["night", "\u591C\u95F4"]]) {
    const o = node("option", en ? value : label, theme);
    o.value = value;
  }
  theme.value = ctx.memo?.get("reader-theme", "paper") ?? "paper";
  const notice = node("p");
  notice.setAttribute("role", "status");
  const article = node("article");
  article.className = "reader-text";
  article.tabIndex = -1;
  const foot = node("div");
  foot.className = "reader-toolbar";
  const prev = btn(say("\u4E0A\u4E00\u8282", "Previous section"), () => void load(Math.max(0, position - 8)), foot);
  const next = btn(say("\u4E0B\u4E00\u8282", "Next section"), () => void load(nextPosition), foot);
  const apply = () => {
    parent.dataset.theme = theme.value;
    article.style.fontSize = font.value + "px";
  };
  apply();
  font.onchange = () => {
    apply();
    ctx.memo?.set("reader-font", Number(font.value));
  };
  theme.onchange = () => {
    apply();
    ctx.memo?.set("reader-theme", theme.value);
  };
  let key = "", position = 0, nextPosition = null, epoch = 0, loading = false;
  async function load(segment, chapterOffset = 0) {
    if (loading) return;
    loading = true;
    const request = ++epoch;
    notice.textContent = say("\u6B63\u5728\u8F7D\u5165\u6B63\u6587\u2026", "Loading text\u2026");
    prev.disabled = next.disabled = true;
    try {
      const data = await ctx.invoke("reader", [{ bookKey: key, segment, chapterOffset }]);
      if (ctx.signal.aborted || request !== epoch) return;
      position = data.segment;
      nextPosition = data.next;
      ctx.memo?.set("reader-position:" + key, position);
      article.replaceChildren();
      node("small", data.title, article);
      node("h2", data.chapter, article);
      const text = data.segments.map((s) => s.text).join("").replace(/^#{1,6}\s+[^\n]*\n/, "");
      for (const p of text.split(/\n+/)) if (p.trim()) node("p", p, article);
      list.replaceChildren();
      for (const c of data.chapters) btn(c.title, () => {
        directory.open = false;
        void load(c.segment);
      }, list);
      if (chapterOffset > 0) btn(say("\u8F83\u65E9\u76EE\u5F55", "Earlier contents"), () => void load(position, Math.max(0, chapterOffset - 100)), list);
      if (data.nextChapterOffset !== null) btn(say("\u66F4\u591A\u76EE\u5F55", "More contents"), () => void load(position, data.nextChapterOffset), list);
      notice.textContent = say("\u4F60\u7684\u9605\u8BFB\u4E0D\u4F1A\u6539\u53D8\u5927\u80A5\u9C7C\u7684\u8FDB\u5EA6\u3002", "Your reading does not change her progress.") + (data.cachedOnly ? say(" \u7F51\u6587\u4EC5\u5C55\u793A\u5DF2\u7F13\u5B58\u6B63\u6587\u3002", " Only cached online chapters are available.") : "");
      prev.disabled = data.previous === null;
      next.disabled = data.next === null;
      article.focus();
    } catch (error) {
      notice.textContent = say("\u6B63\u6587\u8F7D\u5165\u5931\u8D25\uFF0C\u53EF\u91CD\u8BD5\uFF1A", "Could not load text. Retry: ") + String(error);
      article.replaceChildren();
      btn(say("\u91CD\u8BD5\u8F7D\u5165", "Retry"), () => void load(segment, chapterOffset), article);
    } finally {
      loading = false;
    }
  }
  return { async open(bookKey) {
    key = bookKey;
    const saved = ctx.memo?.get("reader-position:" + key, 0) ?? 0;
    await load(Number.isSafeInteger(saved) && saved >= 0 ? saved : 0);
  } };
}

// src/webui/cover.ts
var PALETTES = 8;
function hash(value) {
  let hash2 = 2166136261;
  for (const char of value) {
    hash2 ^= char.codePointAt(0);
    hash2 = Math.imul(hash2, 16777619);
  }
  return hash2 >>> 0;
}
function hostOf(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}
function coverDesign(book) {
  const title = book.title.trim();
  const author = book.author.trim();
  const hasSource = book.source != null;
  const first = Array.from(title)[0] ?? "\u4E66";
  return {
    palette: hash(`${title}\0${author}`) % PALETTES,
    title,
    author,
    sourceHost: hostOf(book.source?.bookUrl),
    hasSource,
    mark: first.toUpperCase()
  };
}

// src/novel-match.ts
function normalizeIdentity(text) {
  return text.replace(/^作者[:：]/u, "").replace(/[（(][^）)]*[）)]/gu, "").replace(/[\s《》「」『』"'“”‘’·•,，。.、:：;；!！?？\-—_/\\|]/gu, "").toLowerCase().trim();
}
function groupCandidatesByBook(candidates) {
  const groups = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const key = `${normalizeIdentity(candidate.title)}
${normalizeIdentity(candidate.author)}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  return [...groups.values()];
}

// src/webui/qq-group.ts
var QQ_GROUP_QR = "data:image/png;base64,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";

// src/webui/client.ts
var supportPanel = { async mount(ctx) {
  const en = ctx.language !== "zh" && ctx.language !== "zh-Hant";
  const say = (zh, english) => en ? english : zh;
  const root = document.createElement("section");
  root.className = "bf";
  ctx.root.append(root);
  const css = document.createElement("style");
  css.textContent = style;
  root.append(css);
  const page = document.createElement("section");
  page.dataset.page = "support";
  root.append(page);
  const el = (tag, text = "", parent = page) => {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  };
  el("h2", say("\u53CD\u9988\u4E0E\u652F\u6301", "Feedback & support"));
  el("p", say("\u9047\u5230\u95EE\u9898\u3001\u60F3\u63D0\u5EFA\u8BAE\uFF0C\u6216\u60F3\u627E\u540C\u597D\u804A\u804A\uFF0C\u53EF\u4EE5\u4ECE\u4E0B\u9762\u4EFB\u9009\u4E00\u79CD\u65B9\u5F0F\u3002\u63D0\u95EE\u9898\u65F6\u8BF7\u9644\u4E0A\u6269\u5C55\u7248\u672C\u3001\u62A5\u9519\u6587\u5B57\u548C\u590D\u73B0\u6B65\u9AA4\u3002", "Found a problem, have a suggestion, or want to talk with other readers? Use any option below. Please include the extension version, error text and steps to reproduce."));
  const grid = el("div", "");
  grid.className = "support-grid";
  const actions = el("div", "", grid);
  actions.className = "support-actions";
  const issues = el("section", "", actions);
  issues.className = "card support-card";
  el("h3", "GitHub Issues", issues);
  el("p", say("\u62A5\u544A bug\u3001\u529F\u80FD\u5EFA\u8BAE\u6216\u5B89\u88C5\u95EE\u9898\u3002", "Report bugs, feature requests or installation problems."), issues);
  for (const [href, label] of [["https://github.com/oceanxuhaiao/bookfish/issues", say("\u6253\u5F00 GitHub Issues \u2192", "Open GitHub Issues \u2192")], ["https://github.com/oceanxuhaiao/bookfish", say("\u9879\u76EE\u4ED3\u5E93\uFF1Aoceanxuhaiao/bookfish", "Repository: oceanxuhaiao/bookfish")]]) {
    const a2 = document.createElement("a");
    a2.href = href;
    a2.target = "_blank";
    a2.rel = "noreferrer";
    a2.textContent = label;
    a2.className = "support-link";
    issues.append(a2);
  }
  const author = el("section", "", actions);
  author.className = "card support-card";
  el("h3", say("\u4F5C\u8005", "Author"), author);
  const a = document.createElement("a");
  a.href = "https://github.com/oceanxuhaiao";
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = "oceanxuhaiao";
  a.className = "support-link";
  author.append(a);
  el("p", say("Bookfish \u6269\u5C55\u4E0E\u8FD0\u884C\u65F6\u7531 oceanxuhaiao \u7EF4\u62A4\uFF1B\u8FD0\u884C\u65F6\u4E0A\u6E38\u5F52\u5C5E\u89C1\u9879\u76EE README\u3002", "Bookfish and the runtime are maintained by oceanxuhaiao; runtime upstream attribution is in the repository README."), author);
  const sponsor = el("section", "", actions);
  sponsor.className = "card support-card";
  el("h3", say("\u652F\u6301\u4F5C\u8005\uFF08\u81EA\u613F\uFF09", "Support the author (optional)"), sponsor);
  el("p", say("\u5982\u679C Bookfish \u5BF9\u4F60\u6709\u5E2E\u52A9\uFF0C\u53EF\u4EE5\u8BF7\u4F5C\u8005\u5403\u4E2A\u83E0\u841D \u{1F34D}\u3002\u8D5E\u52A9\u5B8C\u5168\u81EA\u613F\uFF0C\u4E0D\u89E3\u9501\u529F\u80FD\uFF0C\u4E0D\u6539\u53D8 MIT/AGPL \u8BB8\u53EF\uFF0C\u4E5F\u4E0D\u6784\u6210\u8D2D\u4E70\u5F15\u64CE\u6216\u8FD0\u884C\u65F6\u3002", "If Bookfish helps you, you can buy the author a pineapple \u{1F34D}. Support is voluntary; it unlocks nothing, does not change the MIT/AGPL licenses, and is not a purchase of the engine or runtime."), sponsor);
  const sponsorLink = document.createElement("a");
  sponsorLink.href = "https://afdian.com/a/book-fish";
  sponsorLink.target = "_blank";
  sponsorLink.rel = "noreferrer";
  sponsorLink.textContent = say("\u524D\u5F80\u7231\u53D1\u7535\u652F\u6301 \u2192", "Support on Afdian \u2192");
  sponsorLink.className = "support-link";
  sponsor.append(sponsorLink);
  const community = el("section", "", grid);
  community.className = "card support-card support-community";
  const communityText = el("div", "", community);
  communityText.className = "support-community-text";
  el("h3", say("QQ \u7FA4", "QQ group"), communityText);
  const row = el("p", "", communityText);
  row.className = "support-number";
  row.append(document.createTextNode(say("\u7FA4\u53F7\uFF1A1135570183", "Group: 1135570183")));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = say("\u590D\u5236\u7FA4\u53F7", "Copy number");
  copy.className = "support-copy";
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText("1135570183").then(() => {
      copy.textContent = say("\u5DF2\u590D\u5236", "Copied");
    }).catch(() => {
      copy.textContent = say("\u8BF7\u624B\u52A8\u590D\u5236", "Copy manually");
    });
  }, { signal: ctx.signal });
  row.append(copy);
  el("small", say("\u626B\u7801\u52A0\u5165 QQ \u7FA4\uFF1B\u7FA4\u53F7\u4E5F\u53EF\u76F4\u63A5\u641C\u7D22\u3002", "Scan to join, or search the group number."), communityText).className = "support-note";
  const qr = document.createElement("img");
  qr.src = QQ_GROUP_QR;
  qr.alt = say("QQ\u7FA4 1135570183 \u5165\u7FA4\u4E8C\u7EF4\u7801", "QQ group 1135570183 join QR code");
  qr.width = 250;
  qr.height = 325;
  qr.className = "qq-group-code";
  qr.loading = "lazy";
  community.append(qr);
  return { dispose() {
    root.remove();
  } };
} };
var readingPanel = { async mount(ctx) {
  const en = ctx.language !== "zh" && ctx.language !== "zh-Hant";
  const say = (zh, english) => en ? english : zh;
  let getRevision = 0;
  let state, update, disposed = false;
  const root = document.createElement("section");
  root.className = "bf";
  ctx.root.append(root);
  const css = document.createElement("style");
  css.textContent = style;
  root.append(css);
  const body = document.createElement("div");
  root.append(body);
  const handle = await legacy_default.panels.status.mount({ ...ctx, root: body, invoke: async (method, args) => {
    const sequence = method === "get" ? ++getRevision : 0;
    const result = await ctx.invoke(method, args);
    if (method === "get" && sequence === getRevision && !disposed && !ctx.signal.aborted) {
      state = result;
      await update?.();
    }
    return result;
  } });
  const old = body.firstElementChild;
  old.style.cssText = "";
  const heading = old.querySelector("h2");
  heading.hidden = true;
  heading.textContent = say("\u{1F41F} \u770B\u4E66\u5427\uFF01\u5927\u80A5\u9C7C", "\u{1F41F} Bookfish");
  const nav = document.createElement("nav");
  nav.hidden = true;
  nav.setAttribute("aria-label", say("\u9605\u8BFB\u5BFC\u822A", "Reading navigation"));
  heading.after(nav);
  const messages = old.querySelector("[role=status]");
  messages.className = "messages";
  nav.after(messages);
  const pages = {};
  for (const id of ["home", "shelf", "trail", "support", "bookDetail", "reader"]) {
    const el2 = document.createElement("section");
    el2.dataset.page = id;
    old.append(el2);
    pages[id] = el2;
  }
  function page(id) {
    for (const [key, el2] of Object.entries(pages)) el2.hidden = key !== id;
    for (const b of nav.querySelectorAll("button")) b.setAttribute("aria-current", b.dataset.page === id || id === "bookDetail" && b.dataset.page === "shelf" ? "page" : "false");
  }
  ["\u6B63\u5728\u8BFB", "\u4E66\u67B6", "\u9605\u8BFB\u8DB3\u8FF9", "\u53CD\u9988"].forEach((label, i) => {
    const b = document.createElement("button");
    const id = ["home", "shelf", "trail", "support"][i];
    b.textContent = en ? ["Reading", "Bookshelf", "Journal", "Support"][i] : label;
    b.dataset.page = id;
    b.onclick = () => {
      if (id === "support") buildSupport();
      page(id);
    };
    nav.append(b);
  });
  function el(tag, text = "", parent = pages.home) {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }
  let supportBuilt = false;
  function buildSupport() {
    if (supportBuilt) return;
    supportBuilt = true;
    const support = pages.support;
    el("h2", say("\u53CD\u9988\u4E0E\u652F\u6301", "Feedback & support"), support);
    el("p", say("\u9047\u5230\u95EE\u9898\u3001\u60F3\u63D0\u5EFA\u8BAE\uFF0C\u6216\u60F3\u627E\u540C\u597D\u804A\u804A\uFF0C\u53EF\u4EE5\u4ECE\u4E0B\u9762\u4EFB\u9009\u4E00\u79CD\u65B9\u5F0F\u3002\u63D0\u95EE\u9898\u65F6\u8BF7\u9644\u4E0A\u6269\u5C55\u7248\u672C\u3001\u62A5\u9519\u6587\u5B57\u548C\u590D\u73B0\u6B65\u9AA4\u3002", "Found a problem, have a suggestion, or want to talk with other readers? Use any option below. Please include the extension version, error text and steps to reproduce."), support);
    const supportGrid = el("div", "", support);
    supportGrid.className = "support-grid";
    const issues = el("section", "", supportGrid);
    issues.className = "card support-card";
    el("h3", say("GitHub Issues", "GitHub Issues"), issues);
    el("p", say("\u62A5\u544A bug\u3001\u529F\u80FD\u5EFA\u8BAE\u6216\u5B89\u88C5\u95EE\u9898\u3002", "Report bugs, feature requests or installation problems."), issues);
    const issuesLink = document.createElement("a");
    issuesLink.href = "https://github.com/oceanxuhaiao/bookfish/issues";
    issuesLink.target = "_blank";
    issuesLink.rel = "noreferrer";
    issuesLink.textContent = say("\u6253\u5F00 GitHub Issues \u2192", "Open GitHub Issues \u2192");
    issuesLink.className = "support-link";
    issues.append(issuesLink);
    const repoLink = document.createElement("a");
    repoLink.href = "https://github.com/oceanxuhaiao/bookfish";
    repoLink.target = "_blank";
    repoLink.rel = "noreferrer";
    repoLink.textContent = say("\u9879\u76EE\u4ED3\u5E93\uFF1Aoceanxuhaiao/bookfish", "Repository: oceanxuhaiao/bookfish");
    repoLink.className = "support-link";
    issues.append(repoLink);
    const qq = el("section", "", supportGrid);
    qq.className = "card support-card";
    el("h3", say("QQ \u7FA4", "QQ group"), qq);
    const numberRow = el("p", "", qq);
    numberRow.className = "support-number";
    numberRow.append(document.createTextNode(say("\u7FA4\u53F7\uFF1A1135570183", "Group: 1135570183")));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = say("\u590D\u5236\u7FA4\u53F7", "Copy number");
    copy.className = "support-copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText("1135570183").then(() => {
        copy.textContent = say("\u5DF2\u590D\u5236", "Copied");
      }).catch(() => {
        copy.textContent = say("\u8BF7\u624B\u52A8\u590D\u5236", "Copy manually");
      });
    }, { signal: ctx.signal });
    numberRow.append(copy);
    const qr = document.createElement("img");
    qr.src = QQ_GROUP_QR;
    qr.alt = say("QQ\u7FA4 1135570183 \u5165\u7FA4\u4E8C\u7EF4\u7801", "QQ group 1135570183 join QR code");
    qr.width = 250;
    qr.height = 325;
    qr.className = "qq-group-code";
    qr.loading = "lazy";
    qq.append(qr);
    el("small", say("\u626B\u7801\u52A0\u5165 QQ \u7FA4\uFF1B\u7FA4\u53F7\u4E5F\u53EF\u76F4\u63A5\u641C\u7D22\u3002", "Scan to join, or search the group number."), qq).className = "support-note";
    const author = el("section", "", supportGrid);
    author.className = "card support-card";
    el("h3", say("\u4F5C\u8005", "Author"), author);
    const authorLink = document.createElement("a");
    authorLink.href = "https://github.com/oceanxuhaiao";
    authorLink.target = "_blank";
    authorLink.rel = "noreferrer";
    authorLink.textContent = "oceanxuhaiao";
    authorLink.className = "support-link";
    author.append(authorLink);
    el("p", say("Bookfish \u6269\u5C55\u4E0E\u8FD0\u884C\u65F6\u7531 oceanxuhaiao \u7EF4\u62A4\uFF1B\u8FD0\u884C\u65F6\u4E0A\u6E38\u5F52\u5C5E\u89C1\u9879\u76EE README\u3002", "Bookfish and the runtime are maintained by oceanxuhaiao; runtime upstream attribution is in the repository README."), author);
  }
  let busy = false;
  async function perform(action) {
    if (busy || disposed || ctx.signal.aborted) return;
    busy = true;
    messages.textContent = say("\u6B63\u5728\u5904\u7406\u2026", "Working\u2026");
    try {
      await action();
      if (!disposed && !ctx.signal.aborted) {
        messages.textContent = pages.bookDetail.hidden ? say("\u64CD\u4F5C\u5B8C\u6210\u3002", "Done.") : "";
        const sequence = ++getRevision;
        const fresh = await ctx.invoke("get", []);
        if (sequence === getRevision) {
          state = fresh;
          await update?.();
        }
      }
    } catch (e) {
      if (!disposed) messages.textContent = String(e).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/, "");
    } finally {
      busy = false;
      await update?.();
    }
  }
  function button(parent, label, fn) {
    const b = el("button", label, parent);
    b.type = "button";
    b.addEventListener("click", () => void perform(fn), { signal: ctx.signal });
    return b;
  }
  function details(parent, label) {
    const d = el("details", "", parent);
    el("summary", label, d);
    return d;
  }
  const advanced = details(pages.shelf, say("\u4E66\u67B6\u6570\u636E\u7BA1\u7406", "Bookshelf data management"));
  const forms = [...old.querySelectorAll("form")];
  const importForm = forms[0], remoteForm = forms[1], searchForm = forms[2];
  const shelf = old.querySelector("[data-bookfish=shelf]");
  const notebook = old.querySelector('section[aria-label="' + say("\u9605\u8BFB\u624B\u8D26", "Reading journal") + '"]');
  const articles = old.querySelector('section[aria-label="' + say("\u5168\u4E66\u8BFB\u540E\u611F", "Full-book reviews") + '"]');
  const articleDetail = articles.nextElementSibling;
  const episodeDetail = old.querySelector('section[aria-label="' + say("\u611F\u60F3\u4E0E\u539F\u6587\u4F9D\u636E", "Episode and evidence") + '"]');
  const controls = old.querySelector("[data-bookfish=controls]");
  const recommend = el("section", "", pages.shelf);
  recommend.className = "card";
  recommend.id = "bf-recommend-panel";
  recommend.hidden = true;
  recommend.setAttribute("aria-label", say("\u63A8\u8350\u4E00\u672C\u4E66", "Recommend a book"));
  const recommendHead = el("div", "", recommend);
  recommendHead.className = "shelf-header";
  el("h3", say("\u63A8\u8350\u4E00\u672C\u4E66", "Recommend a book"), recommendHead);
  const closeRecommend = el("button", say("\u6536\u8D77", "Close"), recommendHead);
  closeRecommend.type = "button";
  el("p", say("\u9009\u62E9\u5BFC\u5165\u65B9\u5F0F\uFF0C\u628A\u5C0F\u8BF4\u4EA4\u7ED9\u5979\u6162\u6162\u8BFB\u3002", "Choose how to add a novel for her to read at her own pace."), recommend);
  const methodPicker = el("div", "", recommend);
  methodPicker.className = "import-method";
  const methodLabel = el("label", say("\u5BFC\u5165\u65B9\u5F0F", "Import method"), methodPicker);
  const methodSelect = document.createElement("select");
  methodSelect.setAttribute("aria-label", say("\u5BFC\u5165\u65B9\u5F0F", "Import method"));
  for (const [value, label] of [["file", say("\u6587\u4EF6\u5BFC\u5165", "Import a file")], ["link", say("\u94FE\u63A5\u83B7\u53D6", "Fetch from a link")], ["title", say("\u4E66\u540D\u6216\u4F5C\u8005\u83B7\u53D6", "Fetch by title or author")]]) {
    const option = el("option", label, methodSelect);
    option.value = value;
  }
  methodLabel.append(methodSelect);
  const methodPanel = el("div", "", recommend);
  methodPanel.className = "import-method-panel";
  const filePanel = el("div", "", methodPanel);
  filePanel.append(importForm);
  const linkPanel = el("div", "", methodPanel);
  linkPanel.append(remoteForm);
  linkPanel.hidden = true;
  const importStatus = old.querySelector("[data-bookfish=import-status]");
  if (importStatus) pages.shelf.prepend(importStatus);
  pages.shelf.append(shelf);
  shelf.hidden = true;
  const novel = el("section", "", methodPanel);
  novel.className = "card";
  novel.id = "bf-novel-fetch";
  novel.hidden = true;
  el("h3", say("\u6309\u4E66\u540D\u6216\u4F5C\u8005\u83B7\u53D6", "Fetch by title or author"), novel);
  el("p", say("\u4E66\u540D\u6216\u4F5C\u8005\u81F3\u5C11\u586B\u4E00\u4E2A\uFF0C\u4E5F\u53EF\u540C\u65F6\u586B\u5199\u3002\u5148\u6838\u5BF9\u4F5C\u8005\u3001\u4E66\u6E90\u548C\u6700\u65B0\u7AE0\u8282\uFF0C\u518D\u83B7\u53D6\u5168\u672C\u3002\u53EA\u6709\u901A\u8FC7\u76EE\u5F55\u8FDE\u7EED\u6027\u3001\u7F3A\u7AE0\u3001\u9875\u6570\u63A2\u9488\u4E0E\u7248\u672C\u4E00\u81F4\u6027\u6821\u9A8C\u7684\u7ED3\u679C\u624D\u4F1A\u52A0\u5165\u4E66\u67B6\u3002", "Enter a title, an author, or both. Confirm author, source and latest chapter before fetching. Only downloads that pass catalog, chapter, page-probe and edition checks enter the shelf."), novel);
  const novelGate = el("p", say("\u6309\u4E66\u540D\u6216\u4F5C\u8005\u83B7\u53D6\u524D\uFF0C\u9700\u8981\u5148\u5B89\u88C5\u5C0F\u8BF4\u83B7\u53D6\u5F15\u64CE\u3002\u70B9\u4E0B\u65B9\u201C\u4E00\u952E\u5B89\u88C5\u5C0F\u8BF4\u5F15\u64CE\u201D\uFF0C\u6216\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\uFF1B\u5B89\u88C5\u5B8C\u6210\u540E\u641C\u7D22\u4F1A\u81EA\u52A8\u542F\u7528\u3002\u6587\u4EF6\u5BFC\u5165\u548C\u94FE\u63A5\u83B7\u53D6\u4E0D\u53D7\u5F71\u54CD\u3002", "Before fetching by title or author, install the novel fetch engine. Use \u201CInstall novel engine\u201D below, or import an offline runtime ZIP; search enables automatically when ready. File import and link fetching are unaffected."), novel);
  novelGate.className = "novel-engine-gate";
  novelGate.hidden = true;
  novelGate.setAttribute("role", "status");
  const novelForm = document.createElement("form");
  novelForm.className = "novel-form";
  novel.append(novelForm);
  const runtimeHost = document.createElement("div");
  runtimeHost.className = "runtime-guide";
  runtimeHost.hidden = true;
  novelForm.before(runtimeHost);
  let runtimeCard;
  function showRuntimeGuide(show) {
    runtimeHost.hidden = !show;
    if (show && !runtimeCard) runtimeCard = mountRuntimeCard(runtimeHost, ctx, { compact: true, onReady: () => {
      void perform(async () => {
        await pollNovel();
      });
    } });
    if (!show && runtimeCard) {
      runtimeCard.dispose();
      runtimeCard = void 0;
      runtimeHost.replaceChildren();
    }
  }
  const novelTitleLabel = document.createElement("label");
  novelTitleLabel.textContent = say("\u4E66\u540D\uFF08\u53EF\u53EA\u586B\u4E66\u540D\u6216\u53EA\u586B\u4F5C\u8005\uFF09", "Title (title or author alone is fine)");
  const novelTitleInput = document.createElement("input");
  novelTitleInput.type = "text";
  novelTitleInput.maxLength = 200;
  novelTitleInput.placeholder = say("\u4F8B\u5982 \u4E09\u56FD\u6F14\u4E49", "e.g. Romance of the Three Kingdoms");
  novelTitleLabel.append(novelTitleInput);
  novelForm.append(novelTitleLabel);
  const novelAuthorLabel = document.createElement("label");
  novelAuthorLabel.textContent = say("\u4F5C\u8005\uFF08\u53EF\u53EA\u586B\u4F5C\u8005\uFF09", "Author (author alone is fine)");
  const novelAuthorInput = document.createElement("input");
  novelAuthorInput.type = "text";
  novelAuthorInput.maxLength = 100;
  novelAuthorInput.placeholder = say("\u4F8B\u5982 \u7F57\u8D2F\u4E2D", "e.g. Luo Guanzhong");
  novelAuthorLabel.append(novelAuthorInput);
  novelForm.append(novelAuthorLabel);
  const novelHint = el("small", say("\u81F3\u5C11\u586B\u5199\u4E66\u540D\u6216\u4F5C\u8005\u4E4B\u4E00\uFF1B\u540C\u65F6\u586B\u5199\u65F6\u4F1A\u5148\u6309\u4E66\u540D\u641C\u7D22\uFF0C\u627E\u4E0D\u5230\u7CBE\u786E\u5339\u914D\u518D\u6309\u4F5C\u8005\u641C\u7D22\u3002", "At least one field is required. With both fields, title is searched first and author is added when no exact match is found."), novelForm);
  const novelSubmit = document.createElement("button");
  novelSubmit.type = "submit";
  novelSubmit.className = "primary";
  novelSubmit.textContent = say("\u641C\u7D22\u5019\u9009\u7248\u672C", "Search versions");
  novelForm.append(novelSubmit);
  const novelProgress = document.createElement("progress");
  novelProgress.className = "novel-search-progress";
  novelProgress.setAttribute("aria-label", say("\u641C\u7D22\u8FDB\u5EA6", "Search progress"));
  novelProgress.hidden = true;
  novelForm.append(novelProgress);
  const novelProgressText = el("small", "", novelForm);
  novelProgressText.hidden = true;
  function selectImportMethod(method, focus = false) {
    filePanel.hidden = method !== "file";
    linkPanel.hidden = method !== "link";
    novel.hidden = method !== "title";
    if (method === "title") void pollNovel();
    if (!focus) return;
    if (method === "file") importForm.querySelector("input[type=file]")?.focus();
    else if (method === "link") remoteForm.querySelector("input")?.focus();
    else if (!novelGate.hidden) runtimeHost.querySelector("button")?.focus();
    else novelTitleInput.focus();
  }
  selectImportMethod("file");
  methodSelect.addEventListener("change", () => selectImportMethod(methodSelect.value, true), { signal: ctx.signal });
  const novelNote = el("p", "", novel);
  novelNote.setAttribute("role", "status");
  novelNote.setAttribute("aria-live", "polite");
  const novelResume = el("div", "", novel);
  novelResume.className = "novel-resume";
  const novelList = el("div", "", novel);
  novelList.className = "novel-candidates";
  const novelTasks = el("div", "", novel);
  novelTasks.className = "novel-task-list";
  const serial = el("section", "", recommend);
  serial.className = "card";
  serial.id = "bf-serial-follow";
  const serialHead = el("h3", say("\u4F5C\u4E3A\u8FDE\u8F7D\u8FFD\u66F4", "Follow a serial"), serial);
  const serialExperimental = el("span", say("\u5B9E\u9A8C\u529F\u80FD", "Experimental"), serialHead);
  serialExperimental.className = "badge experimental";
  el("p", say("\u5148\u8BFB\u53D6\u5B8C\u6574\u76EE\u5F55\uFF0C\u786E\u8BA4\u6765\u6E90\u3001\u8FDE\u8F7D\u72B6\u6001\u548C\u7AE0\u6570\uFF0C\u518D\u5EFA\u7ACB\u4E00\u4E2A\u53EF\u589E\u91CF\u8FFD\u52A0\u7684\u8FDE\u8F7D\u6761\u76EE\u3002\u5B83\u4E0E\u201C\u4E0B\u8F7D\u5F53\u524D\u7248\u672C\u201D\u4E0D\u540C\uFF1A\u53EA\u8FFD\u52A0\u65B0\u7AE0\uFF0C\u4E0D\u6E05\u7A7A\u5DF2\u8BFB\u8FDB\u5EA6\u3002", "Read the full catalog first, confirm source, status and chapter count, then create an incremental serial entry. Unlike \u201Cdownload this version\u201D, it only appends new chapters and never resets reading progress."), serial);
  const serialUrlLabel = document.createElement("label");
  serialUrlLabel.textContent = say("\u8FDE\u8F7D\u76EE\u5F55\u94FE\u63A5", "Serial catalog URL");
  const serialUrl = document.createElement("input");
  serialUrl.type = "url";
  serialUrl.placeholder = "https://www.02345.cc/bookname/";
  serialUrl.maxLength = 2e3;
  serialUrlLabel.append(serialUrl);
  serial.append(serialUrlLabel);
  const serialPreviewButton = button(serial, say("\u8BFB\u53D6\u5B8C\u6574\u76EE\u5F55", "Read full catalog"), async () => {
    serialPreviewBox.replaceChildren();
    serialNote.textContent = say("\u6B63\u5728\u8BFB\u53D6\u76EE\u5F55\u9875\u2026", "Reading the catalog\u2026");
    const preview = await ctx.invoke("serial_preview", [{ url: serialUrl.value.trim(), sourceId: "biquge-02345-v1" }]);
    if (disposed || ctx.signal.aborted) return;
    renderSerialPreview(preview);
  });
  const serialNote = el("p", "", serial);
  serialNote.setAttribute("role", "status");
  serialNote.setAttribute("aria-live", "polite");
  const serialPreviewBox = el("div", "", serial);
  let serialPreviewToken;
  function renderSerialPreview(preview) {
    serialPreviewToken = preview.token;
    serialPreviewBox.replaceChildren();
    el("strong", preview.title + " \xB7 " + (preview.author || say("\u4F5C\u8005\u672A\u77E5", "Unknown author")), serialPreviewBox);
    el("small", (preview.publicationStatus === "finished" ? say("\u5DF2\u5B8C\u7ED3", "Finished") : preview.publicationStatus === "ongoing" ? say("\u8FDE\u8F7D\u4E2D", "Ongoing") : say("\u72B6\u6001\u672A\u77E5", "Status unknown")) + say(" \xB7 \u76EE\u5F55 ", " \xB7 catalog ") + preview.totalChapters + say(" \u7AE0", " chapters"), serialPreviewBox);
    if (preview.authorization !== "allowed") el("small", say("\u6765\u6E90\u7528\u9014\u6388\u6743\u672A\u786E\u8BA4\uFF1A\u53EA\u5728\u672C\u673A\u7F13\u5B58\u9605\u8BFB\uFF0C\u4E0D\u89C6\u4E3A\u5DF2\u83B7\u6388\u6743\uFF0C\u4E5F\u4E0D\u5BF9\u5916\u5206\u53D1\u3002", "Source permission is unconfirmed: cached locally for reading only, not treated as authorized or redistributed."), serialPreviewBox);
    el("small", preview.note, serialPreviewBox);
    button(serialPreviewBox, say("\u5EFA\u7ACB\u8FDE\u8F7D\u8FFD\u66F4", "Create serial subscription"), async () => {
      const result = await ctx.invoke("serial_subscribe", [serialPreviewToken, { intervalMinutes: 60, enabled: true }]);
      serialNote.textContent = say("\u6B63\u5728\u83B7\u53D6\u7B2C\u4E00\u6279\u6B63\u6587\u2026", "Fetching the first batch\u2026");
      await pollSerialJob(result.jobId);
      serialPreviewBox.replaceChildren();
      await perform(async () => {
      });
    });
  }
  async function pollSerialJob(jobId) {
    for (let attempt = 0; attempt < 160 && !disposed && !ctx.signal.aborted; attempt++) {
      const job = await ctx.invoke("serial_job", [jobId]);
      if (job) {
        serialNote.textContent = job.stage + (job.target ? ` \xB7 ${job.added}/${job.target}` : "") + (job.message ? " \xB7 " + job.message : "");
        if (["succeeded", "failed", "cancelled", "interrupted", "conflict"].includes(job.status)) {
          if (job.status === "succeeded" || job.status === "failed") await perform(async () => {
          });
          return job;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return null;
  }
  let novelPollTimer;
  const novelSeenComplete = /* @__PURE__ */ new Set();
  let novelRefreshPending = false;
  const novelStateLabel = { queued: say("\u6392\u961F\u4E2D", "Queued"), fetching: say("\u6B63\u5728\u83B7\u53D6", "Fetching"), validating: say("\u6B63\u5728\u6821\u9A8C", "Validating"), complete: say("\u5DF2\u52A0\u5165\u4E66\u67B6", "Added to shelf"), failed: say("\u83B7\u53D6\u5931\u8D25", "Failed"), cancelled: say("\u5DF2\u53D6\u6D88", "Cancelled") };
  const issueText = {
    catalog_duplicate_number: say("\u4E66\u6E90\u76EE\u5F55\u5B58\u5728\u91CD\u590D\u7AE0\u8282\u7F16\u53F7", "Duplicate chapter numbers in the source catalog"),
    catalog_number_regression: say("\u4E66\u6E90\u76EE\u5F55\u7AE0\u8282\u7F16\u53F7\u56DE\u9000", "Chapter numbers go backwards in the source catalog"),
    catalog_number_order_mismatch: say("\u76EE\u5F55\u987A\u5E8F\u4E0E\u7AE0\u8282\u7F16\u53F7\u504F\u79FB\u4E0D\u4E00\u81F4\uFF0C\u53EF\u80FD\u6DF7\u5165\u5176\u5B83\u7248\u672C", "Catalog order and chapter numbers drift apart; likely a mixed edition"),
    catalog_duplicate_title: say("\u4E66\u6E90\u76EE\u5F55\u5B58\u5728\u91CD\u590D\u7AE0\u8282\u6807\u9898", "Duplicate chapter titles in the source catalog"),
    catalog_order_gap: say("\u4E66\u6E90\u76EE\u5F55\u5E8F\u53F7\u4E0D\u8FDE\u7EED", "Catalog order is not contiguous"),
    catalog_changed: say("\u4E0B\u8F7D\u524D\u540E\u76EE\u5F55\u53D1\u751F\u53D8\u5316", "Catalog changed during download"),
    missing_chapter: say("\u7F3A\u5C11\u7AE0\u8282", "A chapter is missing"),
    unexpected_chapter_file: say("\u51FA\u73B0\u4E86\u76EE\u5F55\u5916\u7684\u7AE0\u8282\u6587\u4EF6", "A file has no catalog entry"),
    empty_chapter: say("\u7AE0\u8282\u6B63\u6587\u4E3A\u7A7A", "A chapter is empty"),
    source_empty_chapter: say("\u4E66\u6E90\u8BE5\u7AE0\u6CA1\u6709\u6B63\u6587\uFF0C\u4EC5\u4FDD\u7559\u6807\u9898", "The source chapter has no body; only its heading is kept"),
    short_chapter: say("\u7AE0\u8282\u6B63\u6587\u660E\u663E\u8FC7\u77ED", "A chapter is unusually short"),
    placeholder_chapter: say("\u7AE0\u8282\u662F\u5360\u4F4D\u9875", "A chapter is a placeholder"),
    duplicate_chapter_body: say("\u591A\u4E2A\u7AE0\u8282\u6B63\u6587\u91CD\u590D", "Several chapters share the same body"),
    missing_page_marker: say("\u7AE0\u8282\u53EA\u53D6\u5230\u7B2C\u4E00\u9875", "A chapter stopped at its first page"),
    truncated_chapter_tail: say("\u7AE0\u8282\u5728\u53E5\u4E2D\u622A\u65AD", "A chapter ends mid-sentence"),
    page_probe_missing_page: say("\u9875\u6570\u63A2\u9488\u53D1\u73B0\u6F0F\u9875", "Page probe found a missing source page"),
    page_probe_short: say("\u9875\u6570\u63A2\u9488\u53D1\u73B0\u6B63\u6587\u660E\u663E\u504F\u77ED", "Page probe found a materially shorter body"),
    page_probe_unavailable: say("\u9875\u6570\u63A2\u9488\u65E0\u6CD5\u8BFB\u53D6\u6E90\u7AD9", "Page probe could not read the source")
  };
  function candidateLabel(candidate) {
    const onlyTitle = !novelAuthorInput.value.trim(), onlyAuthor = !novelTitleInput.value.trim();
    return candidate.match === "exact" ? onlyTitle ? say("\u4E66\u540D\u5339\u914D", "Title matches") : onlyAuthor ? say("\u4F5C\u8005\u5339\u914D", "Author matches") : say("\u4E66\u540D\u3001\u4F5C\u8005\u5339\u914D", "Title and author match") : candidate.match === "title" ? say("\u4E66\u540D\u76F8\u540C\uFF0C\u4F5C\u8005\u4E0D\u5339\u914D\uFF0C\u5DF2\u505C\u7528", "Same title, different author; disabled") : candidate.match === "author" ? say("\u4F5C\u8005\u5339\u914D\u4F46\u4E66\u540D\u4E0D\u540C\uFF0C\u5DF2\u505C\u7528", "Author matches but title differs; disabled") : say("\u4E0D\u5339\u914D\uFF0C\u5DF2\u505C\u7528", "No match; disabled");
  }
  async function fetchCandidate(candidate) {
    if (candidate.match !== "exact") throw Error(say("\u5019\u9009\u4E0D\u5339\u914D\u5F53\u524D\u641C\u7D22\u6761\u4EF6\uFF0C\u4E0D\u80FD\u83B7\u53D6\u3002", "This candidate does not match the current search."));
    await ctx.invoke("novel_fetch", [candidate]);
    novelNote.textContent = say("\u5DF2\u52A0\u5165\u83B7\u53D6\u961F\u5217\uFF0C\u53EA\u6709\u5168\u90E8\u6821\u9A8C\u901A\u8FC7\u624D\u4F1A\u5165\u67B6\uFF1B\u5931\u8D25\u65F6\u53EF\u6362\u7528\u5176\u4ED6\u4E66\u6E90\u3002", "Queued. Nothing enters the shelf unless every check passes; if it fails, try another source.");
    startNovelPoll();
  }
  function candidateCard(candidate, alternatives = []) {
    const card = document.createElement("article");
    card.className = "novel-candidate";
    novelList.append(card);
    el("strong", candidate.title, card);
    el("small", (candidate.author || say("\u4F5C\u8005\u672A\u77E5", "Unknown author")) + " \xB7 " + candidate.source.name + (candidate.latestChapter ? " \xB7 " + candidate.latestChapter : ""), card);
    el("small", candidateLabel(candidate), card);
    const fetch = button(card, say("\u83B7\u53D6\u5168\u672C", "Fetch full book"), () => fetchCandidate(candidate));
    if (candidate.match !== "exact") fetch.disabled = true;
    if (alternatives.length) {
      const more = document.createElement("details");
      card.append(more);
      const summary = document.createElement("summary");
      summary.textContent = say("\u5176\u4ED6\u4E66\u6E90\uFF08", "Other sources (") + alternatives.length + ")";
      more.append(summary);
      for (const alternative of alternatives) {
        const row = document.createElement("div");
        row.className = "novel-alternative";
        more.append(row);
        el("small", alternative.source.name + (alternative.latestChapter ? " \xB7 " + alternative.latestChapter : ""), row);
        const use = button(row, say("\u7528\u6B64\u6E90\u83B7\u53D6", "Fetch from this source"), () => fetchCandidate(alternative));
        if (alternative.match !== "exact") use.disabled = true;
      }
    }
  }
  function renderCandidateGroups(candidates) {
    const rank = (match) => match === "exact" ? 0 : match === "title" ? 1 : match === "author" ? 2 : 3;
    const groups = groupCandidatesByBook(candidates);
    groups.sort((a, b) => rank(a[0].match) - rank(b[0].match));
    for (const group of groups) candidateCard(group[0], group.slice(1));
  }
  async function resumeUnfinished(entry) {
    const candidate = { title: entry.title, author: entry.author, source: { id: entry.source.id, name: entry.source.name }, url: entry.url, revision: entry.revision, latestChapter: "", lastUpdateTime: "" };
    await ctx.invoke("novel_fetch", [candidate]);
    novelNote.textContent = say("\u5DF2\u7EE7\u7EED\u4E0B\u8F7D\uFF0C\u53EA\u8865\u9F50\u7F3A\u5931\u7AE0\u8282\uFF1B\u5B8C\u6210\u540E\u4ECD\u4F1A\u91CD\u65B0\u6821\u9A8C\u3002", "Resumed; only missing chapters are fetched and every check still runs.");
    startNovelPoll();
  }
  function renderResumable(status) {
    novelResume.replaceChildren();
    const rows = status.resumable ?? [];
    if (!rows.length) return;
    const history = document.createElement("details");
    history.className = "novel-resume-history";
    novelResume.append(history);
    el("summary", say("\u672A\u5B8C\u6210\u6216\u5F85\u91CD\u65B0\u6821\u9A8C\u7684\u4E0B\u8F7D\uFF08", "Unfinished or unverified downloads (") + rows.length + "\uFF09", history);
    for (const entry of rows) {
      const card = document.createElement("article");
      card.className = "novel-task";
      history.append(card);
      const completeDownload = entry.catalogChapters > 0 && entry.downloadedChapters >= entry.catalogChapters;
      el("strong", entry.title + " \xB7 " + entry.author, card);
      el("small", entry.source.name + (completeDownload ? say(" \xB7 \u4E0B\u8F7D\u5DF2\u5B8C\u6210\uFF0C\u6821\u9A8C\u672A\u901A\u8FC7", " \xB7 download complete; checks failed") : say(" \xB7 \u5DF2\u4E0B\u8F7D ", " \xB7 downloaded ") + entry.downloadedChapters + (entry.catalogChapters ? "/" + entry.catalogChapters : "") + say(" \u7AE0", " chapters")), card);
      if (entry.catalogChapters) {
        const bar = document.createElement("progress");
        bar.max = entry.catalogChapters;
        bar.value = Math.min(entry.downloadedChapters, entry.catalogChapters);
        bar.setAttribute("aria-label", say("\u7EED\u4F20\u8FDB\u5EA6", "Resume progress"));
        card.append(bar);
      }
      button(card, completeDownload ? say("\u91CD\u65B0\u6821\u9A8C", "Recheck") : say("\u7EE7\u7EED\u4E0B\u8F7D", "Continue download"), () => resumeUnfinished(entry));
    }
  }
  function renderNovelTasks(status) {
    if (!status) return;
    renderResumable(status);
    const enabled = status.available;
    novelGate.hidden = enabled;
    showRuntimeGuide(!enabled);
    for (const node of novelForm.querySelectorAll("input,button")) node.disabled = !enabled;
    novelNote.textContent = enabled ? say("\u5F15\u64CE\u53EF\u7528\u3002\u5148\u641C\u7D22\uFF0C\u9009\u62E9\u660E\u786E\u5339\u914D\u7684\u7248\u672C\u3002", "Engine ready. Search first and choose an exact match.") : say("\u5C0F\u8BF4\u5F15\u64CE\u672A\u5B89\u88C5\uFF1A", "Novel engine unavailable: ") + (status.reason ?? "") + say("\u3002\u53EF\u5728\u4E0B\u65B9\u5B89\u88C5\u6216\u5BFC\u5165\u79BB\u7EBF\u8FD0\u884C\u65F6\u5305\uFF1B\u5DF2\u5BFC\u5165\u4E66\u7C4D\u4ECD\u53EF\u9605\u8BFB\u3002", " You can install below or import an offline runtime ZIP; shelf books remain readable.");
    novelTasks.replaceChildren();
    for (const task of status.tasks.slice(0, 3)) {
      const card = document.createElement("article");
      card.className = "novel-task";
      novelTasks.append(card);
      el("strong", task.title + " \xB7 " + task.author, card);
      el("small", (task.origin === "autonomous" ? say("\u5927\u80A5\u9C7C\u81EA\u9009 \xB7 ", "Her own pick \xB7 ") : say("\u4F60\u53D1\u8D77 \xB7 ", "Manual \xB7 ")) + (novelStateLabel[task.state] ?? task.state) + (task.catalogChapters ? say(" \xB7 \u7AE0\u8282 ", " \xB7 chapters ") + task.downloadedChapters + "/" + task.catalogChapters : ""), card);
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = task.percent;
      bar.setAttribute("aria-label", say("\u83B7\u53D6\u8FDB\u5EA6", "Fetch progress"));
      card.append(bar);
      const uniqueIssues = [...new Set(task.issues.map((issue) => issue.code))];
      if (task.issueCount) el("p", say("\u6821\u9A8C\u95EE\u9898\uFF1A", "Checks failed: ") + uniqueIssues.slice(0, 5).map((code) => issueText[code] ?? code).join("\uFF1B") + (task.issueCount > uniqueIssues.length ? " \u2026" : ""), card);
      if (uniqueIssues.some((code) => code.startsWith("catalog_"))) el("small", say("\u8FD9\u662F\u4E66\u6E90\u76EE\u5F55\u672C\u8EAB\u7684\u7AE0\u8282\u7F16\u53F7/\u987A\u5E8F\u95EE\u9898\uFF0C\u4E0D\u662F\u4F60\u7684\u64CD\u4F5C\u6216\u7F51\u7EDC\u6545\u969C\uFF1B\u672C\u6269\u5C55\u4E3A\u907F\u514D\u7F3A\u7AE0\u548C\u6DF7\u7248\u6CA1\u6709\u4E0B\u8F7D\uFF0C\u53EF\u4EE5\u6362\u4E00\u4E2A\u4E66\u6E90\u518D\u8BD5\u3002", "The source catalog itself has duplicate or inconsistent chapter numbering. Bookfish refused to download to avoid missing or mixed editions; try another source."), card);
      if (task.warningCount) {
        const uniqueWarnings = [...new Set(task.warnings.map((issue) => issue.code))];
        const tail = uniqueWarnings.includes("truncated_chapter_tail");
        el("small", (tail ? say("\u4E66\u6E90\u8BE5\u7AE0\u672B\u5C3E\u672C\u8EAB\u6B8B\u7F3A\uFF0C\u6CA1\u6709\u8865\u9F50\u6216\u7F16\u9020\u6587\u5B57\uFF1B\u5DF2\u4FDD\u7559\u5E76\u8BB0\u5F55\u8B66\u544A\uFF1A", "The source chapter itself ends mid-sentence; no text was invented. Recorded warning: ") : say("\u5DF2\u8BB0\u5F55\u7684\u8B66\u544A\uFF1A", "Recorded warnings: ")) + uniqueWarnings.map((code) => issueText[code] ?? code).join("\uFF1B"), card);
      }
      if (task.error && task.state !== "complete") {
        const timeout = task.error.match(/Download timed out after (\d+) minutes/u);
        const detail = timeout ? say(`\u4E0B\u8F7D\u8D85\u65F6\uFF08\u7EA6${timeout[1]}\u5206\u949F\uFF09\uFF0C\u672A\u52A0\u5165\u4E66\u67B6\uFF1B\u53EF\u91CD\u8BD5\u6216\u6362\u4E00\u4E2A\u4E66\u6E90\u3002`, `Download timed out after ${timeout[1]} minutes; nothing entered the shelf. Retry or use another source.`) : task.error.includes("Catalog gate") ? say("\u4E66\u6E90\u76EE\u5F55\u672A\u901A\u8FC7\u6821\u9A8C\uFF0C\u672A\u4E0B\u8F7D\u4EFB\u4F55\u7AE0\u8282\u3002", "The source catalog failed validation; nothing was downloaded.") : task.error.includes("Integrity gate") ? say("\u4E0B\u8F7D\u5185\u5BB9\u672A\u901A\u8FC7\u5B8C\u6574\u6027\u6821\u9A8C\uFF0C\u672A\u52A0\u5165\u4E66\u67B6\u3002", "The download failed integrity checks and was not added.") : task.error;
        el("small", detail, card);
      }
      if (task.state === "complete") {
        const present = !!state?.books.some((book) => book.key === task.bookKey);
        el("p", present ? task.warningCount ? say("\u5DF2\u52A0\u5165\u4E66\u67B6\uFF1B\u76EE\u5F55\u6709\u5C11\u91CF\u7F16\u53F7\u8B66\u544A\uFF0C\u5DF2\u8BB0\u5F55\u3002", "Added to the shelf with a few recorded catalog-number warnings.") : say("\u5DF2\u52A0\u5165\u4E66\u67B6\uFF0C\u53EF\u5728\u4E66\u67B6\u67E5\u770B\u5E76\u9605\u8BFB\u3002", "Added to the shelf; open it in Bookshelf.") : say("\u8FD9\u6B21\u83B7\u53D6\u7684\u4E66\u5DF2\u4ECE\u4E66\u67B6\u5220\u9664\u3002", "This fetched book has been removed from the shelf."), card);
      }
      if (["queued", "fetching", "validating"].includes(task.state)) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = say("\u53D6\u6D88\u83B7\u53D6", "Cancel fetch");
        cancel.onclick = () => void perform(async () => {
          await ctx.invoke("novel_cancel", [task.id]);
          await pollNovel();
        });
        card.append(cancel);
      }
    }
  }
  async function pollNovel() {
    if (disposed || ctx.signal.aborted) return;
    try {
      const status = await ctx.invoke("novel_status", []);
      if (disposed || ctx.signal.aborted) return;
      if (state) state.novel = status;
      renderNovelTasks(status);
      const active = status.tasks.some((task) => ["queued", "fetching", "validating"].includes(task.state));
      const completed = status.tasks.filter((task) => task.state === "complete" && task.bookKey && !novelSeenComplete.has(task.id));
      if (completed.length && !novelRefreshPending) {
        novelList.replaceChildren();
        for (const task of completed) novelSeenComplete.add(task.id);
        novelRefreshPending = true;
        try {
          const fresh = await ctx.invoke("get", []);
          if (!disposed && !ctx.signal.aborted) {
            state = fresh;
            await update?.();
          }
        } finally {
          novelRefreshPending = false;
        }
      }
      if (active) startNovelPoll();
    } catch (error) {
      novelNote.textContent = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/, "");
    }
  }
  function startNovelPoll() {
    if (disposed || novelPollTimer !== void 0) return;
    novelPollTimer = setTimeout(() => {
      novelPollTimer = void 0;
      void pollNovel();
    }, 1800);
  }
  ctx.interval(() => {
    if (!disposed && state?.novel && !state.novel.available) void runtimeCard?.refresh();
  }, 4e3);
  novelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      const title2 = novelTitleInput.value.trim(), author = novelAuthorInput.value.trim();
      if (!title2 && !author) throw Error(say("\u8BF7\u81F3\u5C11\u586B\u5199\u4E66\u540D\u6216\u4F5C\u8005\u3002", "Enter a title or an author."));
      novelList.replaceChildren();
      novelSubmit.disabled = true;
      novelProgress.hidden = false;
      novelProgress.max = 100;
      novelProgress.value = 0;
      novelProgressText.hidden = false;
      novelProgressText.textContent = say("\u6B63\u5728\u51C6\u5907\u641C\u7D22\u2026", "Preparing search\u2026");
      novelNote.textContent = say("\u6B63\u5728\u641C\u7D22\u5019\u9009\u7248\u672C\u2026", "Searching versions\u2026");
      try {
        const job = await ctx.invoke("novel_search_start", [{ title: title2, author }]);
        for (; ; ) {
          if (disposed || ctx.signal.aborted) return;
          const status = await ctx.invoke("novel_search_status", [job.id]);
          if (disposed || ctx.signal.aborted) return;
          novelProgress.value = status.total ? Math.round(status.completed / status.total * 100) : 0;
          novelProgressText.textContent = say("\u5DF2\u68C0\u67E5 ", "Checked ") + status.completed + "/" + status.total + say(" \u4E2A\u4E66\u6E90", " sources") + (status.source ? " \xB7 " + status.source.name : "") + (status.total > 6 ? "\uFF08\u540C\u540D\u540C\u4F5C\u8005\u65E0\u7CBE\u786E\u7ED3\u679C\uFF0C\u6B63\u5728\u8FFD\u52A0\u4F5C\u8005\u641C\u7D22\uFF09" : "");
          if (status.state === "failed") throw Error(status.error ?? say("\u641C\u7D22\u5931\u8D25", "Search failed"));
          if (status.state === "complete") {
            const candidates = status.candidates ?? [];
            if (!candidates.length) {
              novelNote.textContent = say("\u6CA1\u6709\u627E\u5230\u5019\u9009\uFF0C\u8BF7\u68C0\u67E5\u4E66\u540D/\u4F5C\u8005\u6216\u6362\u4E00\u4E2A\u4E66\u6E90\u540E\u91CD\u8BD5\u3002", "No candidates found. Check the title/author and try again.");
              return;
            }
            novelProgress.value = 100;
            novelNote.textContent = say("\u627E\u5230 ", "Found ") + candidates.length + say(" \u4E2A\u5019\u9009\uFF1B\u540C\u4E66\u540D\u540C\u4F5C\u8005\u7684\u5176\u4ED6\u4E66\u6E90\u5DF2\u6298\u53E0\u5728\u201C\u5176\u4ED6\u4E66\u6E90\u201D\u91CC\u3002", " candidates; other sources for the same title/author are folded under \u201COther sources\u201D.");
            renderCandidateGroups(candidates);
            return;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
        }
      } finally {
        novelSubmit.disabled = false;
        novelProgress.hidden = true;
        novelProgressText.hidden = true;
      }
    });
  }, { signal: ctx.signal });
  notebook.className = "notebook";
  pages.trail.append(notebook, episodeDetail, searchForm);
  const reviews = details(pages.home, say("\u8FD9\u672C\u4E66\u7684\u8BFB\u540E\u611F", "Reviews of this book"));
  reviews.append(articles, articleDetail);
  const current = el("article", "", pages.home);
  current.className = "card";
  pages.home.prepend(current);
  const readingState = el("div", "", current);
  readingState.className = "reading-state";
  readingState.setAttribute("role", "status");
  readingState.setAttribute("aria-live", "polite");
  const stateLabel = el("strong", "", readingState), stateDetail = el("span", "", readingState);
  const title = el("h2", "", current), chapter = el("p", "", current), meter = el("progress", "", current), pageText = el("p", "", current);
  const meterLabel = el("small", "", current);
  meter.after(meterLabel);
  meter.max = 1;
  meter.setAttribute("aria-label", say("\u5DF2\u786E\u8BA4\u9605\u8BFB\u8FDB\u5EA6", "Confirmed reading progress"));
  current.append(controls);
  controls.className = "controls";
  const help = details(current, say("\u9875\u6570\u600E\u4E48\u7B97\uFF1F", "How are pages counted?"));
  el("small", say("\u6BCF600\u4E2A\u6B63\u6587\u7801\u70B9\u6298\u7B97\u4E00\u9875\uFF0C\u4E0E\u5B57\u53F7\u65E0\u5173\u3002\u4EC5\u8BA1\u5DF2\u786E\u8BA4\u5185\u5BB9\uFF1B\u7F51\u6587\u5168\u4E66\u5C1A\u672A\u7F13\u5B58\u65F6\u4E0D\u663E\u793A\u603B\u9875\u6570\u3002", "600 source code points per page, independent of font size. Only confirmed text counts; uncached remote totals remain unknown."), help);
  const log = el("section", "", current);
  el("h3", say("\u5979\u4EC0\u4E48\u65F6\u5019\u8BFB\u5230\u8FD9\u91CC", "Reading timeline"), log);
  const zone = el("small", "", log);
  const timeline = el("div", "", log);
  timeline.className = "timeline";
  timeline.tabIndex = 0;
  timeline.setAttribute("role", "region");
  timeline.setAttribute("aria-label", say("\u9605\u8BFB\u65F6\u95F4\u8F74\uFF0C\u53EF\u4E0A\u4E0B\u6EDA\u52A8", "Scrollable reading timeline"));
  const mood = el("article", "", pages.home);
  mood.className = "card";
  el("h3", say("\u6700\u8FD1\u7684\u5FC3\u60C5", "Latest mood"), mood);
  const moodText = el("p", "", mood);
  moodText.className = "mood";
  const moodTime = el("small", "", mood);
  const thought = el("article", "", pages.home);
  thought.className = "card";
  el("h3", say("\u5979\u8BFB\u5230\u8FD9\u91CC\u65F6\u2026\u2026", "Her latest thought"), thought);
  const thoughtText = el("p", "", thought);
  thoughtText.className = "thought";
  pages.home.append(reviews);
  const chat = el("section", "", pages.trail);
  chat.className = "card";
  chat.hidden = true;
  const context = el("p", "", chat);
  const question = el("textarea", "", chat);
  question.setAttribute("aria-label", say("\u4F60\u60F3\u548C\u5979\u804A\u4EC0\u4E48\uFF1F", "What would you like to discuss?"));
  let discussionEpisode;
  const conversation = el("div", "", chat);
  conversation.className = "conversation";
  chat.prepend(conversation);
  let conversationSignature = "";
  el("small", say("\u672C\u6B21\u8FD0\u884C\u7684\u8FD1\u671F\u8BA8\u8BBA\u4F1A\u663E\u793A\u5728\u8FD9\u91CC\uFF1B\u91CD\u542F\u540E\u6E05\u7A7A\uFF0C\u4E0D\u5199\u5165\u9605\u8BFB\u624B\u8D26\u3002", "Recent replies in this run appear here; cleared on restart, not saved as journal entries."), chat);
  button(chat, say("\u53D1\u9001\u7ED9\u5927\u80A5\u9C7C", "Send to companion"), async () => {
    if (!discussionEpisode) throw Error("Select a thought first");
    await ctx.invoke("discuss", [{ episodeId: discussionEpisode, text: question.value }]);
    question.value = "";
    context.textContent = say("\u5DF2\u53D1\u9001\u3002\u5927\u80A5\u9C7C\u4F1A\u5728\u684C\u9762\u7528\u51E0\u6761\u77ED\u53E5\u56DE\u590D\uFF0C\u8BB0\u5F55\u4F1A\u540C\u6B65\u5230\u8FD9\u91CC\u3002\u672A\u8BFB\u5185\u5BB9\u53EA\u80FD\u660E\u786E\u731C\u6D4B\u3002", "Sent. She will reply on the desktop in short bubbles; the transcript mirrors here. Unread plot may only be explicitly guessed.");
  });
  async function discuss(id, text, key = state?.status.library.current?.key) {
    discussionEpisode = id;
    conversationSignature = "";
    context.textContent = (state?.books.find((b) => b.key === key)?.title ?? "") + " \xB7 " + Array.from(text).slice(0, 150).join("");
    chat.hidden = false;
    page("trail");
    trailKey = key;
    trailChoice.value = key ?? "";
    const different = key !== state?.status.library.current?.key;
    notebook.hidden = different;
    episodeDetail.hidden = different;
    searchForm.hidden = different;
    otherTrail.hidden = !different;
    if (different && key) await showOtherTrail(key);
    await update?.();
    question.focus();
  }
  root.addEventListener("bookfish-discuss", (event) => {
    const data = event.detail;
    void perform(() => discuss(data.id, data.text));
  }, { signal: ctx.signal });
  const bookDetail = el("section", "", pages.bookDetail);
  bookDetail.className = "card";
  bookDetail.hidden = true;
  let browsingBook;
  const humanReader = readerPanel(ctx, pages.reader, () => page("bookDetail"));
  async function showBook(key) {
    browsingBook = key;
    const data = await ctx.invoke("book", [key]);
    if (disposed || ctx.signal.aborted || browsingBook !== key) return;
    bookDetail.replaceChildren();
    bookDetail.hidden = false;
    page("bookDetail");
    button(bookDetail, say("\u2190 \u8FD4\u56DE\u4E66\u67B6", "\u2190 Bookshelf"), async () => page("shelf"));
    const detailHead = el("div", "", bookDetail);
    detailHead.className = "detail-head";
    const detailCover = el("div", "", detailHead);
    paintCover(detailCover, data.book);
    const detailInfo = el("div", "", detailHead);
    detailInfo.className = "detail-info";
    el("h2", data.book.title, detailInfo);
    el("small", data.book.author || say("\u4F5C\u8005\u672A\u8BC6\u522B", "Author unknown"), detailInfo);
    el("p", say("\u5DF2\u8BFB " + Math.ceil(data.book.confirmedChars / 600) + " \u9875", "Read " + Math.ceil(data.book.confirmedChars / 600) + " pages"), detailInfo);
    const detailActions = el("div", "", detailInfo);
    detailActions.className = "detail-actions";
    button(detailActions, say("\u9605\u8BFB\u6B63\u6587", "Read the novel"), async () => {
      page("reader");
      await humanReader.open(key);
    }).className = "primary";
    if (state?.status.library.current?.key === key) button(detailActions, say("\u56DE\u5230\u6B63\u5728\u8BFB", "Back to reading"), async () => page("home"));
    if (!data.book.complete) button(detailActions, say("\u73B0\u5728\u5F00\u59CB\u8BFB\u8FD9\u672C", "Start reading this book now"), async () => {
      if (state?.status.library.current?.key !== key) await ctx.invoke("select", [key]);
      page("home");
      await requestReading(key);
    }).className = "bf-start-reading";
    button(detailActions, say("\u67E5\u770B\u9605\u8BFB\u8DB3\u8FF9", "View reading journal"), async () => {
      trailKey = key;
      trailChoice.value = key;
      const different = key !== state?.status.library.current?.key;
      notebook.hidden = different;
      episodeDetail.hidden = different;
      searchForm.hidden = different;
      otherTrail.hidden = !different;
      page("trail");
      if (different) await showOtherTrail(key);
    });
    const remove = el("button", say("\u79FB\u9664\u8FD9\u672C\u4E66", "Remove this book"), detailActions);
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "remove-book";
    remove.addEventListener("click", () => {
      void (async () => {
        if (busy || disposed || ctx.signal.aborted) return;
        const confirmed = await ctx.ui.confirm({ title: say("\u79FB\u9664\u300A" + data.book.title + "\u300B\uFF1F", "Remove \u201C" + data.book.title + "\u201D?"), body: say("\u6B63\u6587\u3001\u786E\u8BA4\u8FDB\u5EA6\u3001\u9605\u8BFB\u624B\u8D26\u3001\u8BFB\u540E\u611F\u53CA\u5BF9\u5E94\u5206\u4EAB\u6587\u672C\u90FD\u4F1A\u5220\u9664\uFF0C\u4E14\u65E0\u6CD5\u64A4\u9500\u3002", "The text, confirmed progress, reading journal, reviews and related share text will be deleted. This cannot be undone."), danger: true });
        if (!confirmed || disposed || ctx.signal.aborted) return;
        await perform(async () => {
          await ctx.invoke("remove", [key]);
          browsingBook = void 0;
          page("shelf");
          ctx.ui.toast(say("\u5DF2\u79FB\u9664\u300A" + data.book.title + "\u300B", "Removed \u201C" + data.book.title + "\u201D"));
        });
      })();
    }, { signal: ctx.signal });
    const history = details(bookDetail, say("\u6700\u8FD1\u611F\u60F3", "Recent thoughts"));
    for (const item of data.journal.items) {
      el("p", moodPrefix(item.mood?.label) + item.interpretation, history);
      button(history, say("\u804A\u804A\u8FD9\u4E00\u6BB5", "Discuss this passage"), async () => discuss(item.id, item.interpretation, key));
    }
    const manage = details(bookDetail, say("\u4E66\u7C4D\u6765\u6E90\u4E0E\u7BA1\u7406", "Source and management"));
    el("p", data.book.source ? data.book.source.bookUrl : say("\u672C\u5730\u5BFC\u5165", "Local file"), manage);
    el("small", say("\u7248\u672C ", "Revision ") + data.book.revision.slice(0, 8), manage);
    const serialInfo = data.book.serial;
    if (serialInfo) {
      const section = details(bookDetail, say("\u8FDE\u8F7D\u8FFD\u66F4", "Serial following"));
      section.open = true;
      const serialBadge = el("span", say("\u5B9E\u9A8C\u529F\u80FD", "Experimental"), section.querySelector("summary"));
      serialBadge.className = "badge experimental";
      const readinessLabel = { backlog: say("\u6709\u672A\u8BFB\u6B63\u6587", "Unread text available"), waiting_content: say("\u7B49\u5F85\u6B63\u6587", "Waiting for text"), caught_up: say("\u5DF2\u8FFD\u5E73\uFF0C\u7B49\u5F85\u66F4\u65B0", "Caught up; waiting for updates"), finished: say("\u5DF2\u5B8C\u7ED3", "Finished"), conflict: say("\u76EE\u5F55\u51B2\u7A81\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u540C\u6B65", "Catalog conflict; automatic checks stopped") };
      const publication = serialInfo.publicationEvidence.status === "finished" ? say("\u5DF2\u5B8C\u7ED3", "Finished") : serialInfo.publicationEvidence.status === "ongoing" ? say("\u8FDE\u8F7D\u4E2D", "Ongoing") : say("\u72B6\u6001\u672A\u77E5", "Unknown");
      el("p", publication + " \xB7 " + say("\u5DF2\u8BFB ", "Read ") + serialInfo.confirmedChapters + "/" + serialInfo.discoveredChapters + say(" \u7AE0 \xB7 \u53EF\u8BFB ", " chapters \xB7 readable ") + serialInfo.cachedChapters + say(" \u7AE0 \xB7 ", " chapters \xB7 ") + (readinessLabel[data.book.readiness] ?? data.book.readiness), section);
      el("small", say("\u81EA\u52A8\u68C0\u67E5\uFF1A", "Automatic checks: ") + (serialInfo.subscription.enabled ? say("\u5DF2\u5F00\u542F\uFF0C\u6BCF ", "on, every ") + serialInfo.subscription.intervalMinutes + say(" \u5206\u949F", " minutes") : say("\u5DF2\u5173\u95ED", "off")) + (serialInfo.subscription.lastSuccessfulCheckAt ? say(" \xB7 \u6700\u8FD1\u6210\u529F ", " \xB7 last success ") + new Date(serialInfo.subscription.lastSuccessfulCheckAt).toLocaleString() : say(" \xB7 \u5C1A\u65E0\u6210\u529F\u68C0\u67E5", " \xB7 no successful check yet")), section);
      if (serialInfo.authorization !== "allowed") el("small", say("\u6765\u6E90\u7528\u9014\u6388\u6743\u672A\u786E\u8BA4\uFF1B\u53EA\u7F13\u5B58\u672C\u673A\u9605\u8BFB\uFF0C\u4E0D\u5BA3\u79F0\u6B63\u7248\u63A5\u5165\u3002", "Source permission is unconfirmed; local reading cache only, not a licensed integration."), section);
      if (serialInfo.lastCheck) el("small", say("\u6700\u8FD1\u68C0\u67E5\uFF1A", "Last check: ") + serialInfo.lastCheck.status + " \xB7 " + serialInfo.lastCheck.message, section);
      button(section, say("\u68C0\u67E5\u66F4\u65B0", "Check for updates"), async () => {
        const started = await ctx.invoke("serial_check", [key]);
        await pollSerialJob(started.jobId);
      });
      button(section, serialInfo.subscription.enabled ? say("\u5173\u95ED\u81EA\u52A8\u8FFD\u66F4", "Disable automatic checks") : say("\u5F00\u542F\u81EA\u52A8\u8FFD\u66F4", "Enable automatic checks"), async () => {
        await ctx.invoke("serial_set_subscription", [key, !serialInfo.subscription.enabled, serialInfo.subscription.intervalMinutes]);
        await perform(async () => {
        });
        if (browsingBook === key) await showBook(key);
      });
      if (state?.serial.active?.bookKey === key) button(section, say("\u53D6\u6D88\u672C\u6B21\u540C\u6B65", "Cancel this sync"), async () => {
        await ctx.invoke("serial_cancel", [state.serial.active.jobId]);
        await perform(async () => {
        });
        if (browsingBook === key) await showBook(key);
      });
    }
    el("h3", say("\u8BFB\u540E\u611F", "Book reviews"), bookDetail);
    if (!data.reviews.versions.length) el("p", data.book.complete ? say("\u8FD8\u6CA1\u6709\u5199\u8BFB\u540E\u611F\u3002", "No review yet.") : say("\u8BFB\u5B8C\u540E\uFF0C\u5979\u4F1A\u5728\u8FD9\u91CC\u7559\u4E0B\u8BFB\u540E\u611F\u3002", "Her review will appear here after completion."), bookDetail);
    const article = el("section", "", bookDetail);
    article.style.whiteSpace = "pre-wrap";
    for (const version of [...data.reviews.versions].reverse()) button(bookDetail, "v" + version.version + " \xB7 " + version.title, async () => {
      const saved = await ctx.invoke("review", [version.id]);
      if (disposed || browsingBook !== key) return;
      article.replaceChildren();
      el("h3", saved.review.title, article);
      el("p", saved.review.text, article);
      const sources = details(article, say("\u67E5\u770B\u5199\u4F5C\u4F9D\u636E", "View writing sources"));
      for (const quote of saved.evidence) el("blockquote", quote.quote, sources);
    });
  }
  root.addEventListener("bookfish-book", (event) => {
    const data = event.detail;
    void perform(() => showBook(data.key));
  }, { signal: ctx.signal });
  const trailChoice = el("select", "", pages.trail);
  trailChoice.setAttribute("aria-label", say("\u9009\u62E9\u8DB3\u8FF9\u4E66\u7C4D", "Choose journal book"));
  pages.trail.prepend(trailChoice);
  const otherTrail = el("section", "", pages.trail);
  otherTrail.hidden = true;
  let trailKey, trailSignature = "";
  async function showOtherTrail(key, before2) {
    const data = await ctx.invoke("journal", [{ bookKey: key, before: before2, limit: 5 }]);
    if (disposed || ctx.signal.aborted || trailKey !== key) return;
    otherTrail.replaceChildren();
    for (const item of data.items) {
      const card = el("article", "", otherTrail);
      card.className = "card";
      el("small", new Date(item.recordedAt).toLocaleString() + " \xB7 " + item.chapters.join(" / "), card);
      el("p", moodPrefix(item.mood?.label) + item.interpretation, card);
      button(card, say("\u804A\u804A\u8FD9\u4E00\u6BB5", "Discuss this passage"), async () => discuss(item.id, item.interpretation, key));
      const evidence = details(card, say("\u67E5\u770B\u539F\u6587\u4F9D\u636E\u4E0E\u7406\u7531", "View evidence and explanation"));
      button(evidence, say("\u8F7D\u5165\u539F\u6587\u4F9D\u636E", "Load evidence"), async () => {
        const record = await ctx.invoke("episode", [item.id]);
        if (disposed || trailKey !== key) return;
        for (const quote of record.evidence) el("blockquote", quote.quote, evidence);
        el("p", record.episode.content.reason ?? say("\u672A\u8BB0\u5F55\u5F53\u65F6\u7406\u7531\u3002", "No reason recorded."), evidence);
      });
    }
    if (!data.items.length) el("p", say("\u8FD9\u672C\u4E66\u8FD8\u6CA1\u6709\u611F\u60F3\u8DB3\u8FF9\u3002", "No journal entries for this book."), otherTrail);
    if (data.nextBefore) button(otherTrail, say("\u66F4\u65E9\u7684\u8BB0\u5F55", "Earlier records"), () => showOtherTrail(key, data.nextBefore));
    if (before2 !== void 0) button(otherTrail, say("\u8FD4\u56DE\u6700\u65B0\u8BB0\u5F55", "Latest records"), () => showOtherTrail(key));
  }
  trailChoice.addEventListener("change", () => {
    trailKey = trailChoice.value;
    const different = trailKey !== state?.status.library.current?.key;
    notebook.hidden = different;
    episodeDetail.hidden = different;
    searchForm.hidden = different;
    otherTrail.hidden = !different;
    if (different) void perform(() => showOtherTrail(trailKey));
  }, { signal: ctx.signal });
  const discussLatest = button(thought, say("\u804A\u804A\u8FD9\u4E00\u6BB5", "Discuss this passage"), async () => {
    const e = state?.journal?.items[0];
    if (e) await discuss(e.id, e.interpretation);
  });
  button(thought, say("\u67E5\u770B\u9605\u8BFB\u8DB3\u8FF9 \u2192", "View journal \u2192"), async () => page("trail"));
  for (const b of [...controls.querySelectorAll("button")]) {
    const t = b.textContent;
    if (t === say("\u6682\u505C\u9605\u8BFB", "Pause") || t === say("\u7EE7\u7EED\u9605\u8BFB", "Resume") || t === say("\u7ED3\u675F\u4F11\u606F", "End rest")) continue;
    if (t === say("\u8BF7\u6C42\u5199\u4E00\u7248\u5168\u4E66\u8BFB\u540E\u611F", "Request a full-book review")) reviews.append(b);
    else advanced.append(b);
  }
  for (const child of [...old.children]) {
    if (child === heading || child === nav || child === messages || Object.values(pages).includes(child)) continue;
    advanced.append(child);
  }
  let timelineEpoch = 0;
  let before, timelineKey = "", timelineRevision = "";
  async function loadTimeline(append = false) {
    const epoch = append ? timelineEpoch : ++timelineEpoch;
    const key = state?.status.library.current?.key;
    if (!key) {
      timeline.replaceChildren();
      return;
    }
    const data = await ctx.invoke("timeline", [{ bookKey: key, ...append && before !== void 0 ? { before } : {} }]);
    if (disposed || ctx.signal.aborted || epoch !== timelineEpoch || key !== state?.status.library.current?.key) return;
    if (!append) timeline.replaceChildren();
    else timeline.querySelector("button")?.remove();
    before = data.nextBefore ?? void 0;
    const entries = [...data.items.map((item) => ({ type: "reading", at: item.confirmedAt ?? 0, item })), ...data.rests.map((rest) => ({ type: "rest", at: rest.startedAt, rest }))].sort((a, b) => b.at - a.at || (a.type === "rest" ? -1 : 1));
    for (const event of entries) {
      if (event.type === "rest") {
        const r = event.rest, row2 = el("article", "", timeline);
        el("time", new Date(r.startedAt).toLocaleString(ctx.language, { timeZone: state.status.sharing.timezone }), row2);
        el("p", say("\u2615 \u4F11\u606F\u4E00\u4F1A\u513F", "\u2615 Taking a break"), row2);
        el("small", r.state === "scheduled" ? say("\u9884\u8BA1\u7EE7\u7EED\uFF1A", "Expected to resume: ") + new Date(r.plannedUntil).toLocaleTimeString(ctx.language, { timeZone: state.status.sharing.timezone }) : r.state === "ended" ? say("\u8FD9\u6B21\u4F11\u606F\u5DF2\u7ED3\u675F", "This break ended") : r.state === "skipped" ? say("\u8FD9\u6B21\u4F11\u606F\u5DF2\u63D0\u524D\u7ED3\u675F", "This break ended early") : say("\u7A0B\u5E8F\u505C\u6B62\uFF0C\u8FD9\u6B21\u4F11\u606F\u5DF2\u4E2D\u65AD", "This break was interrupted when the app stopped"), row2);
        continue;
      }
      const item = event.item;
      const row = el("article", "", timeline);
      el("time", item.confirmedAt === null ? say("\u65F6\u95F4\u672A\u8BB0\u5F55\uFF08\u65E7\u8BB0\u5F55\uFF09", "Time unavailable (legacy record)") : new Date(item.confirmedAt).toLocaleString(ctx.language, { timeZone: state.status.sharing.timezone }), row);
      const first = item.summary.match(/^.*?[。！？.!?]/u)?.[0] ?? item.summary;
      const chars = Array.from(first);
      const brief = chars.slice(0, 55).join("") + (chars.length > 55 ? "\u2026" : "");
      el("p", brief, row);
      el("small", item.mood ? say("\u{1F41F} \u5927\u80A5\u9C7C\u5F53\u65F6\u7684\u9605\u8BFB\u5FC3\u60C5\uFF1A", "\u{1F41F} Her reading mood at the time: ") + moodPrefix(item.mood.label) + item.mood.label : say("\u5927\u80A5\u9C7C\u5F53\u65F6\u672A\u8BB0\u5F55\u9605\u8BFB\u5FC3\u60C5", "No reading mood recorded at the time"), row);
      if (Array.from(item.summary).length > Array.from(brief).length) {
        const full = details(row, say("\u5C55\u5F00\u5267\u60C5\u6458\u8981", "Full plot summary"));
        el("p", item.summary, full);
      }
    }
    if (!entries.length && !append) el("p", say("\u8FD8\u6CA1\u6709\u786E\u8BA4\u8BFB\u8FC7\u7684\u5185\u5BB9\u3002", "No confirmed reading yet."), timeline);
    if (before !== void 0) button(timeline, say("\u52A0\u8F7D\u66F4\u65E9\u9605\u8BFB", "Load earlier reading"), () => loadTimeline(true));
  }
  function paintCover(parent, book) {
    const design = coverDesign(book);
    parent.classList.add("book-cover");
    parent.dataset.palette = String(design.palette);
    parent.replaceChildren();
    const mark = document.createElement("span");
    mark.className = "cover-mark";
    mark.textContent = design.mark;
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "cover-copy";
    const title2 = document.createElement("span");
    title2.className = "cover-title";
    title2.textContent = design.title || say("\u672A\u547D\u540D", "Untitled");
    const rule = document.createElement("span");
    rule.className = "cover-rule";
    rule.setAttribute("aria-hidden", "true");
    const author = document.createElement("span");
    author.className = "cover-author";
    author.textContent = design.author || say("\u4F5C\u8005\u672A\u8BC6\u522B", "Author unknown");
    copy.append(title2, rule, author);
    const foot = document.createElement("span");
    foot.className = "cover-foot";
    foot.textContent = design.sourceHost ?? (design.hasSource ? say("\u7F51\u7EDC\u4E66\u6E90", "Online source") : say("\u672C\u5730\u5BFC\u5165", "Local file"));
    parent.append(mark, copy, foot);
  }
  const hero = el("div", "", current);
  hero.className = "reading-hero";
  current.prepend(hero);
  current.prepend(readingState);
  const heroCover = button(hero, say("\u67E5\u770B\u5F53\u524D\u4E66\u7C4D\u8BE6\u60C5", "View current book"), async () => {
    if (state?.status.library.current) await showBook(state.status.library.current.key);
  });
  heroCover.className = "cover-button";
  heroCover.setAttribute("aria-label", say("\u67E5\u770B\u5F53\u524D\u4E66\u7C4D\u8BE6\u60C5", "View current book"));
  const heroInfo = el("div", "", hero);
  heroInfo.append(title, chapter, meter, meterLabel);
  const heroFooter = el("div", "", heroInfo);
  heroFooter.className = "hero-footer";
  heroFooter.append(pageText);
  const heroActions = el("div", "", heroFooter);
  heroActions.className = "hero-actions";
  const viewBookButton = button(heroActions, say("\u67E5\u770B\u8FD9\u672C\u4E66 \u2197", "View this book \u2197"), async () => {
    if (state?.status.library.current) await showBook(state.status.library.current.key);
  });
  const emptyRecommend = button(heroActions, say("\uFF0B \u63A8\u8350\u4E00\u672C\u4E66", "\uFF0B Recommend a book"), async () => {
    page("shelf");
    addBook.click();
  });
  emptyRecommend.className = "primary";
  emptyRecommend.hidden = true;
  heroActions.append(help);
  let manualUiError = "";
  async function requestReading(key) {
    manualUiError = "";
    readNow.disabled = true;
    readNotice.textContent = say("\u6B63\u5728\u53D1\u9001\u9605\u8BFB\u8BF7\u6C42\u2026", "Sending a reading request\u2026");
    try {
      return await ctx.invoke("read_now", [key]);
    } catch (error) {
      manualUiError = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/, "");
      readNotice.textContent = manualUiError;
      throw error;
    }
  }
  for (const b of controls.querySelectorAll("button")) if (b.textContent === say("\u6682\u505C\u9605\u8BFB", "Pause") || b.textContent === say("\u7EE7\u7EED\u9605\u8BFB", "Resume")) b.remove();
  const pauseReading = button(heroActions, say("\u6682\u505C\u9605\u8BFB", "Pause reading"), async () => {
    await ctx.invoke("pause", [true]);
  });
  const readActions = el("div", "", current);
  hero.after(readActions);
  readActions.className = "read-now";
  const readNow = button(readActions, say("\u7EE7\u7EED\u8BFB", "Read a passage now"), async () => {
    const key = state?.status.library.current?.key;
    if (key) await requestReading(key);
  });
  readNow.className = "primary";
  heroActions.append(readNow, pauseReading);
  const readNotice = el("p", "", readActions);
  readNotice.setAttribute("role", "status");
  readNotice.setAttribute("aria-live", "polite");
  const goalStatus = el("small", "", readActions), restStatus = el("p", "", readActions);
  restStatus.setAttribute("role", "status");
  const shelfToolbar = el("div", "", pages.shelf);
  shelfToolbar.className = "shelf-toolbar";
  pages.shelf.prepend(shelfToolbar);
  const search = el("input", "", shelfToolbar);
  search.type = "search";
  search.placeholder = say("\u641C\u7D22\u4E66\u540D\u6216\u4F5C\u8005", "Search title or author");
  search.setAttribute("aria-label", say("\u641C\u7D22\u4E66\u67B6", "Search bookshelf"));
  const filter = el("select", "", shelfToolbar);
  filter.setAttribute("aria-label", say("\u4E66\u67B6\u7B5B\u9009", "Filter bookshelf"));
  for (const [value, label] of [["all", say("\u5168\u90E8", "All")], ["unfinished", say("\u672A\u8BFB\u5B8C", "Unfinished")], ["finished", say("\u5DF2\u8BFB\u5B8C", "Finished")]]) {
    const option = el("option", label, filter);
    option.value = value;
  }
  const sort = el("select", "", shelfToolbar);
  sort.setAttribute("aria-label", say("\u4E66\u67B6\u6392\u5E8F", "Sort bookshelf"));
  for (const [value, label] of [["added", say("\u6700\u8FD1\u5165\u67B6", "Recently added")], ["title", say("\u4E66\u540D\u6392\u5E8F", "Title")]]) {
    const option = el("option", label, sort);
    option.value = value;
  }
  const coverGrid = el("div", "", pages.shelf);
  coverGrid.className = "cover-grid";
  recommend.after(coverGrid);
  const addBook = el("button", say("\uFF0B \u63A8\u8350\u4E00\u672C\u4E66", "\uFF0B Recommend a book"), shelfToolbar);
  addBook.type = "button";
  addBook.className = "primary";
  addBook.setAttribute("aria-controls", recommend.id);
  addBook.setAttribute("aria-expanded", "false");
  const selectionPanel = el("section", "", pages.shelf);
  selectionPanel.className = "selection-panel";
  selectionPanel.hidden = true;
  coverGrid.after(selectionPanel);
  const selectionNotice = el("p", "", current);
  selectionNotice.className = "selection-notice";
  selectionNotice.hidden = true;
  readingState.after(selectionNotice);
  const selectionStateLabel = { proposed: say("\u51C6\u5907\u627E\u4E66", "Preparing"), searching: say("\u6B63\u5728\u627E", "Searching"), awaiting_choice: say("\u7B49\u4F60\u9009\u7248\u672C", "Awaiting a version choice"), acquiring: say("\u6B63\u5728\u83B7\u53D6\u5E76\u6821\u9A8C", "Acquiring and verifying"), fulfilled: say("\u5DF2\u5165\u67B6\uFF0C\u6392\u961F\u4E2D", "Shelved and queued"), reading: say("\u81EA\u9009\u4E66\u5728\u8BFB", "Reading her pick"), completed: say("\u81EA\u9009\u4E66\u5DF2\u8BFB\u5B8C", "Her pick is finished"), deferred: say("\u5DF2\u6682\u505C", "Paused"), failed: say("\u8FD9\u672C\u6CA1\u6210\u529F", "This work failed"), cancelled: say("\u5DF2\u53D6\u6D88", "Cancelled"), abandoned: say("\u5DF2\u653E\u5F03", "Abandoned") };
  function selectionCard(intent, parent = selectionPanel) {
    const card = el("article", "", parent);
    card.className = "selection-intent";
    const head = el("div", "", card);
    head.className = "selection-head";
    el("strong", "\u300A" + intent.title + "\u300B" + (intent.author ? " \xB7 " + intent.author : ""), head);
    el("span", selectionStateLabel[intent.status] ?? intent.status, head).className = "selection-badge";
    el("blockquote", intent.reason, card);
    if (intent.source) el("small", say("\u6765\u6E90\uFF1A", "Source: ") + intent.source, card);
    if (intent.task) {
      const bar = el("progress", "", card);
      bar.max = 100;
      bar.value = intent.task.percent;
      bar.setAttribute("aria-label", say("\u83B7\u53D6\u8FDB\u5EA6", "Acquisition progress"));
      el("small", intent.task.stage + " \xB7 " + intent.task.downloaded + "/" + intent.task.total + (intent.task.warningCount ? say(" \xB7 " + intent.task.warningCount + " \u6761\u8B66\u544A", " \xB7 " + intent.task.warningCount + " warnings") : ""), card);
      if (intent.task.error) el("small", intent.task.error, card).className = "selection-error";
    }
    if (intent.failure) el("small", intent.failure.message, card).className = "selection-error";
    if (intent.status === "awaiting_choice" && intent.candidates?.length) {
      el("small", say("\u6838\u5BF9\u6765\u6E90\u548C\u7248\u672C\u540E\u9009\u62E9\u4E00\u4E2A\uFF1A", "Choose one after checking source and edition:"), card);
      for (const candidate of intent.candidates) {
        const choose = button(card, (candidate.available ? "" : "\u23F3 ") + candidate.source, async () => ctx.invoke("selection_acquire_candidate", [candidate.candidateId]));
        choose.disabled = !candidate.available;
      }
    }
    if (["proposed", "searching", "acquiring"].includes(intent.status)) button(card, say("\u53D6\u6D88\u8FD9\u6B21\u627E\u4E66", "Cancel this search"), async () => {
      if (!await ctx.ui.confirm({ title: say("\u53D6\u6D88\u81EA\u9009\u4E66\u83B7\u53D6\uFF1F", "Cancel this acquisition?"), body: say("\u5DF2\u5165\u67B6\u7684\u4E66\u4E0D\u4F1A\u5220\u9664\uFF1B\u53D6\u6D88\u4E0D\u4F1A\u81EA\u52A8\u6362\u4E66\u6216\u7EED\u4F20\u3002", "Shelved books stay; cancelling never auto-switches or resumes."), danger: true })) return;
      await ctx.invoke("selection_cancel", [intent.id]);
    });
    if (intent.bookKey && ["fulfilled", "reading"].includes(intent.status)) {
      button(card, say("\u67E5\u770B\u8FD9\u672C\u4E66", "View this book"), async () => showBook(intent.bookKey));
      button(card, say("\u653E\u5F03\u8FD9\u672C\u81EA\u9009\u4E66", "Abandon this pick"), async () => {
        if (!await ctx.ui.confirm({ title: say("\u653E\u5F03\u8FD9\u672C\u81EA\u9009\u4E66\uFF1F", "Abandon this self-selected book?"), body: say("\u53EA\u4F1A\u7ED3\u675F\u201C\u6CA1\u8BFB\u5B8C\u4E0D\u627E\u4E0B\u4E00\u672C\u201D\u7684\u627F\u8BFA\uFF0C\u4E0D\u5220\u9664\u4E66\u3001\u4E0D\u6539\u53D8\u9605\u8BFB\u8FDB\u5EA6\u3002", "This only ends the \u201Cno next pick until finished\u201D promise; the book and progress stay."), danger: true })) return;
        await ctx.invoke("selection_abandon", [intent.id]);
      });
    }
    return card;
  }
  function renderSelection() {
    if (!state) return;
    const selection = state.selection;
    const signature = JSON.stringify(selection);
    if (signature === selectionSignature) return;
    selectionSignature = signature;
    const activeIntents = selection?.intents.filter((intent) => !["failed", "abandoned", "cancelled"].includes(intent.status)) ?? [];
    const pastIntents = selection?.intents.filter((intent) => ["failed", "abandoned", "cancelled"].includes(intent.status)) ?? [];
    selectionPanel.hidden = !selection || !activeIntents.length && !pastIntents.length && !selection.queue.length && !selection.notice;
    selectionPanel.replaceChildren();
    if (!selection) return;
    el("h3", say("\u5979\u60F3\u8BFB\u7684", "She wants to read"), selectionPanel);
    if (selection.commitment) el("p", say("\u81EA\u9009\u4E66\u300A" + selection.commitment.title + "\u300B\u8FD8\u6CA1\u8BFB\u5B8C\uFF0C\u6682\u4E0D\u627E\u4E0B\u4E00\u672C\uFF1B\u6392\u961F\u3001\u6682\u505C\u3001\u4E34\u65F6\u5207\u4E66\u548C\u91CD\u542F\u90FD\u4E0D\u89E3\u9664\u3002", "Her pick \u201C" + selection.commitment.title + "\u201D is unfinished, so she will not look for another yet. Queuing, pausing, switching books or restarting do not release this gate."), selectionPanel).className = "selection-gate";
    else if (selection.notice && !selection.commitment) el("p", selection.notice, selectionPanel).className = "selection-gate";
    if (selection.round && (selection.round.status === "open" || selection.round.status === "paused")) el("small", say("\u672C\u8F6E\u5DF2\u5C1D\u8BD5 ", "Tried this round: ") + selection.round.attempts + "/3" + (selection.round.status === "paused" ? say(" \xB7 \u56E0\u5168\u5C40\u539F\u56E0\u6682\u505C", " \xB7 paused for a global reason") : ""), selectionPanel);
    for (const intent of activeIntents) selectionCard(intent);
    if (pastIntents.length) {
      const history = document.createElement("details");
      history.className = "selection-history";
      const summary = el("summary", say("\u672A\u6210\u529F\u7684\u60F3\u8BFB\u8BB0\u5F55\uFF08", "Unsuccessful reading wishes (") + pastIntents.length + "\uFF09", history);
      summary.setAttribute("aria-label", say("\u5C55\u5F00\u67E5\u770B\u672A\u6210\u529F\u7684\u60F3\u8BFB\u8BB0\u5F55", "Show unsuccessful reading wishes"));
      selectionPanel.append(history);
      for (const intent of pastIntents) selectionCard(intent, history);
    }
    if (selection.queue.length) {
      el("h3", say("\u63A5\u4E0B\u6765\u8BFB", "Next to read"), selectionPanel);
      for (const item of selection.queue) {
        const card = el("article", "", selectionPanel);
        card.className = "selection-queue";
        const head = el("div", "", card);
        head.className = "selection-head";
        el("strong", "\u300A" + item.title + "\u300B", head);
        el("span", item.status === "active" ? say("\u6B63\u5728\u8BFB", "Reading") : item.status === "done" ? say("\u5DF2\u5B8C\u6210", "Done") : item.status === "cancelled" ? say("\u5DF2\u79FB\u51FA", "Removed") : say("\u6392\u961F\u4E2D", "Queued"), head).className = "selection-badge";
        if (item.notBefore) el("small", say("\u6700\u65E9\u5B89\u6392\uFF1A", "Not before: ") + new Date(item.notBefore).toLocaleString(), card);
        if (item.bookExists && item.status === "queued") button(card, say("\u73B0\u5728\u5207\u6362\u5230\u8FD9\u672C", "Switch to this book"), async () => ctx.invoke("select", [item.bookKey]));
        if (item.bookExists && item.status === "queued" && !item.bookComplete) button(card, say("\u653E\u5F03\u8FD9\u672C\u81EA\u9009\u4E66", "Abandon this pick"), async () => {
          const intent = selection.intents.find((entry) => entry.bookKey === item.bookKey);
          if (!intent) return;
          if (!await ctx.ui.confirm({ title: say("\u653E\u5F03\u8FD9\u672C\u81EA\u9009\u4E66\uFF1F", "Abandon this self-selected book?"), body: say("\u53EA\u4F1A\u7ED3\u675F\u627F\u8BFA\uFF0C\u4E0D\u5220\u9664\u4E66\u6216\u8FDB\u5EA6\u3002", "This only ends the promise; the book and progress stay."), danger: true })) return;
          await ctx.invoke("selection_abandon", [intent.id]);
        });
      }
    }
    if (!activeIntents.length && !pastIntents.length && !selection.queue.length) el("p", say("\u5979\u8FD8\u6CA1\u6709\u81EA\u5DF1\u63D0\u51FA\u60F3\u8BFB\u7684\u4E66\u3002\u5F00\u542F\u201C\u8BA9\u5979\u81EA\u5DF1\u627E\u4E66\uFF08\u5B9E\u9A8C\u529F\u80FD\uFF09\u201D\u540E\uFF0C\u5979\u4F1A\u5728\u5408\u9002\u7684\u65F6\u5019\u63D0\u51FA\u3002", "She has not proposed a book yet. Enable \u201CLet her find her own books (Experimental)\u201D and she may propose one when appropriate."), selectionPanel);
  }
  let selectionSignature = "";
  addBook.addEventListener("click", () => {
    recommend.hidden = false;
    addBook.setAttribute("aria-expanded", "true");
    methodSelect.value = "file";
    selectImportMethod("file", true);
    recommend.scrollIntoView?.({ block: "nearest" });
  }, { signal: ctx.signal });
  closeRecommend.addEventListener("click", () => {
    recommend.hidden = true;
    addBook.setAttribute("aria-expanded", "false");
    addBook.focus();
  }, { signal: ctx.signal });
  pages.shelf.append(advanced);
  let shelfSignature = "";
  function renderShelf() {
    if (!state) return;
    const signature = JSON.stringify([state.books, state.status.library.current?.key, search.value, filter.value, sort.value]);
    if (signature === shelfSignature) return;
    shelfSignature = signature;
    coverGrid.replaceChildren();
    const q = search.value.trim().toLocaleLowerCase();
    const books = [...state.books].reverse().filter((b) => (!q || (b.title + " " + b.author).toLocaleLowerCase().includes(q)) && (filter.value === "all" || (filter.value === "finished" ? b.complete : !b.complete)));
    if (sort.value === "title") books.sort((a, b) => a.title.localeCompare(b.title, en ? void 0 : "zh-Hans-CN", { numeric: true, sensitivity: "base" }) || a.key.localeCompare(b.key));
    for (const b of books) {
      const card = el("article", "", coverGrid);
      const open = button(card, say("\u67E5\u770B\u8FD9\u672C\u4E66\uFF1A", "View book: ") + b.title, async () => showBook(b.key));
      open.className = "cover-button";
      open.setAttribute("aria-label", say("\u67E5\u770B\u8FD9\u672C\u4E66\uFF1A", "View book: ") + b.title);
      open.textContent = "";
      const cover = el("span", "", open);
      paintCover(cover, b);
      el("strong", b.title, card);
      el("small", b.key === state.status.library.current?.key ? say("\u6B63\u5728\u8BFB", "Reading") : b.serial ? b.readiness === "caught_up" ? say("\u5DF2\u8FFD\u5E73", "Caught up") : b.readiness === "waiting_content" ? say("\u7B49\u5F85\u6B63\u6587", "Waiting for text") : b.readiness === "conflict" ? say("\u76EE\u5F55\u51B2\u7A81", "Catalog conflict") : b.readiness === "finished" ? say("\u5DF2\u5B8C\u7ED3", "Finished") : say("\u8FDE\u8F7D\u4E2D", "Serial") : b.complete ? say("\u5DF2\u8BFB\u5B8C", "Finished") : b.confirmedChars ? say("\u8BFB\u8FC7\u4E00\u4E9B", "Started") : say("\u672A\u5F00\u59CB", "Not started"), card);
      const more = details(card, "\u22EF");
      button(more, say("\u4E66\u7C4D\u8BE6\u60C5\u4E0E\u7BA1\u7406", "Book details and management"), async () => showBook(b.key));
    }
    if (!books.length) el("p", say("\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4E66\u3002", "No matching books."), coverGrid);
  }
  search.addEventListener("input", renderShelf, { signal: ctx.signal });
  filter.addEventListener("change", renderShelf, { signal: ctx.signal });
  sort.addEventListener("change", renderShelf, { signal: ctx.signal });
  update = async () => {
    if (!state || disposed || ctx.signal.aborted) return;
    const c = state.status.library.current;
    const empty = !c;
    hero.classList.toggle("is-empty", empty);
    viewBookButton.hidden = empty;
    emptyRecommend.hidden = !empty;
    readActions.hidden = empty;
    readNow.hidden = empty;
    pauseReading.hidden = empty;
    reviews.hidden = empty;
    log.hidden = empty;
    renderShelf();
    renderSelection();
    renderNovelTasks(state.novel);
    const selection = state.selection;
    selectionNotice.hidden = !selection?.notice;
    selectionNotice.textContent = selection?.notice ?? "";
    if (state.novel.tasks.some((task) => ["queued", "fetching", "validating"].includes(task.state))) startNovelPoll();
    heroCover.replaceChildren();
    if (c) {
      const cover = el("span", "", heroCover);
      paintCover(cover, c);
    }
    heroCover.hidden = !c;
    const messagesForEpisode = state.discussions.filter((d) => d.episodeId === discussionEpisode);
    const latest = messagesForEpisode.at(-1);
    if (latest?.delivery === "spoken" && latest.segments.length) context.textContent = say("\u5927\u80A5\u9C7C\u5728\u684C\u9762\u4E0A\u56DE\u4E86\u4F60\uFF0C\u8BB0\u5F55\u540C\u6B65\u5728\u8FD9\u91CC\u3002", "She replied on the desktop; the transcript is mirrored here.");
    else if (latest?.delivery === "unavailable") context.textContent = say("\u8FD9\u6B21\u684C\u5BA0\u6CA1\u6709\u8BF4\u51FA\u6765\uFF0C\u6269\u5C55\u91CC\u53EA\u8BB0\u5F55\u539F\u56E0\u3002", "This reply was not spoken on the desktop; only the reason is recorded here.");
    const replySignature = JSON.stringify(messagesForEpisode);
    if (replySignature !== conversationSignature) {
      conversationSignature = replySignature;
      conversation.replaceChildren();
      for (const item of messagesForEpisode) {
        const you = el("p", "\u4F60\uFF1A" + item.question, conversation);
        you.className = "chat-line you";
        if (item.delivery === "spoken") {
          for (const segment of item.segments) {
            const line = el("p", "\u{1F41F}\uFF1A" + segment, conversation);
            line.className = "chat-line pet";
          }
        } else if (item.delivery === "unavailable") {
          const line = el("p", "\u{1F41F}\uFF1A" + (item.reason ? say("\u6CA1\u6709\u8BF4\u51FA\u6765\uFF1A", "Not spoken: ") + item.reason : say("\u684C\u5BA0\u8F93\u51FA\u4E0D\u53EF\u7528\uFF0C\u8FD9\u6B21\u6CA1\u6709\u8BF4\u51FA\u6765\u3002", "Desktop output was unavailable; nothing was spoken.")), conversation);
          line.className = "chat-line pet unavailable";
        } else {
          const line = el("p", item.expired ? say("\u{1F41F}\uFF1A\u8FD9\u6B21\u8BF7\u6C42\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u63D0\u95EE\u3002", "\u{1F41F} Request expired; ask again.") : say("\u{1F41F}\uFF1A\u6B63\u5728\u60F3\u2026\u2026", "\u{1F41F} Thinking\u2026"), conversation);
          line.className = "chat-line pet";
        }
      }
    }
    const booksSignature = JSON.stringify([state.books.map((b) => [b.key, b.title]), c?.key]);
    if (booksSignature !== trailSignature) {
      trailSignature = booksSignature;
      trailChoice.replaceChildren();
      for (const book of state.books) {
        const option = el("option", book.title, trailChoice);
        option.value = book.key;
      }
      trailKey = c?.key;
      trailChoice.value = trailKey ?? "";
      notebook.hidden = false;
      episodeDetail.hidden = false;
      searchForm.hidden = false;
      otherTrail.hidden = true;
    }
    title.textContent = c ? c.title + (c.author ? " \xB7 " + c.author : "") : say("\u9001\u5979\u4E00\u672C\u4E66\u5427", "Recommend a book");
    chapter.textContent = c?.chapter ?? say("\u4E66\u67B6\u8FD8\u662F\u7A7A\u7684\u3002\u70B9\u4E0B\u9762\u7684\u6309\u94AE\uFF0C\u9009\u62E9\u6587\u4EF6\u3001\u94FE\u63A5\u6216\u4E66\u540D/\u4F5C\u8005\uFF0C\u628A\u7B2C\u4E00\u672C\u5C0F\u8BF4\u4EA4\u7ED9\u5979\u3002", "The shelf is empty. Use the button below to add a file, a link, or fetch by title/author.");
    meter.hidden = !c;
    if (c) meter.value = c.source ? c.chapterProgress : c.progress;
    meterLabel.textContent = c?.source ? say("\u672C\u7AE0\u5DF2\u8BFB " + Math.round(c.chapterProgress * 100) + "%", "Chapter " + Math.round(c.chapterProgress * 100) + "%") : "";
    const known = c && (!c.source || c.source.cachedChapters === c.source.totalChapters && c.source.publicationStatus === "finished");
    pageText.textContent = c ? say("\u5DF2\u8BFB " + Math.ceil(c.confirmedChars / 600) + " \u9875", "Read " + Math.ceil(c.confirmedChars / 600) + " pages") + (known ? " / " + Math.ceil(c.totalChars / 600) + say(" \u9875", " pages") : say(" \xB7 \u6B63\u6587\u672A\u5B8C\u6574\u83B7\u53D6\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u603B\u9875\u6570", " \xB7 Total pages unknown")) : "";
    pageText.hidden = !c;
    zone.textContent = say("\u73B0\u5B9E\u786E\u8BA4\u65F6\u95F4 \xB7 \u6700\u65B0\u5728\u4E0A \xB7 ", "Confirmation time \xB7 Newest first \xB7 ") + state.status.sharing.timezone;
    for (const b of controls.querySelectorAll("button")) {
      if (b.textContent === say("\u7ED3\u675F\u4F11\u606F", "End rest")) b.hidden = state.status.scheduler.reason !== "resting";
      else b.hidden = !c;
    }
    const run = state.status.scheduler, manual = run.manual?.bookKey === c?.key ? run.manual : null;
    const inFlight = !!run.active || run.cognitionRunning || !!state.status.library.pending;
    let stateKind = "waiting", label = say("\u7B49\u5F85\u9605\u8BFB", "Waiting to read"), detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u4F1A\u5728\u7A7A\u95F2\u65F6\u6309\u81EA\u5DF1\u7684\u8282\u594F\u7EE7\u7EED\u3002", "She is not reading now; she will continue at her own pace while idle.");
    if (run.routine) {
      stateKind = "routine";
      label = run.routine.kind === "sleep" ? say("\u7761\u89C9\u4E2D", "Sleeping") : say("\u7528\u9910\u4E2D", "Having a meal");
      detail = say("\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u4F5C\u606F\u7ED3\u675F\u540E\u624D\u80FD\u7EE7\u7EED\u3002", "Not reading now; reading can resume after her routine.");
    } else if (!c) {
      label = say("\u8FD8\u6CA1\u6709\u5728\u8BFB\u7684\u4E66", "No book selected");
      detail = say("\u5230\u4E66\u67B6\u9009\u4E00\u672C\u4E66\u4EA4\u7ED9\u5979\u3002", "Choose a book for her in the bookshelf.");
    } else if (c.complete) {
      stateKind = "complete";
      label = say("\u5DF2\u8BFB\u5B8C", "Finished");
      detail = say("\u8FD9\u672C\u4E66\u5DF2\u7ECF\u8BFB\u5B8C\uFF0C\u53EF\u4EE5\u518D\u63A8\u8350\u4E00\u672C\u3002", "This book is finished; recommend another one.");
    } else if (c.readiness === "caught_up") {
      stateKind = "waiting";
      label = say("\u5DF2\u8FFD\u5E73\uFF0C\u7B49\u5F85\u66F4\u65B0", "Caught up; waiting for updates");
      detail = say("\u5DF2\u7ECF\u8BFB\u5230\u5F53\u524D\u76EE\u5F55\u672B\u5C3E\uFF0C\u4F1A\u6309\u8BA1\u5212\u68C0\u67E5\u65B0\u7AE0\uFF1B\u8FD9\u4E0D\u662F\u5168\u4E66\u5B8C\u8BFB\u3002", "Read to the end of the current catalog. She will check for updates on schedule; this is not full-book completion.");
    } else if (c.readiness === "waiting_content") {
      stateKind = "waiting";
      label = say("\u53D1\u73B0\u65B0\u7AE0\uFF0C\u7B49\u5F85\u6B63\u6587", "New chapters found; waiting for text");
      detail = say("\u76EE\u5F55\u5DF2\u7ECF\u6709\u66F4\u65B0\uFF0C\u4F46\u6B63\u6587\u5C1A\u672A\u5B8C\u6574\u540C\u6B65\uFF1B\u4E0D\u4F1A\u8DF3\u7AE0\u6216\u5047\u88C5\u5DF2\u8BFB\u3002", "The catalog has updates, but the text is not fully synchronized yet; no chapter is skipped or faked.");
    } else if (c.readiness === "conflict") {
      stateKind = "error";
      label = say("\u8FDE\u8F7D\u76EE\u5F55\u51B2\u7A81", "Serial catalog conflict");
      detail = say("\u65E7\u7AE0\u8EAB\u4EFD\u6216\u987A\u5E8F\u53D1\u751F\u53D8\u5316\uFF0C\u81EA\u52A8\u540C\u6B65\u5DF2\u505C\u6B62\uFF1B\u5DF2\u8BFB\u6B63\u6587\u4ECD\u7136\u4FDD\u7559\u3002", "An accepted chapter changed identity or order, so automatic checks stopped; confirmed text is preserved.");
    } else if (state.status.library.paused) {
      label = say("\u5DF2\u6682\u505C", "Paused");
      detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u70B9\u51FB\u201C\u7EE7\u7EED\u8BFB\u201D\u53EF\u6062\u590D\u3002", "Not reading now; click Continue reading to resume.");
    } else if (state.status.library.pending) {
      stateKind = "reading";
      label = say("\u6B63\u5728\u9605\u8BFB", "Reading now");
      detail = say("\u5979\u5DF2\u62FF\u5230\u8FD9\u4E00\u6BB5\u6B63\u6587\uFF0C\u8BFB\u5B8C\u786E\u8BA4\u540E\u66F4\u65B0\u8FDB\u5EA6\u3002", "She has received this passage; progress updates after confirmation.");
    } else if (inFlight) {
      stateKind = "queued";
      label = say("\u7B49\u5F85\u5F00\u59CB\u9605\u8BFB", "Reading queued");
      detail = say("\u9605\u8BFB\u5DF2\u7ECF\u5B89\u6392\uFF0C\u6B63\u5728\u7B49\u5F85\u5979\u5904\u7406\uFF0C\u8FD8\u6CA1\u6709\u5F00\u59CB\u8BFB\u6B63\u6587\u3002", "Reading is queued; she has not started the passage yet.");
    } else if (run.habits.rest) {
      stateKind = "resting";
      label = say("\u4F11\u606F\u4E2D", "Taking a break");
      detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u4F11\u606F\u540E\u7EE7\u7EED\u3002", "Not reading now; she will continue after her break.");
    } else if (!run.enabled) {
      label = say("\u81EA\u4E3B\u9605\u8BFB\u5DF2\u5173\u95ED", "Automatic reading off");
      detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u4ECD\u53EF\u70B9\u51FB\u201C\u7EE7\u7EED\u8BFB\u201D\u3002", "Not reading now; you can still click Continue reading.");
    } else if (run.goal.reached) {
      label = say("\u4ECA\u65E5\u76EE\u6807\u5DF2\u5B8C\u6210", "Daily goal reached");
      detail = say("\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u81EA\u4E3B\u9605\u8BFB\u660E\u5929\u7EE7\u7EED\u3002", "Not reading now; automatic reading resumes tomorrow.");
    } else if (run.reason === "chat_priority") {
      label = say("\u4F18\u5148\u966A\u4F60\u804A\u5929", "Chatting first");
      detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u7A7A\u95F2\u540E\u518D\u7EE7\u7EED\u3002", "Not reading now; she will continue when idle.");
    } else if (run.reason === "error" || run.error) {
      stateKind = "error";
      label = say("\u9605\u8BFB\u6682\u65F6\u53D7\u963B", "Reading interrupted");
      detail = say("\u5979\u73B0\u5728\u6CA1\u6709\u5728\u8BFB\u4E66\uFF0C\u8BF7\u67E5\u770B\u4E0B\u65B9\u63D0\u793A\u3002", "Not reading now; check the message below.");
    }
    readingState.dataset.state = stateKind;
    stateLabel.textContent = label;
    stateDetail.textContent = detail;
    readNow.hidden = !c || c.complete;
    readNow.disabled = inFlight || busy || !!run.routine || !!c && c.readiness !== "backlog";
    readNow.textContent = say("\u7EE7\u7EED\u8BFB", "Continue reading");
    pauseReading.hidden = !c || c.complete;
    pauseReading.disabled = busy || !inFlight && !state.status.library.pending || !!run.routine || state.status.library.paused;
    for (const b of bookDetail.querySelectorAll(".bf-start-reading")) b.disabled = inFlight || !!run.routine;
    goalStatus.hidden = !run.goal.target;
    goalStatus.textContent = say("\u4ECA\u65E5\u7AE0\u8282\u76EE\u6807\uFF1A", "Today\u2019s chapter goal: ") + run.goal.completed + " / " + run.goal.target + say(" \u7AE0", " chapters") + (run.goal.reached ? say(" \xB7 \u5DF2\u5B8C\u6210", " \xB7 Complete") : "");
    restStatus.hidden = !!run.routine || !run.habits.rest;
    restStatus.textContent = run.habits.rest ? say("\u2615 \u6B63\u5728\u4F11\u606F\uFF0C\u9884\u8BA1 ", "\u2615 Taking a break, expected to resume at ") + new Date(run.habits.rest.plannedUntil).toLocaleTimeString(ctx.language, { timeZone: state.status.sharing.timezone }) : "";
    if (run.routine) readNotice.textContent = say("\u5979\u6B63\u5728", "She is ") + run.routine.label + (run.routine.until ? say("\uFF0C\u9884\u8BA1 " + run.routine.until + " \u540E\u53EF\u4EE5\u7EE7\u7EED\u8BFB\u3002", "; reading is available after " + run.routine.until + ".") : say("\uFF0C\u5F53\u524D\u4F5C\u606F\u8986\u76D6\u5168\u5929\uFF0C\u8BF7\u8C03\u6574\u914D\u7F6E\u3002", "; this schedule blocks all day.")) + " \xB7 " + run.routine.timezone;
    else if (manualUiError) readNotice.textContent = manualUiError;
    else if (!c) readNotice.textContent = say("\u5148\u5230\u4E66\u67B6\u9009\u4E00\u672C\u4E66\uFF0C\u5C31\u53EF\u4EE5\u8BA9\u5979\u7EE7\u7EED\u8BFB\u3002", "Choose a book in the bookshelf to read a passage now.");
    else if (c.complete) readNotice.textContent = say("\u8FD9\u672C\u4E66\u5DF2\u7ECF\u8BFB\u5B8C\u4E86\u3002", "This book is finished.");
    else if (c.readiness === "caught_up") readNotice.textContent = say("\u5DF2\u8FFD\u5E73\uFF0C\u7B49\u5F85\u4F5C\u8005\u66F4\u65B0\uFF1B\u4E0D\u4F1A\u628A\u5F53\u524D\u76EE\u5F55\u5F53\u6210\u5168\u4E66\u5B8C\u8BFB\u3002", "Caught up; waiting for the author. The current catalog is not treated as full-book completion.");
    else if (c.readiness === "waiting_content") readNotice.textContent = say("\u76EE\u5F55\u5DF2\u53D1\u73B0\u65B0\u7AE0\uFF0C\u6B63\u6587\u8FD8\u6CA1\u540C\u6B65\u5B8C\uFF1B\u540C\u6B65\u5B8C\u6210\u540E\u4F1A\u6309\u539F\u8282\u594F\u7EE7\u7EED\u8BFB\u3002", "New chapters are in the catalog but their text is not synchronized yet; reading resumes at the normal pace after it is. ");
    else if (manual?.state === "queued") readNotice.textContent = say("\u9605\u8BFB\u8BF7\u6C42\u5DF2\u53D1\u9001\uFF0C\u6B63\u5728\u7B49\u5F85\u5927\u80A5\u9C7C\u54CD\u5E94\uFF1B\u5DF2\u6709\u804A\u5929\u8FDB\u884C\u65F6\u4F1A\u6392\u961F\u3002", "Request sent. Waiting for her response; an ongoing conversation may delay it.");
    else if (manual?.state === "reading" || run.active && state.status.library.pending) readNotice.textContent = say("\u5927\u80A5\u9C7C\u6B63\u5728\u8BFB\u8FD9\u4E00\u6BB5\uFF0C\u786E\u8BA4\u540E\u4F1A\u66F4\u65B0\u8FDB\u5EA6\u3002", "She is reading this passage. Progress updates after confirmation.");
    else if (manual?.state === "completed") readNotice.textContent = say("\u8FD9\u4E00\u6BB5\u5DF2\u8BFB\u5B8C\uFF0C\u8FDB\u5EA6\u548C\u9605\u8BFB\u8DB3\u8FF9\u5DF2\u66F4\u65B0\u3002", "This passage is finished. Progress and the timeline have updated.");
    else if (manual && ["failed", "deferred", "expired", "cancelled"].includes(manual.state)) readNotice.textContent = manual.message ?? say("\u8FD9\u6B21\u9605\u8BFB\u5DF2\u53D6\u6D88\uFF0C\u53EF\u4EE5\u91CD\u65B0\u8BF7\u6C42\u3002", "This request was cancelled; you can try again.");
    else if (run.active) readNotice.textContent = say("\u5DF2\u5B89\u6392\u9605\u8BFB\uFF0C\u6B63\u5728\u7B49\u5F85\u5927\u80A5\u9C7C\u54CD\u5E94\u3002", "Reading is queued; waiting for her response.");
    else if (state.status.library.paused) readNotice.textContent = say("\u9605\u8BFB\u5DF2\u6682\u505C\u3002\u70B9\u51FB\u201C\u7EE7\u7EED\u8BFB\u201D\u5373\u53EF\u6062\u590D\u5E76\u53D1\u8D77\u4E00\u6B21\u9605\u8BFB\u3002", "Reading is paused. Resume and read a passage when ready.");
    else if (run.goal.target > 0 && c && !c.chapterGoalSupported) readNotice.textContent = say("\u672C\u4E66\u672A\u8BC6\u522B\u5230\u7AE0\u8282\uFF0C\u65E0\u6CD5\u6309\u7AE0\u9650\u5236\u8FDB\u5EA6\u3002\u53EF\u66F4\u6362\u5E26\u7AE0\u8282\u6807\u9898\u7684\u6587\u4EF6\uFF0C\u6216\u53D6\u6D88\u6BCF\u65E5\u76EE\u6807\uFF1B\u4E5F\u53EF\u4EE5\u4E3B\u52A8\u8BFB\u4E00\u6BB5\u3002", "No chapter headings were recognized. Choose a chaptered file, remove the daily goal, or explicitly read one passage.");
    else if (run.goal.reached) readNotice.textContent = say("\u4ECA\u5929\u7684 " + run.goal.target + " \u7AE0\u76EE\u6807\u5DF2\u5B8C\u6210\uFF0C\u81EA\u4E3B\u9605\u8BFB\u660E\u5929\u7EE7\u7EED\uFF1B\u4E5F\u53EF\u4EE5\u4E3B\u52A8\u518D\u8BFB\u4E00\u6BB5\u3002", "Today\u2019s chapter goal is complete. Automatic reading resumes tomorrow; you can request another passage.");
    else if (!run.enabled) readNotice.textContent = say("\u81EA\u4E3B\u9605\u8BFB\u5DF2\u5173\u95ED\uFF0C\u4ECD\u53EF\u70B9\u51FB\u201C\u7EE7\u7EED\u8BFB\u201D\u4E3B\u52A8\u53D1\u8D77\u4E00\u6B21\u9605\u8BFB\u3002", "Automatic reading is off. You can still request one passage now.");
    else if (run.habits.rest) readNotice.textContent = say("\u5979\u6B63\u5728\u4F11\u606F\uFF0C\u9884\u8BA1 ", "She is taking a break, until ") + new Date(run.habits.rest.plannedUntil).toLocaleTimeString(ctx.language, { timeZone: state.status.sharing.timezone }) + say(" \u7EE7\u7EED\u3002\u4E5F\u53EF\u4EE5\u4E3B\u52A8\u8BF7\u5979\u7EE7\u7EED\u8BFB\u3002", ". You can also request a passage now.");
    else readNotice.textContent = say("\u5DF2\u9009\u4E2D\u8FD9\u672C\u4E66\u3002\u5979\u4F1A\u5728\u7A7A\u95F2\u65F6\u6309\u81EA\u5DF1\u7684\u8282\u594F\u8BFB\uFF0C\u4E5F\u53EF\u4EE5\u70B9\u51FB\u201C\u7EE7\u7EED\u8BFB\u201D\u3002", "This book is selected. She will read while idle, or you can request a passage now.");
    const m = state.journal?.mood;
    moodText.textContent = m ? moodPrefix(m.label) + m.label : say("\u5C1A\u672A\u62A5\u544A\u5FC3\u60C5", "No mood reported");
    moodTime.textContent = m ? say("\u4E0A\u6B21\u9605\u8BFB\u8BB0\u5F55 \xB7 ", "Recorded at \xB7 ") + new Date(m.recordedAt).toLocaleString() : "";
    const e = state.journal?.items[0];
    thoughtText.textContent = e ? moodPrefix(e.mood?.label) + Array.from(e.interpretation).slice(0, 150).join("") + (Array.from(e.interpretation).length > 150 ? "\u2026" : "") : say("\u7B49\u5979\u9047\u5230\u60F3\u8BF4\u7684\u60C5\u8282\uFF0C\u611F\u60F3\u4F1A\u7559\u5728\u8FD9\u91CC\u3002", "Her thoughts will appear here.");
    discussLatest.disabled = !e;
    if (timelineKey !== c?.key) {
      manualUiError = "";
      timelineKey = c?.key ?? "";
      before = void 0;
      timelineRevision = "";
    }
    const signature = JSON.stringify([c?.key, c?.confirmedSegments, run.habits.restRevision]);
    if (signature !== timelineRevision) {
      await loadTimeline();
      timelineRevision = signature;
    }
    for (const b of reviews.querySelectorAll("button")) if (b.textContent === say("\u8BF7\u6C42\u5199\u4E00\u7248\u5168\u4E66\u8BFB\u540E\u611F", "Request a full-book review")) b.hidden = !c?.complete;
  };
  const initialPanel = ctx.panelId === "shelf" ? "shelf" : ctx.panelId === "trail" ? "trail" : ctx.panelId === "support" ? "support" : "home";
  if (initialPanel === "support") buildSupport();
  page(initialPanel);
  await update();
  return { dispose() {
    disposed = true;
    if (novelPollTimer !== void 0) {
      clearTimeout(novelPollTimer);
      novelPollTimer = void 0;
    }
    handle.dispose();
  } };
} };
var client_default = { panels: { status: readingPanel, shelf: readingPanel, trail: readingPanel, support: supportPanel, settings: settingsPanel } };
export {
  client_default as default
};
