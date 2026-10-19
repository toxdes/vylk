import {expect, test} from 'bun:test';
await import('./zen-selection.js');

test('selection scrolling ramps gently and stays capped outside either edge', () => {
  const {velocity} = globalThis.VylkZenSelection;
  expect(velocity(300, 100, 500)).toBe(0);
  expect(velocity(482, 100, 500)).toBe(60);
  expect(velocity(118, 100, 500)).toBe(-60);
  expect(velocity(500, 100, 500)).toBe(240);
  expect(velocity(9000, 100, 500)).toBe(240);
  expect(velocity(-9000, 100, 500)).toBe(-240);
  expect(velocity(0, 0, 0)).toBe(0);
});
