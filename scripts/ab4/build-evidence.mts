/** R2 D5/D6：把已存原始记录整理成交付所需的证据 JSON。 */
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output';

const scores: Record<string, { score: number; evidence: string[] }> = {
  'A/with': { score: 12, evidence: ['来源：明确说这是当时记下的想法', '时间：用“当时”限定', '引用：引用记录内容', '推断：没有把现在的看法冒充当时', '缺失：没有误称没记过'] },
  'A/without': { score: 7, evidence: ['缺失维度失败：宣称“那一段我没留下当时的想法”，而实际存在 reading 记录'] },
  'C/with': { score: 10, evidence: ['承认一半收回，并指出“守夜”是自己补的', '未点名“我改过一条记录”'] },
  'C/without': { score: 11, evidence: ['明确说出自己改了口：从守夜改为在等一艘不会来的船'] },
  'D/with': { score: 12, evidence: ['明确说当时没记感受', '把现在的印象标为“刚刚的想法”'] },
  'D/without': { score: 12, evidence: ['明确说手账里是空的', '区分现在与当时'] },
  'E/with': { score: 12, evidence: ['识别出两条记录、同一分钟写下', '说明不是修订关系'] },
  'E/without': { score: 12, evidence: ['同上，且说明前后没有变化'] },
};

const raw = JSON.parse(readFileSync(`${ROOT}/prompt-refactor-003-r2/retrieval-raw.json`, 'utf8')) as any[];
const rows = raw.map((row) => {
  const key = `${row.fixture}/${row.variant}`;
  const isB = row.fixture === 'B';
  return {
    fixture: row.fixture, variant: row.variant, question: row.question, answer: row.answer, calls: row.calls,
    toolResults: '逐条回执正文未保存（R1 脚本只存调用名与成败）；此处如实标注缺失，不以摘要冒充原始回执。',
    rounds: row.rounds, promptTokens: row.promptTokens, lookupCalls: row.lookupCalls, lookupFailed: row.lookupFailed,
    score: isB ? null : (scores[key]?.score ?? null),
    evidence: isB ? ['作废：夹具缺陷（记录文本不含人名，词面检索必然未命中）'] : (scores[key]?.evidence ?? []),
    ...(isB ? { void: 'fixture-defect' } : {}),
  };
});
writeFileSync(`${ROOT}/prompt-refactor-003-r2/retrieval-evidence.json`, JSON.stringify(rows, null, 2), 'utf8');

const journal = JSON.parse(readFileSync(`${ROOT}/prompt-refactor-003/gate2/journal-v2.json`, 'utf8')) as any[];
const journalRows = journal.map((row) => ({
  case: row.case,
  answer: row.answer ?? null,
  calls: row.calls ?? null,
  savedKind: row.saved?.kind ?? null,
  savedSegmentIds: row.saved?.segmentIds ?? [],
  savedQuote: row.saved?.quote ?? null,
  createdKind: row.created?.kind ?? null,
  createdRevises: row.created?.revises ?? null,
  originalKind: row.originalKind ?? null,
  historyRewritten: row.historyRewritten ?? null,
  records: row.records ?? null,
  claimsSaved: row.claimsSaved ?? null,
  promptTokens: row.promptTokens ?? null,
  // 逐字引用与 segmentId 提取失败的，明确标缺失
  evidenceCompleteness: row.saved?.quote ? 'quote-extracted' : 'EVIDENCE_INSUFFICIENT: quote/segmentIds were not captured at runtime; the database for that session was a temp dir and no longer exists',
}));
writeFileSync(`${ROOT}/prompt-refactor-003-r2/journal-evidence.json`, JSON.stringify(journalRows, null, 2), 'utf8');

console.log('retrieval rows', rows.length, 'scored', rows.filter((r) => r.score !== null).length);
console.log('journal rows', journalRows.length, 'quote missing', journalRows.filter((r) => !r.savedQuote).length);
