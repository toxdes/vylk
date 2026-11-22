import {describe, expect, test} from 'bun:test';
import {changedSpan, mapOffset, mergeEdits} from './ai-rebase.js';

describe('changedSpan', () => {
  test('finds the single changed span', () => {
    expect(changedSpan('one two three', 'one 2 three')).toEqual({start: 4, oldEnd: 7, newEnd: 5});
    expect(changedSpan('same', 'same')).toEqual({start: 4, oldEnd: 4, newEnd: 4});
    expect(changedSpan('aaa', 'aaaa')).toEqual({start: 3, oldEnd: 3, newEnd: 4});
  });
  test('never splits a surrogate pair', () => {
    expect(changedSpan('🙂a', '🙃a')).toEqual({start: 0, oldEnd: 2, newEnd: 2});
    expect(changedSpan('a🙂', 'a🙃')).toEqual({start: 1, oldEnd: 3, newEnd: 3});
  });
});

describe('mapOffset', () => {
  const change = changedSpan('one two three four', 'one 2 and 3 four');
  test('keeps offsets before the change and shifts those after it', () => {
    expect(mapOffset(3, change)).toBe(3);
    expect(mapOffset(18, change, {end: true})).toBe(16);
  });
  test('a selection around the change keeps covering it', () => {
    expect([mapOffset(4, change), mapOffset(13, change, {end: true})]).toEqual([4, 11]);
    expect([mapOffset(6, change), mapOffset(9, change, {end: true})]).toEqual([4, 11]);
  });
});

describe('mergeEdits', () => {
  const base = 'alpha beta gamma delta';
  test('keeps both edits when they touch different text', () => {
    expect(mergeEdits(base, 'ALPHA beta gamma delta', 'alpha beta gamma DELTA')).toBe(
      'ALPHA beta gamma DELTA',
    );
    expect(mergeEdits(base, 'alpha beta gamma DELTA', 'ALPHA beta gamma delta')).toBe(
      'ALPHA beta gamma DELTA',
    );
  });
  test('returns either side when the other is unchanged or identical', () => {
    expect(mergeEdits(base, base, 'theirs')).toBe('theirs');
    expect(mergeEdits(base, 'ours', base)).toBe('ours');
    expect(mergeEdits(base, 'same', 'same')).toBe('same');
  });
  test('refuses overlapping edits', () => {
    expect(mergeEdits(base, 'alpha BETA gamma delta', 'alpha bet gamma delta')).toBeNull();
  });
});
