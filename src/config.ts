import type { ConfigGroup } from 'cortico/core/types.ts';

export interface BookfishConfigSection {
  enabled: boolean;
  readingMode: 'auto' | 'main';
  allowNetwork: boolean;
  automaticReading: boolean;
  /** Opt-in autonomous search/acquire. Off by default. */
  autonomousAcquisition?: boolean;
  autonomousAcquisitionMode?: 'notify' | 'auto';
  /** Comma-separated source ids; empty means all curated sources. */
  autonomousSourceIds?: string;
  /** Minimum free disk space required before an autonomous download starts. */
  autonomousDiskBudgetMb?: number;
  /** Absolute directory for full book text; empty keeps dataDir/bookfish/books. Metadata stays in dataDir. */
  textStoreDir?: string;
  speed: 'slow' | 'normal' | 'fast';
  readingCharsPerMinute?: number;
  dailyChapterGoal?: number;
  readingSessionMinutes?: number;
  /** Atomic segments handed over in one opportunity: 1 keeps the original protocol, 2–4 is the batch experiment. */
  readingBatchSegments?: number;
  /** Mechanical daily cap on reading tasks (0 = unlimited). Stops new work, never retracts an in-flight request. */
  dailyReadingCap?: number;
  realRoutineEnabled?:boolean;
  /** Retired clock preferences, ignored by scheduling and rejected by settings writes. */
  sleepEnabled?:boolean; mealsEnabled?:boolean;
  sleepStartMinute?:number;sleepEndMinute?:number;
  breakfastStartMinute?:number;breakfastEndMinute?:number;
  lunchStartMinute?:number;lunchEndMinute?:number;
  dinnerStartMinute?:number;dinnerEndMinute?:number;
  /** Legacy audit-only configuration, no longer limits reading. */
  dailyTasks: number;
  dailyChars: number;
  automaticSharing?: boolean;
  automaticReview?: boolean;
  shareCooldownMinutes?: number;
  shareQuietEnabled?: boolean;
  shareQuietStart?: number;
  shareQuietEnd?: number;
  shareQuietStartMinute?: number;
  shareQuietEndMinute?: number;
  shareMaxSentenceChars?: number;
}
export const BOOKFISH_DEFAULTS: BookfishConfigSection = { enabled: false, readingMode: 'auto', allowNetwork: true,
  automaticReading: true, autonomousAcquisition: false, autonomousAcquisitionMode: 'auto', autonomousSourceIds: '', autonomousDiskBudgetMb: 1024, textStoreDir: '',
  dailyChapterGoal:0, readingSessionMinutes:10,realRoutineEnabled:true, speed: 'normal', readingCharsPerMinute: 0, dailyTasks: 40, dailyChars: 48000,
  readingBatchSegments:2, dailyReadingCap:0,
  automaticSharing: true, automaticReview: true, shareCooldownMinutes: 60, shareQuietEnabled: true, shareQuietStart: 22, shareQuietEnd: 8, shareMaxSentenceChars: 80, shareQuietStartMinute: -1, shareQuietEndMinute: -1 };
export function sharingLimits(cfg: BookfishConfigSection) {
  const integer = (v: unknown, fallback: number, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fallback;
  return { cooldownMs: integer(cfg.shareCooldownMinutes, 60, 1, 1440) * 60000,
    maxSentenceChars: integer(cfg.shareMaxSentenceChars, 80, 10, 300),
    startMinute: integer(cfg.shareQuietStartMinute, integer(cfg.shareQuietStart, 22, 0, 23) * 60, 0, 1439),
    endMinute: integer(cfg.shareQuietEndMinute, integer(cfg.shareQuietEnd, 8, 0, 23) * 60, 0, 1439),
    quiet: cfg.shareQuietEnabled !== false, start: integer(cfg.shareQuietStart, 22, 0, 23), end: integer(cfg.shareQuietEnd, 8, 0, 23) };
}
export function readingLimits(cfg: BookfishConfigSection) {
  const integer = (v: number, fallback: number, max: number) => Number.isSafeInteger(v) && v >= 1 && v <= max ? v : fallback;
  const preset = ({ slow: 200, normal: 400, fast: 600 } as Record<string, number>)[cfg.speed] ?? 400;
  const rate = Number.isSafeInteger(cfg.readingCharsPerMinute) && cfg.readingCharsPerMinute! >= 100 && cfg.readingCharsPerMinute! <= 1200 ? cfg.readingCharsPerMinute! : preset;
  const batch = Number.isSafeInteger(cfg.readingBatchSegments) && cfg.readingBatchSegments! >= 1 && cfg.readingBatchSegments! <= 4 ? cfg.readingBatchSegments! : 2;
  const taskCap = Number.isSafeInteger(cfg.dailyReadingCap) && cfg.dailyReadingCap! >= 1 && cfg.dailyReadingCap! <= 1000 ? cfg.dailyReadingCap! : 0;
  return { charsPerMinute: rate, intervalMs: Math.ceil(1200 / rate * 60000),
    tasks: null, chars: null, batch, taskCap, chapterGoal:Number.isSafeInteger(cfg.dailyChapterGoal)&&cfg.dailyChapterGoal!>=1&&cfg.dailyChapterGoal!<=10000?cfg.dailyChapterGoal!:0, sessionMinutes:integer(cfg.readingSessionMinutes??10,10,120) };
}
export function bookfishConfigGroup(english: boolean): ConfigGroup {
  return {
    id: 'world:bookfish', owner: 'world:bookfish',
    schema: {
      type: 'object', title: english ? 'Reading' : '阅读',
      properties: {
        'worlds.bookfish.realRoutineEnabled':{type:'boolean',title:english?'Real daily routine':'真实作息',description:english?'On by default. Fixed sleep and meal hours; turning off removes these reading gates.':'默认开启，按固定时间睡觉和用餐；关闭后不再因吃饭、睡觉停止阅读。','x-hot':true},
        'worlds.bookfish.automaticReview': { type: 'boolean', title: english ? 'Offer one review after automatic completion' : '自主阅读完本后给予一次读后感机会', description: english ? 'Only while automatic reading is enabled. Failure needs explicit retry; preserves earlier versions.' : '仅自主阅读开启时生效；失败需手动重试，保留旧版本。', 'x-hot': true },
        'worlds.bookfish.automaticSharing': { type: 'boolean', title: english ? 'Automatic reading shares' : '主动分享阅读感想', description: english ? 'On by default for new configurations. Uses existing pet_say; does not prove display.' : '新配置默认开启；由大肥鱼调用现有桌宠输出，不把工具接收当作已显示。', 'x-hot': true },
        'worlds.bookfish.shareCooldownMinutes': { type: 'integer', minimum: 1, maximum: 1440, title: english ? 'Share cooldown (minutes)' : '分享冷却（分钟）', 'x-hot': true },
        'worlds.bookfish.shareMaxSentenceChars': { type: 'integer', minimum: 10, maximum: 300, title: english ? 'Maximum characters per sentence' : '每句话最多字数', 'x-hot': true },
        'worlds.bookfish.shareQuietStartMinute': { type: 'integer', minimum: -1, maximum: 1439, title: english ? 'Quiet start (minutes after midnight)' : '安静开始（午夜起分钟数）', description: english ? '1320 = 22:00; -1 uses the legacy hour.' : '1320表示22:00；1410表示23:30；-1沿用旧小时配置。按部署时区计算。', 'x-hot': true },
        'worlds.bookfish.shareQuietEndMinute': { type: 'integer', minimum: 0, maximum: 1439, title: english ? 'Quiet end (minutes after midnight)' : '安静结束（午夜起分钟数）', description: english ? '480 = 08:00. Equal times mean quiet all day.' : '480表示08:00；450表示07:30。支持跨天；起止相同为全天安静。', 'x-hot': true },
        'worlds.bookfish.shareQuietEnabled': { type: 'boolean', title: english ? 'Quiet hours for automatic shares' : '主动分享安静时段', 'x-hot': true },
        'worlds.bookfish.shareQuietStart': { type: 'integer', minimum: 0, maximum: 23, title: english ? 'Quiet start hour' : '安静开始小时（部署时区）', 'x-hot': true },
        'worlds.bookfish.shareQuietEnd': { type: 'integer', minimum: 0, maximum: 23, title: english ? 'Quiet end hour (equal = all day)' : '安静结束小时（与开始相同为全天安静）', 'x-hot': true },
        'worlds.bookfish.automaticReading': { type: 'boolean', title: english ? 'Automatic reading' : '自主阅读', description: english ? 'Offers one segment while idle. On by default; existing explicit settings are preserved.' : '空闲时按目标字速逐段阅读；新配置默认开启，保留已有显式开关。', 'x-hot': true },
        'worlds.bookfish.autonomousAcquisition': { type: 'boolean', title: english ? 'Let her find her own books' : '让她自己找书', description: english ? 'Off by default. She may propose one concrete title/author, search, download a verified edition, add it to the shelf and queue it after the current book. Turning off pauses the chain; it never unlocks a paused book or ignores reading confirmation.' : '默认关闭。她可以提出具体书名/作者、搜索、下载经校验的版本、入架并排在当前书之后。关闭会暂停这条链路，不会解除阅读暂停，也不把获取当作已读。', 'x-hot': true },
        'worlds.bookfish.autonomousAcquisitionMode': { type: 'string', enum: ['auto', 'notify'], title: english ? 'When found' : '找到以后', description: english ? 'Auto acquires one exact allowed edition and queues it; notify stops at candidates for a human decision.' : '自动获取并排队：只接受书名、作者和允许书源都精确匹配的版本；找到后告诉我：只搜索并停在候选，等你决定。', 'x-hot': true },
        'worlds.bookfish.autonomousSourceIds': { type: 'string', title: english ? 'Allowed source ids (empty = all)' : '允许自主使用的书源 ID（空为全部）', description: english ? 'Comma-separated curated source ids, e.g. 5,7,8. Unknown ids are ignored; unknown usage rights are never treated as permission.' : '逗号分隔的已收录书源 ID，例如 5,7,8。空表示全部已收录来源；不会自动登录、购买或绕过限制。', 'x-hot': true },
        'worlds.bookfish.autonomousDiskBudgetMb': { type: 'integer', minimum: 128, maximum: 102400, title: english ? 'Minimum free disk before autonomous download (MiB)' : '自主下载前要求的最低可用磁盘（MiB）', description: english ? 'Only a free-space safety floor; the source does not provide an exact byte count before download.' : '这是下载前的可用空间安全线；书源不提供精确下载字节数，因此不是精确配额。', 'x-hot': true },
        'worlds.bookfish.textStoreDir': { type: 'string', title: english ? 'Full-text storage folder' : '书籍全文保存位置', description: english ? 'Absolute empty folder for full book text. Empty keeps data/bookfish/books. Metadata, progress and history stay in the data folder. Existing text is copied there on the next start or extension reload; the old folder is kept as a fallback until you remove it.' : '填写一个绝对路径的空文件夹，只用于保存书籍全文；留空沿用 data/bookfish/books。书名、进度、手账和历史仍留在数据目录。已有全文会在下次启动或重新加载扩展时复制到新目录；旧目录保留作为回退，确认新目录可读后可手动删除。', 'x-hot': true },
        'worlds.bookfish.speed': { type: 'string', enum: ['slow', 'normal', 'fast'], title: english ? 'Preset: 200 / 400 / 600 characters per minute' : '阅读预设：慢200 / 普通400 / 快600字每分钟', 'x-hot': true },
        'worlds.bookfish.readingCharsPerMinute': { type: 'integer', minimum: 0, maximum: 1200, title: english ? 'Reading characters per minute (0 = preset)' : '每分钟阅读字数（100—1200，0沿用预设）', description: english ? 'Target idle reading rate, not guaranteed wall-clock throughput. Changes affect remaining pacing only.' : '空闲阅读的目标字速；普通参考值400。聊天、休息、模型处理不计时，实际可能更慢；动态修改仅影响剩余节奏。', 'x-hot': true },
        'worlds.bookfish.dailyChapterGoal': {type:'integer',minimum:0,maximum:10000,title:english?'Daily chapter goal (0 = unlimited)':'每日章节目标（0不限制）','x-hot':true},
        'worlds.bookfish.readingSessionMinutes': {type:'integer',minimum:1,maximum:120,title:english?'Reading session (minutes)':'每轮阅读时长（分钟）','x-hot':true},
        'worlds.bookfish.readingBatchSegments': {type:'integer',minimum:1,maximum:4,title:english?'Segments per opportunity (default 2; 1 = original)':'每次提供的正文段数（默认2；1为原协议）',description:english?'Each segment stays an atomic, separately confirmed 1200-code-point range. The default is 2 to halve repeated requests without skipping text; 1 restores the original one-at-a-time protocol.':'每个原子段仍单独可追溯、单独确认。默认 2 段一次以约一半的请求完成同样字数，不跳过、不合并正文；设为 1 恢复原来的逐段协议。','x-hot':true},
        'worlds.bookfish.dailyReadingCap': {type:'integer',minimum:0,maximum:1000,title:english?'Daily reading task cap (0 = unlimited)' : '每日阅读任务兜底上限（0不限制）',description:english?'A mechanical stop for new reading work, not a precise token or cost quota. In-flight requests may still be billed after the cap is reached.':'这是对新阅读任务的机械兜底，不是精确 Token/费用配额；到达上限后已发出的模型请求仍可能继续计费。显式“现在读一段”可再加一段。','x-hot':true},
        'worlds.bookfish.dailyTasks': { type: 'integer', minimum: 1, maximum: 1000, title: english ? 'Daily segment task limit' : '每日正文任务上限', 'x-hot': true },
        'worlds.bookfish.dailyChars': { type: 'integer', minimum: 1, maximum: 1200000, title: english ? 'Daily supplied character limit' : '每日提供正文字符上限', description: english ? 'Includes manual reads and unsuccessful attempts; retries of the same task are free.' : '包含手动取段和未确认的尝试；同一任务重复获取不重复扣减。', 'x-hot': true },
        'worlds.bookfish.allowNetwork': {
          type: 'boolean', title: english ? 'Allow novel source requests' : '允许访问小说书源',
          description: english ? 'Fetches public chapters when explicitly importing or continuing a remote book. Cached text remains readable when disabled.' : '导入链接或读到未缓存章节时访问公开书源；关闭后仍可读已缓存正文。', 'x-hot': true,
        },
        'worlds.bookfish.readingMode': {
          type: 'string', enum: ['auto', 'main'],
          title: english ? 'Reading mode' : '阅读方式',
          description: english ? 'Auto uses Persona cognition when available, otherwise the main session.' : '自动模式在 Persona 提供后台认知时使用，否则使用主会话。',
          'x-hot': true,
        },
      },
    },
  };
}

export function bookfishConfigGroups(english: boolean): ConfigGroup[] {
  const all=bookfishConfigGroup(english);const fields=all.schema.properties;
  const main=['realRoutineEnabled','automaticReading','autonomousAcquisition','autonomousAcquisitionMode','autonomousSourceIds','autonomousDiskBudgetMb','speed','readingCharsPerMinute','dailyChapterGoal','readingSessionMinutes','readingBatchSegments','dailyReadingCap','automaticSharing','shareCooldownMinutes','shareMaxSentenceChars','shareQuietEnabled','shareQuietStartMinute','shareQuietEndMinute'];
  const advanced=['automaticReview','allowNetwork','readingMode','textStoreDir'];
  const pick=(names:string[])=>Object.fromEntries(names.map(k=>['worlds.bookfish.'+k,fields['worlds.bookfish.'+k]]));
  return [{...all,schema:{...all.schema,title:english?'Reading and sharing':'阅读与分享',properties:pick(main)}},{...all,id:'world:bookfish:advanced',schema:{...all.schema,title:english?'Advanced reading limits':'高级阅读限制',properties:pick(advanced)}}];
}
/** Narrow settings write: reject the entire request before calling host persistence. */
export function validateSettings(input:unknown):Partial<BookfishConfigSection>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid settings');
  const fields=Object.assign({},...bookfishConfigGroups(false).map(g=>g.schema.properties));const patch:Record<string,unknown>={};
  for(const [key,value]of Object.entries(input)){
    const prop=fields['worlds.bookfish.'+key];if(!prop)throw Error('Unsupported setting: '+key);
    if(prop.type==='boolean'&&typeof value!=='boolean'||prop.type==='string'&&(typeof value!=='string'||prop.enum&&!prop.enum.includes(value))||prop.type==='integer'&&(!Number.isSafeInteger(value)||typeof value!=='number'||value<(prop.minimum??-Infinity)||value>(prop.maximum??Infinity)))throw Error('Invalid setting: '+key);
    if(key==='readingCharsPerMinute'&&value!==0&&(value as number)<100)throw Error('Reading speed must be 0 or 100—1200');
    if(key==='autonomousSourceIds'&&(typeof value!=='string'||value.length>100||value.trim()!==''&&! /^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(value)))throw Error('Autonomous source ids must be comma-separated integers');
    if(key==='textStoreDir'){const text=(value as string).trim();if(text&&! /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(text))throw Error('Text storage path must be absolute');patch[key]=text;continue;}
    patch[key]=value;
  }
  if(!Object.keys(patch).length)throw Error('No settings supplied');return patch;
}
