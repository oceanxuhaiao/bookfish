#!/usr/bin/env node
/**
 * Batch-reading cost projection, calibrated on real measured reading requests.
 *
 * This is NOT a model A/B: it projects the measured per-request token profile
 * onto the request counts that batch mode would produce. Real-model A/B still
 * requires an authorized isolated host run.
 *
 * Model:
 *   requests/10k(b) = (2 requests per batch / (b * charsPerSegment)) * 10000 * retryFactor
 *   input/request(b) = measuredAvgInput + (b - 1) * segmentTokens
 *   output/10k(b)    = measuredOutput/10k  (no output savings claimed)
 * Variance in history growth (fewer exchanges for larger b) is treated as an
 * upside that is NOT counted.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));

if (!args.baseline) {
  console.error('usage: node scripts/simulate-batch-cost.mjs --baseline baseline.json [--out ab.json] [--md ab.md] [--tokensPerChar 0.67]');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(resolve(args.baseline), 'utf8'));
const r = baseline.reading;
const tokensPerChar = Number(args.tokensPerChar ?? 0.67);
const charsPerSegment = r.avgConfirmedCharsPerSegment;
const retryFactor = r.requestsPer10kConfirmedChars / ((2 / charsPerSegment) * 10000);
const outputPer10k = r.outputPer10kConfirmedChars;
const avgInput = r.avgInput;

const rows = [1, 2, 3, 4].map((batch) => {
  const requestsPer10k = (2 / (batch * charsPerSegment)) * 10000 * retryFactor;
  const segmentTokens = Math.round(charsPerSegment * tokensPerChar);
  const inputPerRequest = avgInput + (batch - 1) * segmentTokens;
  const inputPer10k = requestsPer10k * inputPerRequest;
  const tokensPer10k = inputPer10k + outputPer10k;
  return { batch, requestsPer10k, inputPerRequest, inputPer10k, outputPer10k, tokensPer10k,
    reductionVsBaseline: 1 - tokensPer10k / r.tokensPer10kConfirmedChars };
});
const baselineRow = rows.find(row => row.batch === 1);
const result = {
  version: 1,
  kind: 'calibrated-projection-not-model-ab',
  generatedAt: new Date().toISOString(),
  source: { baselineLabel: baseline.label, window: baseline.inputs, measured: {
    tokensPer10k: r.tokensPer10kConfirmedChars, requestsPer10k: r.requestsPer10kConfirmedChars,
    avgInput: r.avgInput, outputPer10k, confirmedCharsPerSegment: charsPerSegment,
    costPer10kUsd: baseline.coverage.confirmedChars ? baseline.reading.costUsd / baseline.coverage.confirmedChars * 10000 : null,
  } },
  assumptions: {
    requestsPerBatch: 2,
    retryFactor,
    tokensPerChar,
    extraSegmentTokens: Math.round(charsPerSegment * tokensPerChar),
    outputUnchanged: true,
    historyGrowthReductionCounted: false,
  },
  calibration: { projectedBatch1TokensPer10k: baselineRow.tokensPer10k, measuredTokensPer10k: r.tokensPer10kConfirmedChars,
    relativeError: baselineRow.tokensPer10k / r.tokensPer10kConfirmedChars - 1 },
  rows,
};
if (args.out) { mkdirSync(dirname(resolve(args.out)), { recursive: true }); writeFileSync(resolve(args.out), `${JSON.stringify(result, null, 2)}\n`); }
if (args.md) {
  const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const lines = ['# 批量阅读成本投影（校准自真实基线）', '',
    `生成时间：${result.generatedAt}`, '',
    `> 这是**校准投影**，不是真实模型 A/B。真实模型 A/B 需要经授权的隔离宿主运行；本表把实测的“单请求 Token 画像”套到批量模式会产生的请求数上。`, '',
    '## 实测输入', '',
    `- 基线窗口：${baseline.inputs.since ?? '最早'} → ${baseline.inputs.until ?? '最新'}（${baseline.inputs.timezone}）`,
    `- 每万字确认阅读 Token：${fmt(r.tokensPer10kConfirmedChars)}`,
    `- 每万字阅读请求数：${r.requestsPer10kConfirmedChars.toFixed(2)}`,
    `- 单请求平均输入：${fmt(r.avgInput)}，平均输出/万字：${fmt(outputPer10k)}`,
    `- 每段平均确认字数：${charsPerSegment.toFixed(0)}`,
    `- 每万字费用：$${(result.measured?.costPer10kUsd ?? result.source.measured.costPer10kUsd).toFixed(4)}`, '',
    '## 假设', '',
    `- 每个批次 2 次模型请求（read_next + finish_reading），未计入失败重试之外的额外轮次。`,
    `- 失败/重试系数沿用实测：${retryFactor.toFixed(3)}（基线 2.67 请求/段 ÷ 理论 2）。批量不会自动降低这个系数，属于保守假设。`,
    `- 中文正文按 ${tokensPerChar} token/字估算每段多出的上下文。`,
    `- 输出 Token 不下降（保守）：批量只减少输入请求数，不假设更短的感想。`,
    `- 未计入请求减少带来的历史累积下降（对批量有利，不计入节省）。`, '',
    '## 投影结果', '',
    '| 段/次 | 每万字请求数 | 单请求输入 | 每万字输入 Token | 每万字 Token | 相对基线 |',
    '|---:|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${row.batch} | ${row.requestsPer10k.toFixed(2)} | ${fmt(row.inputPerRequest)} | ${fmt(row.inputPer10k)} | ${fmt(row.tokensPer10k)} | ${(row.reductionVsBaseline * 100).toFixed(1)}% |`),
    '',
    `校准误差（b=1 投影 vs 实测）：${(result.calibration.relativeError * 100).toFixed(2)}%。`, '',
    '## 结论与限制', '',
    `- 在该模型下，2 段/次约下降 ${(rows[1].reductionVsBaseline * 100).toFixed(0)}%，3 段/次约下降 ${(rows[2].reductionVsBaseline * 100).toFixed(0)}%，4 段/次约下降 ${(rows[3].reductionVsBaseline * 100).toFixed(0)}%。`,
    '- 节省几乎全部来自“每万字请求数”下降，而不是把一次请求的正文变短。',
    '- 未验证：真实模型在批量提示下是否仍逐段真实阅读、是否出现漏读或跳段；须在隔离宿主用同一正文做 1/2/3/4 段对照后才能把投影写成实测结论。',
    '- 未验证：更大批量是否增加单轮工具 JSON 失败率；基线中 23% 的 finish 失败会同时乘以批量请求数。', ''];
  mkdirSync(dirname(resolve(args.md)), { recursive: true });
  writeFileSync(resolve(args.md), lines.join('\n'));
}
console.log(JSON.stringify(result, null, 2));
