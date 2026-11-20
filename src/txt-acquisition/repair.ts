/**
 * Best-effort text repair. Ordinary import refuses anything that is not clean
 * UTF-8/GB18030/UTF-16; acquisition keeps the original bytes and tries harder:
 * detect the encoding from content, replace the few undecodable bytes, strip
 * control characters, normalize line endings and drop an incomplete tail.
 *
 * Nothing here deletes prose. Advertising lines, duplicated chapters and
 * ambiguous paragraphs are reported as warnings, never removed.
 */
import type { DetectedEncoding, QualityIssue } from './types.ts';

const REPLACEMENT = /^\uFFFD/mu;

export function countReplacement(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 0xfffd) count += 1;
  return count;
}

function decodeSample(bytes: Buffer, encoding: string): string {
  try {
    return new TextDecoder(encoding === 'utf-8-bom' ? 'utf-8' : encoding, { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

const COMMON_CHARS = new Set([...'的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许稜先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱紶吗语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决窢传画保读运及则房早院量苦火布品近坐产答星精视五连司巴奇管类未朋且婚台夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容极随演收首根讲整式取照办强石古华諣拿计您装似足双妻尼转诉米称丽客南领节衣站黑刻统断福城故历惊脸选包紧争另建维绝树系伤示愿持千史谁准联妇纪基买志静阿诗独复痛消社算义竟确酒需单治卡幸兰念举仅钟怕共毛句息功官待究跟穿室易游程号居考突皮哪费倒价图具刚脑永歌响商礼细专黄块脚味灵改据般破引食仍存众注笔甚某沉血备习校默务土微娘须试怀料调广苏显赛查密议底列富梦错座参八除跑亮假印设线温虽掉京初养香停际致阳纸李纳验助激够严证帝饭忘趣支春集丈木研班普导顿睡展跳获艺六波察群皇段急庭创区奥器谢弟店否害草排背止组州朝封睛板角况曲馆育忙质河续哥呼若推境遇雨标姐充围案伦护冷警贝著雪索剧啊船险烟依斗值帮汉慢佛肯闻唱沙局伯族低玩资屋击速顾泪洲团圣旁堂兵七露园牛哭旅街劳型烈姑陈莫鱼异抱宝权鲁简态级票怪寻杀律胜份汽右洋范床舞秘午登楼贵吸责例追较职属渐左录丝牙党继托赶章智冲叶胡吉卖坚喝肉遗救修松临藏担戏善卫药悲敢靠伊村戴词森耳差短祖云规窗散迷油旧适乡架恩投弹铁博雷府压超负勒杂醒洗采毫嘴毕九冰既状乱景席珍童顶派素脱农疑练野按犯拍征坏骨余承置藏' as string]);
/** Rough "does this look like ordinary prose" score in [-2, 1]. */
function plausibility(text: string): number {
  if (!text.length) return -2;
  let credit = 0;
  let total = 0;
  let nul = 0;
  let replacement = 0;
  for (const char of text) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) { nul += 1; continue; }
    if (code === 0xfffd) { replacement += 1; continue; }
    if ((code >= 0x20 && code <= 0x7e) || code === 0x0a || code === 0x0d || code === 0x09) { credit += 1; continue; }
    if (COMMON_CHARS.has(char)) { credit += 1; continue; }
    if (code >= 0x3000 && code <= 0x303f) { credit += 0.6; continue; }
    if (code >= 0xff00 && code <= 0xffef) { credit += 0.3; continue; }
    if (code >= 0x4e00 && code <= 0x9fff) { credit += 0.2; continue; }
  }
  return credit / total - 3 * (replacement / total) - 2 * (nul / total);
}
export function detectEncoding(bytes: Buffer): DetectedEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const sample = bytes.subarray(0, Math.min(bytes.length, 1 << 20) - (Math.min(bytes.length, 1 << 20) % 2));
  // UTF-16 without a BOM: one byte of every pair is a NUL in ASCII-heavy text.
  if (sample.length >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    for (let index = 0; index < sample.length; index += 2) {
      if (sample[index] === 0) evenZero += 1;
      if (sample[index + 1] === 0) oddZero += 1;
    }
    const pairs = Math.floor(sample.length / 2);
    if (pairs > 0 && oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le';
    if (pairs > 0 && evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be';
  }
  const utf8Damage = countReplacement(decodeSample(sample, 'utf-8'));
  if (utf8Damage === 0) return 'utf-8';
  // Hard cases: UTF-16 text that is mostly Chinese has almost no NUL bytes, and
  // UTF-16 code units can double as plausible GBK pairs. Score every candidate
  // by how much of the result reads like ordinary prose.
  let best: DetectedEncoding = 'utf-8';
  let bestScore = -Infinity;
  for (const candidate of ['utf-16le', 'utf-16be', 'gb18030', 'utf-8'] as DetectedEncoding[]) {
    const score = plausibility(decodeSample(sample, candidate));
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

export interface DecodeResult { text: string; replacements: number; issues: QualityIssue[] }

const TEXT_DECODERS: Record<DetectedEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  gb18030: 'gb18030',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

/** Decode with the detected encoding, tolerating bad bytes instead of throwing. */
export function decodeBestEffort(bytes: Buffer, encoding: DetectedEncoding): DecodeResult {
  let text: string;
  try {
    text = new TextDecoder(TEXT_DECODERS[encoding], { fatal: false }).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  const replacements = countReplacement(text);
  const issues: QualityIssue[] = [];
  if (replacements > 0) {
    issues.push({ code: 'encoding_repaired', message: `${replacements} undecodable byte(s) replaced while reading as ${encoding}`, count: replacements });
  }
  return { text, replacements, issues };
}

export interface NormalizeResult { text: string; issues: QualityIssue[]; truncatedTail: boolean; controlChars: number; collapsedBlankRuns: number }

/**
 * Normalize a decoded string: BOM, line endings, control characters, blank-line
 * runs and an incomplete trailing character. Returns the repaired text plus the
 * repairs actually performed so the caller can record them.
 */
export function normalizeText(input: string): NormalizeResult {
  const issues: QualityIssue[] = [];
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    issues.push({ code: 'bom_removed', message: 'Removed the byte order mark' });
  }
  const beforeNewlines = text;
  text = text.replace(/\r\n?/gu, '\n');
  if (text !== beforeNewlines) issues.push({ code: 'newlines_normalized', message: 'Normalized line endings to LF' });

  let controlChars = 0;
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, () => { controlChars += 1; return ''; });
  if (controlChars > 0) {
    text = stripped;
    issues.push({ code: 'control_characters_removed', message: `Removed ${controlChars} control character(s)`, count: controlChars });
  }

  let truncatedTail = false;
  if (REPLACEMENT.test(text)) {
    let cut = text.length;
    while (cut > 0 && text.charCodeAt(cut - 1) === 0xfffd) cut -= 1;
    const removed = text.length - cut;
    if (removed > 0 && removed <= 4) {
      text = text.slice(0, cut);
      truncatedTail = true;
      issues.push({ code: 'tail_truncated', message: 'Dropped an incomplete character at the end of the file' });
    }
  }

  let collapsedBlankRuns = 0;
  const collapsed = text.replace(/\n{4,}/gu, (match) => { collapsedBlankRuns += 1; return '\n\n\n'; });
  if (collapsedBlankRuns > 0) {
    text = collapsed;
    issues.push({ code: 'blank_runs_collapsed', message: `Collapsed ${collapsedBlankRuns} run(s) of repeated blank lines`, count: collapsedBlankRuns });
  }

  text = text.replace(/^[ \t\u3000]+/u, '').replace(/\s+$/u, '');
  return { text, issues, truncatedTail, controlChars, collapsedBlankRuns };
}

/** True when the bytes cannot be the text they claim to be (see `looksBinary`). */
export function looksBinary(bytes: Buffer, encoding: DetectedEncoding = detectEncoding(bytes)): boolean {
  const wide = encoding === 'utf-16le' || encoding === 'utf-16be';
  const limit = Math.min(bytes.length, 1 << 16);
  const sample = bytes.subarray(0, wide ? limit - (limit % 2) : limit);
  if (!sample.length) return false;
  if (!wide) {
    let zeroes = 0;
    for (const byte of sample) if (byte === 0) zeroes += 1;
    if (zeroes / sample.length > 0.05) return true;
  }
  const text = decodeSample(sample, encoding);
  if (!text.length) return true;
  let readable = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) continue;
    const isCjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x2000 && code <= 0x206f);
    const isText = (code >= 0x20 && code <= 0x7e) || isCjk || code === 0x0a || code === 0x0d || code === 0x09 || code === 0xfffd;
    if (isText) readable += 1;
  }
  return total > 0 && readable / total < 0.75;
}




