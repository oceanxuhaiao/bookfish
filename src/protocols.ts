/**
 * Single source of truth for the on-demand protocol topics.
 *
 * Four places used to hand-maintain this list (ENV_PROMPT prose, the
 * `bookfish_help` schema enum, `BookfishWorld#help`, and the budget test), which
 * is how `story` ended up missing from the resident prompt after it shipped.
 * Everything now derives from here, and `tests/context-budget.test.ts` checks
 * that every topic has a document and every document has a topic.
 */
export const HELP_TOPICS = [
  'reading',
  'journal',
  'retrieval',
  'sharing',
  'review',
  'selection',
  'discussion',
  'story',
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];
