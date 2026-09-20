import {expect, test} from 'bun:test';

await import('./preview-navigation.js');

const navigation = globalThis.VylkPreviewNavigation;

test('preview navigation maps source positions and bounds scrolling', () => {
  const ranges = [
    {start: 0, end: 4},
    {start: 6, end: 10},
  ];
  expect(navigation.blockIndexAtPosition(ranges, 3)).toBe(0);
  expect(navigation.blockIndexAtPosition(ranges, 5)).toBe(-1);
  expect(navigation.blockIndexAtPosition(ranges, 6)).toBe(1);
  expect(navigation.editPosition({kind: 'list-item', start: 0, end: 10}, '- [ ] task')).toBe(6);
  expect(
    navigation.scrollAdjustment({
      previewTop: 0,
      previewHeight: 100,
      previewScrollTop: 20,
      previewScrollHeight: 200,
      anchorTop: 180,
      caretTop: 50,
      margin: 10,
      deadband: 5,
    }),
  ).toBe(80);
});
