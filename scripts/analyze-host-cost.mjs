#!/usr/bin/env node
/**
 * Whole-host cost attribution: joins usage.jsonl with toolcalls.jsonl and groups
 * each model request by the world/tool that caused it. Read-only.
 *
 * Usage:
 *   node scripts/analyze-host-cost.mjs --usage <usage.jsonl> --runs <runs dir> \
 *     [--from ISO] [--to ISO] [--tz Asia/Shanghai] [--out report.json] [--md report.md]
 */
import { createReadStream, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, resolve } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  const value = process.argv[i + 1];
  if (key && value !== undefined) args[key] = value;
}
if (!args.usage || !args.runs) {
  console.error('usage: node scripts/analyze-host-cost.mjs --usage <usage.jsonl> --runs <runs dir> [--from ISO] [--to ISO] [--out json] [--md md]');
  process.exit(1);
}
const tz = args.tz ?? 'Asia/Shanghai';
const since = args.from ? Date.parse(args.from) : null;
const until = args.to ? Date.parse(args.to) : null;
const usageFile = resolve(args.usage);
const runsDir = resolve(args.runs);

const blank = () => ({ requests: 0, input: 0, cachedInput: 0, uncachedInput: 0, output: 0, cost: 0 });
const add = (target, src) => { for (const k of Object.keys(blank())) target[k] += src[k] ?? 0; return target; };

const responses = new Map(); // responseId -> { tools:Set, mods:Set }
const rounds = new Map();    // `${run}|${round}` -> { tools:Set, mods:Set }
async function readJsonl(file, onLine) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { if (!line.trim()) continue; try { onLine(JSON.parse(line)); } catch { /* ignore corrupt line */ } }
}
const dirs = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => { try { return statSync(join(runsDir, d)).isDirectory(); } catch { return false; } }) : [];
for (const dir of dirs) {
  const file = join(runsDir, dir, 'toolcalls.jsonl');
  if (!existsSync(file)) continue;
  await readJsonl(file, (row) => {
    if (!row || typeof row.tool !== 'string') return;
    const key = `${row.run}|${row.round}`;
    if (!rounds.has(key)) rounds.set(key, { tools: new Set(), mods: new Set() });
    rounds.get(key).tools.add(row.tool);
    if (row.mod) rounds.get(key).mods.add(row.mod);
    if (row.resp) {
      if (!responses.has(row.resp)) responses.set(row.resp, { tools: new Set(), mods: new Set() });
      responses.get(row.resp).tools.add(row.tool);
      if (row.mod) responses.get(row.resp).mods.add(row.mod);
    }
  });
}

function classify(tools, mods) {
  const names = [...tools];
  if (names.some((t) => t === 'bookfish_read_next' || t === 'bookfish_finish_reading')) return 'bookfish.reading';
  if (names.some((t) => t.startsWith('bookfish_'))) return 'bookfish.aux';
  const world = [...mods].find((m) => m && m !== 'bookfish');
  if (world) return `world:${world}`;
  if (names.length && names.every((t) => t === 'end_turn' || t === 'pet_say' || t === 'console')) return 'host.chat';
  return 'host.chat';
}
function dayHour(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(new Date(iso));
}
function day(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

const classes = new Map();
const hours = new Map();
const days = new Map();
const toolCalls = new Map();
let rows = 0, inWindow = 0, unknown = 0;
await readJsonl(usageFile, (row) => {
  rows += 1;
  const a = row?.attempt;
  if (!a?.startedAt) return;
  const t = Date.parse(a.startedAt);
  if ((since !== null && t < since) || (until !== null && t > until)) return;
  inWindow += 1;
  const resp = responses.get(a.responseId ?? row.recordId);
  const round = rounds.get(`${row.run}|${row.round}`);
  const tools = resp?.tools ?? round?.tools ?? new Set();
  const mods = resp?.mods ?? round?.mods ?? new Set();
  const cls = classify(tools, mods);
  if (!resp && !round) unknown += 1;
  const input = Number(a.meters?.input ?? row.promptTokens ?? 0);
  const cached = Number(a.meters?.cachedInput ?? row.cacheHitTokens ?? 0);
  const output = Number(a.meters?.output ?? row.completionTokens ?? 0);
  const cost = a.charges?.reduce((sum, c) => sum + (typeof c.knownAmount === 'number' ? c.knownAmount : 0), 0) ?? 0;
  const bucket = { requests: 1, input, cachedInput: cached, uncachedInput: Math.max(0, input - cached), output, cost };
  if (!classes.has(cls)) classes.set(cls, blank()); add(classes.get(cls), bucket);
  const hour = dayHour(a.startedAt);
  if (!hours.has(hour)) hours.set(hour, blank()); add(hours.get(hour), bucket);
  const d = day(a.startedAt);
  if (!days.has(d)) days.set(d, blank()); add(days.get(d), bucket);
  for (const name of tools) toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
});

const total = blank();
for (const bucket of classes.values()) add(total, bucket);
const pct = (n, d) => (d ? n / d : 0);
const report = {
  generatedAt: new Date().toISOString(),
  window: { from: args.from ?? null, to: args.to ?? null, timezone: tz },
  coverage: { ledgerRows: rows, inWindow, unknown },
  totals: total,
  classes: [...classes].map(([name, v]) => ({ name, ...v, shareOfCost: pct(v.cost, total.cost), shareOfInput: pct(v.input, total.input) }))
    .sort((a, b) => b.cost - a.cost),
  topHours: [...hours].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 12),
  days: [...days].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
  topToolCalls: [...toolCalls].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tool, calls]) => ({ tool, calls })),
};
if (args.out) { mkdirSync(dirname(resolve(args.out)), { recursive: true }); writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`); }
if (args.md) {
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const cny = (usd) => usd * 7.1;
  const lines = ['# 整机 Token 与费用归因', '', `生成：${report.generatedAt}`, `窗口：${args.from ?? '最早'} → ${args.to ?? '最新'}（${tz}）`, '',
    '| 类别 | 请求 | 输入 | 缓存 | 输出 | 费用 USD | 费用 CNY* | 费用占比 |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const c of report.classes) lines.push(`| ${c.name} | ${fmt(c.requests)} | ${fmt(c.input)} | ${fmt(c.cachedInput)} | ${fmt(c.output)} | ${fmt(c.cost, 4)} | ${fmt(cny(c.cost), 2)} | ${fmt(c.shareOfCost * 100, 1)}% |`);
  lines.push(`| **合计** | ${fmt(total.requests)} | ${fmt(total.input)} | ${fmt(total.cachedInput)} | ${fmt(total.output)} | ${fmt(total.cost, 4)} | ${fmt(cny(total.cost), 2)} | 100% |`);
  lines.push('', '\\* USD→CNY 按 7.1 折算，仅作量级参考。', '', '## 高消耗小时', '', '| 小时 | 请求 | 输入 | 缓存命中 | 输出 | 费用 CNY* |', '|---|---:|---:|---:|---:|---:|');
  for (const h of report.topHours) lines.push(`| ${h.hour} | ${fmt(h.requests)} | ${fmt(h.input)} | ${fmt(pct(h.cachedInput, h.input) * 100, 1)}% | ${fmt(h.output)} | ${fmt(cny(h.cost), 2)} |`);
  lines.push('', '## 高频工具调用', '', '| 工具 | 次数 |', '|---|---:|');
  for (const t of report.topToolCalls) lines.push(`| ${t.tool} | ${fmt(t.calls)} |`);
  lines.push('', `未知归因：${unknown}（无工具日志）。`, '');
  mkdirSync(dirname(resolve(args.md)), { recursive: true }); writeFileSync(resolve(args.md), lines.join('\n'));
}
console.log(JSON.stringify({ window: report.window, coverage: report.coverage, totals: report.totals, classes: report.classes, topHours: report.topHours.slice(0, 5) }, null, 2));
