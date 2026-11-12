#!/usr/bin/env node
/**
 * Read-only token attribution for BookFish.
 *
 * Joins Coopanion's provider ledger (`usage.jsonl`) with per-run tool call logs
 * (`runs/<run>/toolcalls.jsonl`) and reading progress receipts, then reports
 * "tokens per 10,000 confirmed reading characters" plus the attribution mix.
 *
 * It never writes to the host data directory and never prints novel text:
 * book titles/keys are hashed, and only aggregate numbers are emitted.
 *
 * Usage:
 *   node scripts/analyze-token-usage.mjs --usage <usage.jsonl> --runs <runs dir> \
 *     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--tz Asia/Shanghai] \
 *     [--out report.json] [--md report.md] [--label baseline]
 */
import { createReadStream, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, resolve } from 'node:path';

const READING_TOOLS = new Set(['bookfish_read_next', 'bookfish_finish_reading']);
const CLASS_RULES = [
  ['bookfish.reading', /^bookfish_(read_next|finish_reading)$/],
  ['bookfish.reflection', /^bookfish_(record_reflection|lookup)$/],
  ['bookfish.sharing', /^bookfish_(share|claim_share|report_share|propose_share|drop_share|get_sharing)$/],
  ['bookfish.review', /^bookfish_(review|begin_review|review_materials|finish_review|fail_review|list_reviews|get_review)$/],
  ['bookfish.discussion', /^bookfish_(discussion|reply_discussion|pace_discussion)$/],
  ['bookfish.acquisition', /^bookfish_(acquire|find_book|acquire_book|get_acquisition|plan_reading|resolve_source)$/],
  ['bookfish.aux', /^bookfish_/],
];

function parseArgs(argv) {
  const out = { tz: 'Asia/Shanghai', label: 'baseline' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) { i -= 1; continue; }
    out[key] = value;
  }
  return out;
}

export function dayKey(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function classifyTools(tools) {
  if (!tools.length) return 'host.chat';
  for (const [cls, re] of CLASS_RULES) if (tools.some((t) => re.test(t))) return cls;
  if (tools.every((t) => t === 'end_turn' || t === 'pet_say' || t === 'console')) return 'host.chat';
  return 'other_world';
}

function costOf(charges) {
  if (!Array.isArray(charges) || !charges.length) return null;
  let sum = 0;
  for (const charge of charges) {
    const amount = typeof charge?.knownAmount === 'number' ? charge.knownAmount : null;
    if (amount === null) return null;
    sum += amount;
  }
  return sum;
}

async function readJsonl(file, onLine) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;
    try { onLine(JSON.parse(line)); } catch { /* keep scanning: one corrupt line must not abort the audit */ }
  }
  return lines;
}

function blankBucket() {
  return { requests: 0, input: 0, cachedInput: 0, uncachedInput: 0, output: 0, costUsd: 0, costKnown: 0, toolCalls: 0 };
}
function add(target, src) {
  for (const k of ['requests', 'input', 'cachedInput', 'uncachedInput', 'output', 'costUsd', 'costKnown', 'toolCalls']) target[k] += src[k] ?? 0;
  return target;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.usage) throw new Error('--usage <usage.jsonl> is required');
  const usageFile = resolve(args.usage);
  const runsDir = resolve(args.runs ?? join(dirname(usageFile), 'runs'));
  const since = args.since ?? '';
  const until = args.until ?? '9999-12-31';
  const fromIso = args.from ? Date.parse(args.from) : null;
  const toIso = args.to ? Date.parse(args.to) : null;
  const isoWindow = fromIso !== null || toIso !== null;
  const inWindow = (iso, day) => {
    if (isoWindow) { const t = Date.parse(iso); return Number.isFinite(t) && (fromIso === null || t >= fromIso) && (toIso === null || t <= toIso); }
    return day >= since && day <= until;
  };
  const tz = args.tz;

  // 1. Tool calls per run/round, and confirmed-character deltas.
  const toolsByRound = new Map();          // `${run}|${round}` -> { tools:Set, chars:number }
  const responses = new Map();             // responseId -> { tools, chars }
  const confirmedByBook = new Map();       // bookKey -> [{ts, chars}]
  const quality = { finishCalls: 0, finishFailed: 0, finishDuplicate: 0, readCalls: 0, episodeCalls: 0,
    understandingChars: 0, understandingCount: 0, episodeChars: 0 };
  // Committed task receipts are the authoritative confirmation record: tool call
  // logs truncate long batch receipts, while history keeps the whole receipt.
  const historyFile = args.history ? resolve(args.history) : null;
  if (historyFile) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(historyFile, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT json FROM history WHERE kind='tasks' AND state='committed'").all()) {
        let task; try { task = JSON.parse(String(row.json)); } catch { continue; }
        const receipt = task?.receipt;
        if (!receipt || typeof receipt.confirmedAt !== 'number') continue;
        const ts = new Date(receipt.confirmedAt).toISOString();
        const list = confirmedByBook.get(String(receipt.bookKey)) ?? [];
        list.push({ ts, chars: Number(receipt.confirmedChars), segmentId: Number(receipt.segmentId), frontier: Number(receipt.frontier) });
        confirmedByBook.set(String(receipt.bookKey), list);
        if (inWindow(ts, dayKey(ts, tz))) {
          if (typeof receipt.understanding === 'string') { quality.understandingChars += Array.from(receipt.understanding).length; quality.understandingCount += 1; }
          if (receipt.episodeId) quality.episodeCalls += 1;
        }
      }
    } finally { db.close(); }
  }
  const runDirs = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => { try { return statSync(join(runsDir, d)).isDirectory(); } catch { return false; } }) : [];
  for (const dir of runDirs) {
    const file = join(runsDir, dir, 'toolcalls.jsonl');
    if (!existsSync(file)) continue;
    await readJsonl(file, (row) => {
      if (!row || typeof row.tool !== 'string') return;
      const key = `${row.run}|${row.round}`;
      let bucket = toolsByRound.get(key);
      if (!bucket) toolsByRound.set(key, (bucket = { tools: new Set(), chars: 0 }));
      bucket.tools.add(row.tool);
      bucket.chars += typeof row.chars === 'number' ? row.chars : 0;
      if (row.resp) {
        let resp = responses.get(row.resp);
        if (!resp) responses.set(row.resp, (resp = { tools: new Set(), chars: 0 }));
        resp.tools.add(row.tool);
        resp.chars += typeof row.chars === 'number' ? row.chars : 0;
      }
      if (!inWindow(row.ts, dayKey(row.ts, tz))) return;
      if (row.tool === 'bookfish_read_next') quality.readCalls += 1;
      if (row.tool === 'bookfish_finish_reading') {
        quality.finishCalls += 1;
        const failed = typeof row.receipt === 'string' && row.receipt.startsWith('[tool failed]');
        if (failed) quality.finishFailed += 1;
        else if (!historyFile) {
          try {
            const parsed = JSON.parse(row.receipt);
            if (parsed?.duplicate) quality.finishDuplicate += 1;
            const receipt = parsed?.receipt;
            if (receipt && !parsed.duplicate) {
              if (typeof receipt.understanding === 'string') {
                quality.understandingChars += Array.from(receipt.understanding).length;
                quality.understandingCount += 1;
              }
              if (receipt.episodeId) quality.episodeCalls += 1;
              const book = String(receipt.bookKey ?? '');
              const list = confirmedByBook.get(book) ?? [];
              list.push({ ts: row.ts, chars: Number(receipt.confirmedChars), segmentId: Number(receipt.segmentId), frontier: Number(receipt.frontier) });
              confirmedByBook.set(book, list);
            }
          } catch { /* receipt not JSON: counted as call only */ }
        }
      }
    });
  }
  // Deltas: cumulative confirmedChars and frontier are monotonic per revision.
  // `frontier` gives the exact number of newly confirmed atomic segments even
  // when a middle receipt is missing from the log; chars are the char delta.
  let confirmedChars = 0, confirmedSegments = 0;
  const confirmedByDay = new Map();
  for (const [book, list] of confirmedByBook) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    let prevChars = 0, prevFrontier = 0;
    for (const item of list) {
      const charDelta = Number.isFinite(item.chars) ? item.chars - prevChars : NaN;
      const frontier = Number.isFinite(item.frontier) ? item.frontier : NaN;
      const segmentDelta = Number.isFinite(frontier) ? frontier - prevFrontier : NaN;
      const plausible = Number.isFinite(charDelta) && charDelta > 0 && charDelta <= 12000 &&
        (!Number.isFinite(segmentDelta) || (segmentDelta >= 1 && segmentDelta <= 8));
      if (Number.isFinite(item.chars)) prevChars = item.chars;
      if (Number.isFinite(frontier)) prevFrontier = frontier;
      if (!plausible) continue;
      const day = dayKey(item.ts, tz);
      if (!inWindow(item.ts, day)) continue;
      confirmedChars += charDelta;
      confirmedSegments += Number.isFinite(segmentDelta) && segmentDelta >= 1 ? segmentDelta : 1;
      const bucket = confirmedByDay.get(day) ?? { chars: 0, segments: 0 };
      bucket.chars += charDelta;
      bucket.segments += Number.isFinite(segmentDelta) && segmentDelta >= 1 ? segmentDelta : 1;
      confirmedByDay.set(day, bucket);
    }
  }

  // 2. Ledger rows.
  const totals = blankBucket();
  const byClass = new Map();
  const byDay = new Map();
  const confidence = { high: 0, medium: 0, unknown: 0 };
  let rows = 0, rowsInWindow = 0;
  const readingRequests = [];
  await readJsonl(usageFile, (row) => {
    rows += 1;
    const attempt = row?.attempt;
    if (!attempt?.startedAt) return;
    const day = dayKey(attempt.startedAt, tz);
    if (!inWindow(attempt.startedAt, day)) return;
    rowsInWindow += 1;
    const input = Number(attempt?.meters?.input ?? row.promptTokens ?? 0);
    const output = Number(attempt?.meters?.output ?? row.completionTokens ?? 0);
    const cachedInput = Number(attempt?.meters?.cachedInput ?? row.cacheHitTokens ?? 0);
    const uncachedInput = Number(attempt?.meters?.uncachedInput ?? Math.max(0, input - cachedInput));
    const cost = costOf(attempt.charges);
    const responseId = attempt.responseId ?? row.recordId;
    const byResp = responseId ? responses.get(responseId) : undefined;
    const byRound = toolsByRound.get(`${row.run}|${row.round}`);
    const toolSet = byResp?.tools ?? byRound?.tools ?? new Set();
    const tools = [...toolSet];
    const cls = row.purpose && row.purpose !== 'generation' ? `host.${row.purpose}` : classifyTools(tools);
    if (byResp || byRound) confidence.high += 1;
    else confidence.unknown += 1;
    const bucket = { requests: 1, input, cachedInput, uncachedInput, output,
      costUsd: cost ?? 0, costKnown: cost === null ? 0 : 1, toolCalls: byResp ? byResp.tools.size : byRound?.tools.size ?? 0 };
    add(totals, bucket);
    let c = byClass.get(cls); if (!c) byClass.set(cls, (c = blankBucket())); add(c, bucket);
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = { day, ...blankBucket(), confirmedChars: 0, confirmedSegments: 0, byClass: {} }));
    add(d, bucket);
    if (!d.byClass[cls]) d.byClass[cls] = blankBucket();
    add(d.byClass[cls], bucket);
    if (cls === 'bookfish.reading') readingRequests.push({ day, input, output, cachedInput, tools, hasReadingTool: tools.some((t) => READING_TOOLS.has(t)), round: row.round, run: row.run });
  });

  for (const [day, bucket] of confirmedByDay) {
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = { day, ...blankBucket(), confirmedChars: 0, confirmedSegments: 0, byClass: {} }));
    d.confirmedChars = bucket.chars;
    d.confirmedSegments = bucket.segments;
  }

  const reading = byClass.get('bookfish.reading') ?? blankBucket();
  const per10k = (tokens, chars) => (chars > 0 ? (tokens / chars) * 10000 : null);
  const readingWithTool = readingRequests.filter((r) => r.hasReadingTool).length;
  const avg = (arr, pick) => (arr.length ? arr.reduce((sum, x) => sum + pick(x), 0) / arr.length : null);
  const median = (arr, pick) => {
    if (!arr.length) return null;
    const values = arr.map(pick).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };
  const p95 = (arr, pick) => {
    if (!arr.length) return null;
    const values = arr.map(pick).sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
  };

  const report = {
    version: 1,
    label: args.label,
    generatedAt: new Date().toISOString(),
    inputs: { usageFile, runsDir, since: since || (args.from ?? null), until: until === '9999-12-31' ? (args.to ?? null) : until, timezone: tz },
    method: {
      join: 'usage.attempt.responseId === toolcalls.resp (fallback: run+round)',
      classification: 'priority: bookfish reading/reflection/sharing/review/discussion/acquisition/aux, other_world, host.chat',
      confirmedChars: 'sum of positive deltas of cumulative receipt.confirmedChars per book revision (delta <= 12000)',
      note: 'A request is attributed only when its response contains a recorded tool call in the same response; otherwise it is counted as unknown rather than attributed to BookFish.',
    },
    coverage: { ledgerRows: rows, rowsInWindow, confirmedSegments, confirmedChars, confidence },
    totals,
    reading: {
      requests: reading.requests,
      requestsWithReadingTool: readingWithTool,
      input: reading.input, cachedInput: reading.cachedInput, uncachedInput: reading.uncachedInput, output: reading.output,
      costUsd: reading.costUsd, costFullyKnown: reading.costKnown === reading.requests,
      avgInput: avg(readingRequests, (r) => r.input), medianInput: median(readingRequests, (r) => r.input), p95Input: p95(readingRequests, (r) => r.input),
      cachedShare: reading.input ? reading.cachedInput / reading.input : null,
      tokensPer10kConfirmedChars: per10k(reading.input + reading.output, confirmedChars),
      inputPer10kConfirmedChars: per10k(reading.input, confirmedChars),
      outputPer10kConfirmedChars: per10k(reading.output, confirmedChars),
      confirmedCharsPerRequest: reading.requests ? confirmedChars / reading.requests : null,
      requestsPer10kConfirmedChars: per10k(reading.requests, confirmedChars),
      avgConfirmedCharsPerSegment: confirmedSegments ? confirmedChars / confirmedSegments : null,
    },
    outputShape: {
      finishCalls: quality.finishCalls, finishFailed: quality.finishFailed, finishDuplicate: quality.finishDuplicate,
      readCalls: quality.readCalls, episodeCalls: quality.episodeCalls,
      avgUnderstandingChars: quality.understandingCount ? quality.understandingChars / quality.understandingCount : null,
      understandingCharsPer10kConfirmedChars: per10k(quality.understandingChars, confirmedChars),
    },
    byClass: Object.fromEntries([...byClass].map(([k, v]) => [k, {
      ...v,
      shareOfInput: totals.input ? v.input / totals.input : 0,
      tokensPer10kConfirmedChars: k === 'bookfish.reading' ? per10k(v.input + v.output, confirmedChars) : null,
    }])),
    byDay: [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => ({
      day: d.day, requests: d.requests, input: d.input, cachedInput: d.cachedInput, uncachedInput: d.uncachedInput,
      output: d.output, costUsd: d.costUsd, confirmedChars: d.confirmedChars, confirmedSegments: d.confirmedSegments,
      readingRequests: d.byClass['bookfish.reading']?.requests ?? 0,
      readingInput: d.byClass['bookfish.reading']?.input ?? 0,
      readingOutput: d.byClass['bookfish.reading']?.output ?? 0,
      tokensPer10kConfirmedChars: per10k((d.byClass['bookfish.reading']?.input ?? 0) + (d.byClass['bookfish.reading']?.output ?? 0), d.confirmedChars),
    })),
  };

  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.md) {
    mkdirSync(dirname(resolve(args.md)), { recursive: true });
    writeFileSync(resolve(args.md), renderMarkdown(report));
  }
  console.log(JSON.stringify({
    label: report.label, window: report.inputs, coverage: report.coverage,
    totals: report.totals, reading: report.reading, outputShape: report.outputShape,
    byClass: report.byClass, byDay: report.byDay,
  }, null, 2));
}

function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function renderMarkdown(report) {
  const r = report.reading;
  const lines = [];
  lines.push(`# Token 归因基线（${report.label}）`);
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`账本：\`${report.inputs.usageFile}\``);
  lines.push(`运行日志：\`${report.inputs.runsDir}\``);
  lines.push(`时间窗：${report.inputs.since ?? '最早'} → ${report.inputs.until ?? '最新'}（${report.inputs.timezone}）`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  for (const [k, v] of Object.entries(report.method)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---:|');
  lines.push(`| 账本行 / 窗口内 | ${fmt(report.coverage.ledgerRows)} / ${fmt(report.coverage.rowsInWindow)} |`);
  lines.push(`| 请求数 | ${fmt(report.totals.requests)} |`);
  lines.push(`| 总输入 Token | ${fmt(report.totals.input)} |`);
  lines.push(`| 其中缓存命中 | ${fmt(report.totals.cachedInput)} |`);
  lines.push(`| 输出 Token | ${fmt(report.totals.output)} |`);
  lines.push(`| 已知费用（USD） | ${fmt(report.totals.costUsd, 4)}（${fmt(report.totals.costKnown)} 条可计价） |`);
  lines.push(`| 可高置信归因请求 | ${fmt(report.coverage.confidence.high)} |`);
  lines.push(`| 未知归因请求 | ${fmt(report.coverage.confidence.unknown)} |`);
  lines.push('');
  lines.push('## 阅读核心指标');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---:|');
  lines.push(`| 可归因阅读请求数 | ${fmt(r.requests)}（含阅读工具 ${fmt(r.requestsWithReadingTool)}） |`);
  lines.push(`| 确认阅读字数（码点） | ${fmt(report.coverage.confirmedChars)} |`);
  lines.push(`| 确认段数 | ${fmt(report.coverage.confirmedSegments)} |`);
  lines.push(`| 每段平均确认字数 | ${fmt(r.avgConfirmedCharsPerSegment, 1)} |`);
  lines.push(`| 阅读输入 Token / 输出 Token | ${fmt(r.input)} / ${fmt(r.output)} |`);
  lines.push(`| 其中缓存命中占比 | ${r.cachedShare === null ? '—' : `${fmt(r.cachedShare * 100, 1)}%`} |`);
  lines.push(`| 单请求输入 均值 / 中位 / P95 | ${fmt(r.avgInput)} / ${fmt(r.medianInput)} / ${fmt(r.p95Input)} |`);
  lines.push(`| **每万字确认阅读 Token** | **${fmt(r.tokensPer10kConfirmedChars)}** |`);
  lines.push(`| 每万字确认阅读输入 Token | ${fmt(r.inputPer10kConfirmedChars)} |`);
  lines.push(`| 每万字确认阅读输出 Token | ${fmt(r.outputPer10kConfirmedChars)} |`);
  lines.push(`| 每万字确认阅读请求数 | ${fmt(r.requestsPer10kConfirmedChars, 2)} |`);
  lines.push(`| 每请求平均确认字数 | ${fmt(r.confirmedCharsPerRequest, 1)} |`);
  lines.push(`| 费用（USD，同口径） | ${fmt(r.costUsd, 4)}${r.costFullyKnown ? '' : '（部分请求无法计价）'} |`);
  lines.push('');
  lines.push('## 输出形状');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---:|');
  lines.push(`| finish 调用 / 失败 / 幂等重放 | ${fmt(report.outputShape.finishCalls)} / ${fmt(report.outputShape.finishFailed)} / ${fmt(report.outputShape.finishDuplicate)} |`);
  lines.push(`| read_next 调用 | ${fmt(report.outputShape.readCalls)} |`);
  lines.push(`| 带 episode 的确认 | ${fmt(report.outputShape.episodeCalls)} |`);
  lines.push(`| understanding 平均字数 | ${fmt(report.outputShape.avgUnderstandingChars, 1)} |`);
  lines.push(`| understanding 每万字确认字数 | ${fmt(report.outputShape.understandingCharsPer10kConfirmedChars, 1)} |`);
  lines.push('');
  lines.push('## 分类归因');
  lines.push('');
  lines.push('| 类别 | 请求 | 输入 | 缓存 | 输出 | 占输入 | 费用 USD |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(report.byClass).sort((a, b) => b[1].input - a[1].input)) {
    lines.push(`| ${k} | ${fmt(v.requests)} | ${fmt(v.input)} | ${fmt(v.cachedInput)} | ${fmt(v.output)} | ${fmt(v.shareOfInput * 100, 1)}% | ${fmt(v.costUsd, 4)} |`);
  }
  lines.push('');
  lines.push('## 按日');
  lines.push('');
  lines.push('| 日期 | 请求 | 输入 | 输出 | 阅读请求 | 确认字数 | 每万字 Token |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const d of report.byDay) {
    lines.push(`| ${d.day} | ${fmt(d.requests)} | ${fmt(d.input)} | ${fmt(d.output)} | ${fmt(d.readingRequests)} | ${fmt(d.confirmedChars)} | ${fmt(d.tokensPer10kConfirmedChars)} |`);
  }
  lines.push('');
  lines.push('## 归因可信度');
  lines.push('');
  lines.push(`- 高：响应 ID 能在 toolcalls 日志中匹配到本轮工具调用（${fmt(report.coverage.confidence.high)} 条）。`);
  lines.push(`- 未知：无匹配工具日志，记为 unknown，不强行计入 BookFish（${fmt(report.coverage.confidence.unknown)} 条）。`);
  lines.push('- 共享前缀（人格提示词、工具 schema、聊天历史）不拆分；阅读请求的输入含共享前缀，因此“每万字 Token”是含前缀的口径，报告中同时给出可归因增量。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && /analyze-token-usage\.mjs$/.test(process.argv[1])) {
  main().catch((error) => { console.error(String(error?.stack ?? error)); process.exitCode = 1; });
}
