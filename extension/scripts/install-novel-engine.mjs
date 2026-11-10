/**
 * Historical development helper.
 *
 * Early versions copied an already-verified runtime from a research checkout
 * into the World data directory. That copy logic is intentionally retired:
 * ordinary users install the runtime from the Bookfish settings page (online
 * or offline ZIP), and developers can exercise the same production pipeline
 * with `node --import tsx scripts/verify-novel-runtime.mts`.
 *
 * This script no longer writes anything.
 */
console.error([
  'install-novel-engine.mjs is retired and does not copy files.',
  'Use the Bookfish settings page ("小说获取引擎" card) to install or import a runtime ZIP.',
  'For an isolated developer verification, run:',
  '  node --import tsx scripts/verify-novel-runtime.mts',
].join('\n'));
process.exit(2);
