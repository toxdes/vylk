import {expect, test} from 'bun:test';
import {changedRanges} from './ai-word-diff.js';

const budget = () => ({cells: 262144, marks: 2048});
const highlighted = (value, ranges) => ranges.map(([start, end]) => value.slice(start, end));

test('highlights separate word changes without marking shared context', () => {
  const before = 'Plan the release and email the team.';
  const after = 'Plan the launch and message the team.';
  const ranges = changedRanges(before, after, budget());
  expect(highlighted(before, ranges.before)).toEqual(['release', 'email']);
  expect(highlighted(after, ranges.after)).toEqual(['launch', 'message']);
});

test('handles insertions, deletions, Unicode, whitespace and unchanged text', () => {
  for (const [before, after] of [
    ['', 'new'],
    ['gone', ''],
    ['🙂 café', '😊 café'],
    ['🧑', '👑'],
    ['a b', 'a  b'],
    ['same', 'same'],
  ]) {
    const ranges = changedRanges(before, after, budget());
    for (const [value, changes] of [
      [before, ranges.before],
      [after, ranges.after],
    ]) {
      let end = 0;
      for (const [start, stop] of changes) {
        expect(start).toBeGreaterThanOrEqual(end);
        expect(stop).toBeGreaterThan(start);
        expect(stop).toBeLessThanOrEqual(value.length);
        expect(value.slice(start, stop).isWellFormed()).toBe(true);
        end = stop;
      }
    }
  }
  expect(highlighted('🙂 café', changedRanges('🙂 café', '😊 café', budget()).before)).toEqual([
    '🙂',
  ]);
  expect(changedRanges('same', 'same', budget())).toEqual({before: [], after: []});
});

test('large replacements and exhausted budgets fall back to bounded highlights', () => {
  const before = 'prefix ' + 'old '.repeat(10000) + 'suffix';
  const after = 'prefix ' + 'new '.repeat(10000) + 'suffix';
  const limits = {cells: 0, marks: 0};
  const ranges = changedRanges(before, after, limits);
  expect(ranges.before).toHaveLength(1);
  expect(ranges.after).toHaveLength(1);
  expect(highlighted(before, ranges.before)[0]).not.toContain('prefix');
  expect(highlighted(after, ranges.after)[0]).not.toContain('suffix');
  expect(limits).toEqual({cells: 0, marks: 0});
});
