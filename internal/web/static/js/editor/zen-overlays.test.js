import {expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./zen-overlays.js');

test('Zen overlays update title, word count, and control density', () => {
  const dom = new JSDOM(`
    <input id="note-title" value="Draft">
    <span id="zen-note-title"></span><span id="zen-word-count"></span>
    <div class="zen-controls"></div><svg><use id="zen-exit-icon"></use></svg>
  `);
  const preferences = {zenShowControls: false, zenShowTitle: true, zenWordCount: true};
  const overlays = globalThis.VylkZenOverlays.create({
    document: dom.window.document,
    getPanelState: () => 'zen',
    getPreferences: () => preferences,
    getSource: () => 'one two\nthree',
    window: dom.window,
  });

  overlays.update();

  expect(dom.window.document.querySelector('#zen-note-title').textContent).toBe('Draft');
  expect(dom.window.document.querySelector('#zen-word-count').textContent).toBe('3 words');
  expect(dom.window.document.querySelector('.zen-controls').classList.contains('is-minimal')).toBe(
    true,
  );
  expect(overlays.countWords('')).toBe(0);
  expect(overlays.countWords('word')).toBe(1);
});
