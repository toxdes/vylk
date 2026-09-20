import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./preview-content.js');

function setup() {
  const dom = new JSDOM('', {url: 'https://notes.example/'});
  const policy = globalThis.VylkPreviewContent.create({
    document: dom.window.document,
    escapeHTML(value) {
      const element = dom.window.document.createElement('div');
      element.textContent = value;
      return element.innerHTML;
    },
    getMarked: () => null,
    location: dom.window.location,
  });
  return {document: dom.window.document, policy};
}

describe('preview content policy', () => {
  test('removes executable markup and unsafe resource URLs', () => {
    const {document, policy} = setup();
    const template = document.createElement('template');
    template.innerHTML = `
      <script>alert(1)</script>
      <a href="javascript:alert(1)" onclick="alert(1)">unsafe</a>
      <a href="mailto:person@example.com">mail</a>
      <img src="https://images.example/note.png" onerror="alert(1)">
      <input type="text"><input type="checkbox" checked>
    `;

    policy.sanitize(template.content);

    expect(template.content.querySelector('script')).toBeNull();
    expect(template.content.querySelector('a').hasAttribute('href')).toBe(false);
    expect(template.content.querySelector('a[href^="mailto:"]')).not.toBeNull();
    expect(template.content.querySelector('img').getAttribute('loading')).toBe('lazy');
    expect(template.content.querySelector('input[type="text"]')).toBeNull();
    expect(template.content.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  test('linkifies wiki syntax except inside code and existing links', () => {
    const {document, policy} = setup();
    const container = document.createElement('div');
    container.innerHTML =
      '<p>See [[  Project   Plan ]]</p><code>[[literal]]</code><a>[[linked]]</a>';

    policy.linkifyWikiLinks(container);

    const wikiLink = container.querySelector('.wiki-link');
    expect(wikiLink.dataset.wikiTitle).toBe('Project Plan');
    expect(wikiLink.textContent).toBe('Project Plan');
    expect(container.querySelector('code').textContent).toBe('[[literal]]');
    expect(container.querySelector('a:not(.wiki-link)').textContent).toBe('[[linked]]');
  });

  test('allows only web URLs and optional mail links', () => {
    const {policy} = setup();
    expect(policy.safeURL('/image.png')).toBe(true);
    expect(policy.safeURL('data:text/html,unsafe')).toBe(false);
    expect(policy.safeURL('mailto:person@example.com')).toBe(false);
    expect(policy.safeURL('mailto:person@example.com', true)).toBe(true);
  });
});
