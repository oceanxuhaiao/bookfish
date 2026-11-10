import { describe, expect, it } from 'vitest';
import { moodPrefix } from '../../src/webui/mood.ts';

describe('reading mood presentation', () => {
  it.each([
    ['替他不平', '😠 '], ['替他憋着一口气', '😠 '], ['心里空了一块', '😔 '], ['心里咯噔一下', '😟 '], ['有点不服气', '😠 '],
    ['又好笑又替他捏把汗', '😟 '], ['有些心疼', '😔 '],
    ['心里发暖、有点服气', '🤩 '], ['好奇', '🤔 '],
    ['惊讶', '😯 '], ['relieved', '😌 '],
    ['五味杂陈', ''], ['', ''], [null, ''], [undefined, ''],
  ])('uses the saved mood %s without a bubble fallback', (label, expected) => {
    expect(moodPrefix(label)).toBe(expected);
  });
});
