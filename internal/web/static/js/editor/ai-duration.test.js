import {expect, test} from 'bun:test';
import {formatElapsed} from './ai-controller.js';

test('formats elapsed query time with compact seconds, minutes and hours', () => {
  for (const [milliseconds, expected] of [
    [0, '0s'],
    [2000, '2s'],
    [2300, '2.3s'],
    [2349, '2.3s'],
    [2350, '2.4s'],
    [59940, '59.9s'],
    [59950, '1m'],
    [60000, '1m'],
    [61000, '1m 1s'],
    [130000, '2m 10s'],
    [3600000, '1h'],
    [3723000, '1h 2m 3s'],
  ])
    expect(formatElapsed(milliseconds)).toBe(expected);
});
