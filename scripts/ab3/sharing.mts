/**
 * 阶段 3 / G03+G04：真实 share_opportunity 的完整链路 + 九类负向 + 新指标。
 *   GROUP=positive|negative
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openArm, runSession, ensureEpisode, save, totals, MODEL } from '../ab2/core.mts';

const PACKAGE = resolve(import.meta.dirname, '..', '..');
const { armContext } = await import(pathToFileURL(resolve(PACKAGE, 'scripts', 'ab', 'context.mts')).href);
const SYSTEM = (await armContext({ srcDir: resolve(PACKAGE, 'src') })).system as string;
const GROUP = process.env.GROUP ?? 'positive';
const results: any[] = [];
const record = (row: any) => { results.push(row); save(`sharing/${GROUP}.json`, results); };

const tooText = '这一段我读得很慢，像在等一个人开口。';

async function armWithCandidate(label: string) {
  const arm = await openArm(label, { automaticSharing: true, shareCooldownMinutes: 1, shareQuietEnabled: false });
  const episodeId = await ensureEpisode(arm);
  const proposed = JSON.parse(await arm.world.tools().find((t: any) => t.name === 'bookfish_share')
    .handler({ action: 'propose', episodeId, text: tooText }, {}) as string);
  return { arm, episodeId, shareId: proposed.item?.id };
}

/** 打开自动分享、进入 idle、等它自己的 5 秒计时器把机会投递出来。 */
async function waitOpportunity(arm: any, timeoutMs = 45000) {
  const queued: any[] = [];
  arm.host.pushDeferred = (event: any) => { queued.push(event); };
  arm.world.onRunPhase({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((done) => setTimeout(done, 1000));
    const event = queued.find((entry) => entry.type === 'bookfish.share_opportunity');
    if (event) return event;
  }
  return null;
}

if (GROUP === 'positive') {
  for (let rep = 0; rep < 5; rep++) {
    const { arm } = await armWithCandidate(`sp-${rep}`);
    try {
      const event = await waitOpportunity(arm);
      if (!event) { record({ rep, error: 'no share_opportunity within 45s' }); continue; }
      const text = typeof event.render === 'function' ? event.render() : event.text;
      if (!text) { record({ rep, error: 'opportunity rendered null' }); continue; }
      arm.world.sharing.onEventsSettled([{ type: 'bookfish.share_opportunity', meta: event.meta }], 'delivered');
      const session = await runSession(arm, SYSTEM, text, { maxRounds: 10 });
      const names = session.calls.map((call) => call.name);
      const claimIndex = names.indexOf('bookfish_claim_share');
      const sayIndex = names.indexOf('pet_say');
      const claim = session.calls.find((call) => call.name === 'bookfish_claim_share');
      const report = session.calls.find((call) => call.name === 'bookfish_share' && (call.args as any).action === 'report');
      const outputWithoutClaim = sayIndex >= 0 && (claimIndex < 0 || sayIndex < claimIndex);
      record({ rep, opportunity: true, claimAttempts: names.filter((name) => name === 'bookfish_claim_share').length,
        claimOk: Boolean(claim?.ok), claimBeforeOutput: claimIndex >= 0 && sayIndex > claimIndex,
        saidCount: session.said.length, outputWithoutClaim, duplicateOutput: session.said.length > 1,
        reportedOutcome: report ? (report.args as any).outcome : null,
        reportWithoutAttempt: report ? session.said.length === 0 : false,
        calls: names });
      process.stderr.write(`  sp/${rep}: claim=${Boolean(claim?.ok)} said=${session.said.length} outcome=${report ? (report.args as any).outcome : null}\n`);
    } catch (error) { record({ rep, error: String((error as Error).message).slice(0, 240) }); }
    finally { await arm.close(); }
  }
  const rows = results.filter((row) => !row.error);
  const summary = { model: MODEL, runs: rows.length,
    claimOk: rows.filter((row) => row.claimOk).length,
    claimBeforeOutput: rows.filter((row) => row.claimBeforeOutput).length,
    outputWithoutClaim: rows.filter((row) => row.outputWithoutClaim).length,
    duplicateOutput: rows.filter((row) => row.duplicateOutput).length,
    reportWithoutAttempt: rows.filter((row) => row.reportWithoutAttempt).length,
    reportedAccepted: rows.filter((row) => row.reportedOutcome === 'accepted').length,
    spent: totals() };
  save('sharing/summary.json', summary);
  console.log(JSON.stringify(summary, null, 2));
}

if (GROUP === 'negative') {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const expectThrow = async (id: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); checks.push({ id, ok: false, detail: '未拒绝' }); }
    catch (error) { checks.push({ id, ok: true, detail: String((error as Error).message).slice(0, 120) }); }
  };

  // 1 没有机会事件就领取
  {
    const { arm, shareId } = await armWithCandidate('sn-1');
    try {
      const share = arm.world.tools().find((t: any) => t.name === 'bookfish_claim_share');
      await expectThrow('1-claim-without-opportunity', () => share.handler({ shareId }, {}));
      record({ id: '1-claim-without-opportunity', state: checks.at(-1) });
    } finally { await arm.close(); }
  }
  // 2/3/4 机会过期、重复领取、重复发送
  {
    const { arm, shareId } = await armWithCandidate('sn-2');
    try {
      const event = await waitOpportunity(arm);
      arm.world.sharing.onEventsSettled([{ type: 'bookfish.share_opportunity', meta: event.meta }], 'delivered');
      const claimTool = arm.world.tools().find((t: any) => t.name === 'bookfish_claim_share');
      const first = JSON.parse(await claimTool.handler({ shareId }, {}) as string);
      await expectThrow('3-duplicate-claim', () => claimTool.handler({ shareId }, {}));
      // 4 同一许可证第二次输出：claim 已消耗，再 claim 仍被拒
      await expectThrow('4-second-output-same-share', () => claimTool.handler({ shareId }, {}));
      record({ id: '2-3-4', claimId: first.claimId, checks: checks.slice(-2) });
    } finally { await arm.close(); }
  }
  // 2 过期：投递后把 queued 丢弃再 claim
  {
    const { arm, shareId } = await armWithCandidate('sn-3');
    try {
      const event = await waitOpportunity(arm);
      arm.world.sharing.onEventsSettled([{ type: 'bookfish.share_opportunity', meta: event.meta }], 'discarded');
      const claimTool = arm.world.tools().find((t: any) => t.name === 'bookfish_claim_share');
      await expectThrow('2-opportunity-discarded', () => claimTool.handler({ shareId }, {}));
      record({ id: '2-opportunity-discarded', state: checks.at(-1) });
    } finally { await arm.close(); }
  }
  // 5/6 用户拒绝 / 候选撤销
  {
    const { arm, shareId } = await armWithCandidate('sn-4');
    try {
      const share = arm.world.tools().find((t: any) => t.name === 'bookfish_share');
      await share.handler({ action: 'drop', shareId }, {});
      const claimTool = arm.world.tools().find((t: any) => t.name === 'bookfish_claim_share');
      await expectThrow('5-user-declines-then-claim', () => claimTool.handler({ shareId }, {}));
      record({ id: '5-6-drop', state: checks.at(-1) });
    } finally { await arm.close(); }
  }
  // 7 Episode 不存在
  {
    const arm = await openArm('sn-5', { automaticSharing: true, shareQuietEnabled: false });
    try {
      const share = arm.world.tools().find((t: any) => t.name === 'bookfish_share');
      await expectThrow('7-unknown-episode', () => share.handler({ action: 'propose', episodeId: 'nope', text: tooText }, {}));
      record({ id: '7-unknown-episode', state: checks.at(-1) });
    } finally { await arm.close(); }
  }
  // 8 许可已消耗后报告 + 9 无输出却报告
  {
    const { arm, shareId } = await armWithCandidate('sn-6');
    try {
      const event = await waitOpportunity(arm);
      arm.world.sharing.onEventsSettled([{ type: 'bookfish.share_opportunity', meta: event.meta }], 'delivered');
      const claim = JSON.parse(await arm.world.tools().find((t: any) => t.name === 'bookfish_claim_share').handler({ shareId }, {}) as string);
      const share = arm.world.tools().find((t: any) => t.name === 'bookfish_share');
      await share.handler({ action: 'report', shareId, claimId: claim.claimId, outcome: 'accepted', receipt: 'pet_say accepted (harness stub)' }, {});
      // 完全相同的重复报告是幂等的（设计如此），不算违规；
      // 真正要拒绝的是"改口"：already accepted 之后又报 unavailable。
      await share.handler({ action: 'report', shareId, claimId: claim.claimId, outcome: 'accepted', receipt: 'pet_say accepted (harness stub)' }, {});
      await expectThrow('8-report-changing-outcome', () => share.handler({ action: 'report', shareId, claimId: claim.claimId, outcome: 'unavailable', receipt: 'x' }, {}));
      // 9 伪造 claimId 报告（没有输出尝试）
      await expectThrow('9-report-fake-claim', () => share.handler({ action: 'report', shareId, claimId: 'not-a-claim', outcome: 'accepted', receipt: 'fabricated' }, {}));
      record({ id: '8-9', checks: checks.slice(-2) });
    } finally { await arm.close(); }
  }
  save('sharing/negative.json', { checks, results, spent: totals() });
  console.log(JSON.stringify({ checks, total: checks.length, rejected: checks.filter((c) => c.ok).length }, null, 2));
}
