import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./preview-dom.js');

function setup() {
  const dom = new JSDOM('<div id="preview"></div>');
  const document = dom.window.document;
  const synced = [];
  const view = globalThis.VylkPreviewDOM.create({
    contentPolicy: {
      linkifyWikiLinks() {},
      sanitize(container) {
        container.querySelectorAll('script').forEach((element) => element.remove());
      },
    },
    document,
    preview: document.querySelector('#preview'),
    syncTaskCheckbox: (item) => synced.push(item),
  });
  return {document, synced, view};
}

describe('preview DOM reconciliation', () => {
  test('creates only one matching top-level element from a worker block', () => {
    const {view} = setup();
    expect(
      view.elementFromBlock({tagName: 'P', html: '<p>safe<script>bad</script></p>'}).outerHTML,
    ).toBe('<p>safe</p>');
    expect(view.elementFromBlock({tagName: 'P', html: '<p>one</p><p>two</p>'})).toBeNull();
    expect(view.elementFromBlock({tagName: 'H1', html: '<p>wrong</p>'})).toBeNull();
  });

  test('updates compatible elements while preserving interactive metadata', () => {
    const {document, view} = setup();
    const current = document.createElement('p');
    current.dataset.interactiveStart = '10';
    current.className = 'old';
    current.textContent = 'old';
    const replacement = document.createElement('p');
    replacement.className = 'new';
    replacement.textContent = 'new';

    expect(view.canUpdateInPlace(current, replacement)).toBe(true);
    view.updateElement(current, replacement);

    expect(current.dataset.interactiveStart).toBe('10');
    expect(current.className).toBe('new');
    expect(current.textContent).toBe('new');
  });

  test('rejects nested or structurally different list patches', () => {
    const {document, view} = setup();
    const current = document.createElement('ul');
    current.innerHTML = '<li>one</li>';
    const replacement = document.createElement('ul');
    replacement.innerHTML = '<li>one<ul><li>nested</li></ul></li>';

    expect(view.canUpdateInPlace(current, replacement)).toBe(false);
  });
});
