import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./formatting-toolbar.js');

function setup() {
  const dom = new JSDOM(`
    <div class="fmt-bar">
      <button data-fmt="bold">Bold</button>
      <button data-fmt="table" aria-expanded="false">Table</button>
    </div>
  `);
  const writes = [];
  const notifications = [];
  globalThis.VylkFormattingToolbar.create({
    document: dom.window.document,
    window: dom.window,
    formatting: {
      format: (_value, _start, _end, type) => ({value: `${type} text`, cursor: 4}),
      table: (_value, _start, _end, rows, columns) => ({
        value: `${columns}x${rows} table`,
        cursor: 2,
      }),
    },
    isLocked: () => false,
    readSource: () => ({value: 'text', start: 0, end: 4}),
    writeSource: (value, cursor) => writes.push({value, cursor}),
    onFormatted: (options) => notifications.push(options),
  });
  return {document: dom.window.document, notifications, writes};
}

describe('formatting toolbar', () => {
  test('applies inline formatting and requests an immediate preview', () => {
    const context = setup();
    context.document.querySelector('[data-fmt="bold"]').click();
    expect(context.writes).toEqual([{value: 'bold text', cursor: 4}]);
    expect(context.notifications).toEqual([{immediate: true}]);
  });

  test('inserts the selected table size and closes the picker', () => {
    const context = setup();
    const trigger = context.document.querySelector('[data-fmt="table"]');
    trigger.click();
    const cell = context.document.querySelector('[data-rows="2"][data-columns="3"]');
    cell.click();
    expect(context.writes).toEqual([{value: '3x2 table', cursor: 2}]);
    expect(context.notifications).toEqual([{immediate: false}]);
    expect(context.document.querySelector('#table-picker').classList.contains('hidden')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
