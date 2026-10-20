import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';

let dom;
let toolbar;
afterEach(() => {
  toolbar?.destroy();
  dom?.window.close();
});

function setup(value = 'Hello world', {onUnsupported} = {}) {
  dom = new JSDOM('<div id="editor" tabindex="0"></div>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const {window} = dom;
  for (const path of [
    'vendor/marked.min.js',
    'js/core/motion.js',
    'js/editor/markdown-links.js',
    'js/editor/zen-inline.js',
    'js/editor/zen-editor.js',
    'js/editor/zen-toolbar.js',
  ])
    window.eval(readFileSync(new URL(`../internal/web/static/${path}`, import.meta.url), 'utf8'));
  window.Range.prototype.getClientRects = () => [
    {top: 200, bottom: 220, left: 100, right: 160, width: 60, height: 20},
  ];
  const editor = new window.VylkZenEditor(window.document.querySelector('#editor'));
  editor.element.getBoundingClientRect = () => ({top: 0, bottom: 500});
  editor.setValue(value);
  editor.active = true;
  editor.focus();
  editor.setSelection(0, 5);
  toolbar = window.VylkZenToolbar.create({
    document: window.document,
    window,
    getEditor: () => editor,
    isLocked: () => false,
    onUnsupported,
  });
  return {editor, window, document: window.document};
}

test.each([
  ['bold', '**Hello** world'],
  ['italic', '*Hello* world'],
  ['strike', '~~Hello~~ world'],
  ['code', '`Hello` world'],
])('selection toolbar applies and removes %s in single undo steps', (action, expected) => {
  const {editor} = setup();
  toolbar.format(action);
  expect(editor.value).toBe(expected);
  expect(editor.textBetween(editor.selectionStart, editor.selectionEnd)).toBe('Hello');
  toolbar.format(action);
  expect(editor.value).toBe('Hello world');
  editor.undo();
  expect(editor.value).toBe(expected);
  editor.undo();
  expect(editor.value).toBe('Hello world');
});

function visibleText(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('.zen-md-inline-syntax').forEach((marker) => marker.remove());
  return copy.textContent;
}

function characters(element) {
  const result = [];
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('.zen-md-inline-syntax')) continue;
    const marks = ['strong', 'em', 'strike', 'code'].filter((kind) =>
      node.parentElement.closest(`.zen-md-${kind}`),
    );
    for (let offset = 0; offset < node.length; offset++)
      result.push({
        text: node.data[offset],
        marks,
        href: node.parentElement.closest('a')?.getAttribute('href') || null,
      });
  }
  return result;
}

function selectVisible(editor, window, from, to, direction = 'forward') {
  const nodes = [];
  const walker = window.document.createTreeWalker(editor.element, 4);
  let node;
  while ((node = walker.nextNode()))
    if (!node.parentElement.closest('.zen-md-inline-syntax'))
      for (let offset = 0; offset < node.length; offset++) nodes.push({node, offset});
  const first = nodes[from];
  const last = nodes[to - 1];
  window
    .getSelection()
    .setBaseAndExtent(
      direction === 'backward' ? last.node : first.node,
      direction === 'backward' ? last.offset + 1 : first.offset,
      direction === 'backward' ? first.node : last.node,
      direction === 'backward' ? first.offset : last.offset + 1,
    );
}

function expectCoverage(editor, before, from, to, kind, removing) {
  const after = characters(editor.element);
  expect(after.map((entry) => entry.text).join(''), editor.value).toBe(
    before.map((entry) => entry.text).join(''),
  );
  after.forEach((entry, index) => {
    expect(entry.href, editor.value).toBe(before[index].href);
    if (!/\S/.test(entry.text)) return;
    const expected = new Set(before[index].marks);
    if (index >= from && index < to && !entry.marks.includes('code')) {
      if (removing) expected.delete(kind);
      else expected.add(kind);
    }
    expect(new Set(entry.marks), `${editor.value} at ${index}`).toEqual(expected);
  });
}

test.each([
  '**abc**',
  '_abc_',
  '~~abc~~',
  '***abc***',
  '**ab *cd* ef**',
  '*ab **cd** ef*',
  '**ab** *cd*',
  'a**bc**d',
  'a*bc*d',
  '**ab~~cd~~ef**',
  '[**ab cd**](/n)',
  '**[ab cd](/n) ef**',
  '**ab `cd` ef**',
  '`abc`',
  '**ab**  *cd*',
  '«**ab cd**»!',
  '***ab ~~cd~~ ef***',
  '**a  b**',
  '**é文**x',
])(
  'every visual subrange of %s preserves text, links and independent formatting',
  (source) => {
    const {editor, window} = setup(source);
    const before = characters(editor.element);
    for (const [type, kind] of [
      ['bold', 'strong'],
      ['italic', 'em'],
      ['strike', 'strike'],
    ])
      for (let from = 0; from < before.length; from++)
        for (let to = from + 1; to <= before.length; to++) {
          const selected = before
            .slice(from, to)
            .filter((entry) => /\S/.test(entry.text) && !entry.marks.includes('code'));
          if (!selected.length) continue;
          editor.setValue(source);
          selectVisible(editor, window, from, to, 'backward');
          const removing = selected.every((entry) => entry.marks.includes(kind));
          toolbar.format(type);
          expectCoverage(editor, before, from, to, kind, removing);
          const first = editor.value;
          toolbar.format(type);
          expectCoverage(editor, before, from, to, kind, !removing);
          editor.undo();
          expect(editor.value).toBe(first);
          editor.undo();
          expect(editor.value).toBe(source);
        }
  },
  20000,
);

test.each([
  ['bold', '**foo bar**', 4, 7],
  ['bold', '**foo bar baz**', 4, 7],
  ['italic', '_foo bar baz_', 4, 7],
  ['strike', '~~foo bar baz~~', 4, 7],
  ['bold', '***foo bar baz***', 4, 7],
  ['italic', '***foo bar baz***', 4, 7],
  ['bold', '**foo bar** baz', 4, 11],
  ['bold', 'foo **bar baz**', 0, 7],
  ['bold', '**[foo bar](/notes) baz**', 4, 7],
  ['bold', '[**foo bar**](/notes) baz', 4, 7],
  ['italic', '**foo _bar baz_**', 4, 11],
  ['bold', '__keep__ / **foo bar baz** / _also keep_', 11, 14],
])(
  'toggling %s preserves text and other marks for a partial selection in %s',
  (type, source, from, to) => {
    const {editor, window} = setup(source);
    const before = characters(editor.element);
    // Make a real visual selection, excluding every hidden Markdown marker.
    selectVisible(editor, window, from, to);
    const kind = {bold: 'strong', italic: 'em', strike: 'strike'}[type];
    const removing = before
      .slice(from, to)
      .filter((entry) => /\S/.test(entry.text))
      .every((entry) => entry.marks.includes(kind));
    toolbar.format(type);
    const after = characters(editor.element);
    expect(after.map((entry) => entry.text).join(''), editor.value).toBe(
      before.map((entry) => entry.text).join(''),
    );
    after.forEach((entry, index) => {
      if (!/\S/.test(entry.text)) return;
      const expected = new Set(before[index].marks);
      if (index >= from && index < to) {
        if (removing) expected.delete(kind);
        else expected.add(kind);
      }
      expect(new Set(entry.marks), `${editor.value} at ${index}`).toEqual(expected);
    });
    const result = editor.value;
    editor.undo();
    expect(editor.value).toBe(source);
    editor.redo();
    expect(editor.value).toBe(result);
  },
);

test('a partial removal across lines keeps blank lines and toggles back as one undo step', () => {
  const source = '**foo bar**\n\n**baz qux**';
  const {editor, window} = setup(source);
  selectVisible(editor, window, 4, 10, 'backward');
  toolbar.format('bold');
  expect(editor.value).toBe('**foo** bar\n\nbaz **qux**');
  expect(editor.selection().direction).toBe('backward');
  toolbar.format('bold');
  expect(editor.value).toBe(source);
  editor.undo();
  expect(editor.value).toBe('**foo** bar\n\nbaz **qux**');
  editor.undo();
  expect(editor.value).toBe(source);
});

test('whole-document formatting preserves headings, quotes, list markers and untouched source', () => {
  const source = '# **foo bar**\n\n- **baz qux**\n> **red blue**';
  const {editor, window} = setup(source);
  window.getSelection().selectAllChildren(editor.element);
  toolbar.format('bold');
  expect(editor.value).toBe('# foo bar\n\n- baz qux\n> red blue');
  toolbar.format('bold');
  expect(editor.value).toBe(source);
  editor.setValue('_keep_ / **foo bar** / __also keep__');
  selectVisible(editor, window, 11, 14);
  toolbar.format('bold');
  expect(editor.value).toBe('_keep_ / **foo** bar / __also keep__');
});

test('formatting a short selection keeps distant line nodes and avoids a full document read', () => {
  const {editor, window} = setup('Distant\n'.repeat(2000) + '**foo bar**\nEnd');
  const distant = editor.element.firstChild;
  const line = editor.element.children[2000];
  const label = line.querySelector('.zen-md-strong').firstChild;
  window.getSelection().setBaseAndExtent(label, 4, label, 7);
  const read = vi.spyOn(editor, 'value', 'get');
  toolbar.format('bold');
  expect(read).not.toHaveBeenCalled();
  expect(editor.element.firstChild).toBe(distant);
  expect(line.textContent).toBe('**foo** bar');
  read.mockRestore();
});

test('formatting reads current source after native typing, deletion and undo fast paths', () => {
  const {editor, window} = setup('foo');
  editor.replaceRange(3, 3, ' bar');
  editor.replaceRange(0, 1, 'F');
  selectVisible(editor, window, 4, 7);
  toolbar.format('bold');
  expect(editor.value).toBe('Foo **bar**');
  editor.undo();
  expect(editor.value).toBe('Foo bar');
  editor.replaceRange(3, 7, '');
  editor.undo();
  selectVisible(editor, window, 0, 7);
  toolbar.format('italic');
  expect(editor.value).toBe('*Foo bar*');
});

test.each(['bold', 'italic', 'strike'])(
  'the %s action leaves inline code literal and unchanged',
  (type) => {
    const source = 'a`**b**`c';
    const {editor, window} = setup(source);
    selectVisible(editor, window, 2, 5);
    toolbar.format(type);
    expect(editor.value).toBe(source);
    expect(editor.history).toHaveLength(0);
    const mixed = 'before ```` **literal** ```` after';
    editor.setValue(mixed);
    const before = characters(editor.element);
    window.getSelection().selectAllChildren(editor.element);
    toolbar.format(type);
    expectCoverage(
      editor,
      before,
      0,
      before.length,
      {bold: 'strong', italic: 'em', strike: 'strike'}[type],
      false,
    );
    expect(editor.element.querySelector('.zen-md-code').textContent).toBe(' **literal** ');
    expect(editor.value).toContain('```` **literal** ````');
    editor.undo();
    expect(editor.value).toBe(mixed);
  },
);

test.each([
  ['a!b', 1, 2],
  ['**a`bc`d**', 0, 4],
])(
  'unrepresentable formatting in %s preserves source, selection and history with feedback',
  (source, from, to) => {
    const onUnsupported = vi.fn();
    const {editor, window} = setup(source, {onUnsupported});
    selectVisible(editor, window, from, to, 'backward');
    const selection = editor.selection();
    toolbar.format('bold');
    expect(editor.value).toBe(source);
    expect(editor.selection()).toEqual(selection);
    expect(editor.history).toHaveLength(0);
    expect(onUnsupported).toHaveBeenCalledWith(
      'Markdown cannot represent this formatting exactly. Select complete words or spans.',
    );
  },
);

test('bold toggles uniformly after mixing bold and italic over foo bar', () => {
  const {editor} = setup('foo bar');
  editor.setSelection(4, 7);
  toolbar.format('bold');
  expect(editor.value).toBe('foo **bar**');
  editor.setSelection(0, editor.length);
  toolbar.format('italic');
  expect(visibleText(editor.element)).toBe('foo bar');
  expect(visibleText(editor.element.querySelector('.zen-md-em'))).toBe('foo bar');
  toolbar.format('bold');
  const before = editor.value;
  expect(visibleText(editor.element)).toBe('foo bar');
  expect(visibleText(editor.element.querySelector('.zen-md-strong'))).toBe('foo bar');
  toolbar.format('bold');
  expect(visibleText(editor.element)).toBe('foo bar');
  expect(editor.element.querySelectorAll('.zen-md-strong').length, editor.value).toBe(0);
  expect(visibleText(editor.element.querySelector('.zen-md-em'))).toBe('foo bar');
  editor.undo();
  expect(editor.value).toBe(before);
  editor.redo();
  expect(editor.element.querySelector('.zen-md-strong')).toBeNull();
});

test.each([
  ['bold', 'italic'],
  ['italic', 'bold'],
  ['strike', 'italic'],
])('repeated %s toggles keep independent %s formatting', (type, other) => {
  const {editor} = setup('foo bar');
  editor.setSelection(4, 7);
  toolbar.format(type);
  editor.setSelection(0, editor.length);
  toolbar.format(other);
  toolbar.format(type);
  toolbar.format(type);
  const classes = {bold: 'zen-md-strong', italic: 'zen-md-em', strike: 'zen-md-strike'};
  expect(visibleText(editor.element)).toBe('foo bar');
  expect(editor.element.querySelectorAll(`.${classes[type]}`).length, editor.value).toBe(0);
  expect(visibleText(editor.element.querySelector(`.${classes[other]}`))).toBe('foo bar');
});

test.each(['**foo** **bar**', '__foo__ **bar**', '**foo __bar__**'])(
  'removes every bold span from the selected %s',
  (source) => {
    const {editor} = setup(source);
    editor.setSelection(0, editor.length);
    toolbar.format('bold');
    expect(editor.value).toBe('foo bar');
    editor.undo();
    expect(editor.value).toBe(source);
  },
);

test('link popup preserves selection, validates URLs, supports editing and removal', () => {
  const {editor, window, document} = setup();
  const submit = () =>
    document
      .querySelector('#zen-link-popup')
      .dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  toolbar.format('link');
  const input = document.querySelector('#zen-link-url');
  input.value = 'javascript:alert(1)';
  submit();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(editor.value).toBe('Hello world');
  input.value = 'https://example.com/a(b)';
  submit();
  expect(editor.value).toBe('[Hello](https://example.com/a\\(b\\)) world');
  expect(editor.element.querySelector('a').href).toBe('https://example.com/a(b)');
  editor.setSelection(3);
  toolbar.format('link');
  expect(input.value).toBe('https://example.com/a(b)');
  input.value = '/relative';
  submit();
  expect(editor.value).toBe('[Hello](/relative) world');
  editor.setSelection(3);
  toolbar.format('link');
  input.value = '  ';
  submit();
  expect(editor.value).toBe('Hello world');
  editor.undo();
  expect(editor.value).toBe('[Hello](/relative) world');
});

test('link popup has one icon action, blank creation is a no-op, and click-away cancels', () => {
  const {editor, window, document} = setup();
  toolbar.format('link');
  const popup = document.querySelector('#zen-link-popup');
  const button = popup.querySelector('button');
  expect(popup.querySelectorAll('button')).toHaveLength(1);
  expect(button.getAttribute('aria-label')).toBe('Apply link');
  expect(button.querySelector('use').getAttribute('href')).toBe('#icon-check');
  expect(button.textContent.trim()).toBe('');
  button.click();
  expect(popup.hidden).toBe(true);
  expect(editor.history).toHaveLength(0);
  expect(editor.selection()).toMatchObject({start: 0, end: 5});
  toolbar.format('link');
  document.querySelector('input').value = 'https://example.com';
  document.body.dispatchEvent(new window.Event('pointerdown', {bubbles: true}));
  expect(popup.hidden).toBe(true);
  expect(editor.value).toBe('Hello world');
  expect(editor.history).toHaveLength(0);
});

test.each([
  'hello',
  'example.com',
  'https://',
  'https:///example.com',
  'https://?query',
  'https:example.com',
  'http://[invalid',
  'https://example.com:99999',
  'https://example.com/a b',
  'https:\\example.com',
  'mailto:hello',
  'tel:hello',
  'tel:---',
  '//',
  '///example.com',
])('rejects invalid URL input %s without changing the note or undo history', (href) => {
  const {editor, window, document} = setup();
  toolbar.format('link');
  const popup = document.querySelector('#zen-link-popup');
  const input = document.querySelector('#zen-link-url');
  input.value = href;
  popup.dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  expect(popup.hidden).toBe(false);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.querySelector('#zen-link-error').hidden).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(editor.value).toBe('Hello world');
  expect(editor.history).toHaveLength(0);
});

test.each([
  'https://example.com/path?query=1#section',
  'http://localhost:8080/',
  'https://[::1]:8080/',
  'mailto:writer@example.com?subject=Hello',
  'tel:+1-555-0100;ext=12',
  '/notes/one',
  './one',
  '../one',
  '#section',
  '?view=notes',
  '//example.com/path',
])('accepts an explicit valid destination %s', (href) => {
  const {editor, window, document} = setup();
  toolbar.format('link');
  document.querySelector('#zen-link-url').value = href;
  document
    .querySelector('#zen-link-popup')
    .dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  expect(document.querySelector('#zen-link-popup').hidden).toBe(true);
  expect(editor.element.querySelector('a').getAttribute('href')).toBe(href);
  expect(editor.history).toHaveLength(1);
});

test('correcting an invalid URL or clearing it removes the error state', () => {
  const {editor, window, document} = setup();
  toolbar.format('link');
  const input = document.querySelector('#zen-link-url');
  const popup = document.querySelector('#zen-link-popup');
  input.value = 'hello';
  popup.dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  input.value = 'https://example.com';
  input.dispatchEvent(new window.Event('input', {bubbles: true}));
  expect(input.hasAttribute('aria-invalid')).toBe(false);
  expect(document.querySelector('#zen-link-error').hidden).toBe(true);
  expect(popup.hidden).toBe(false);
  input.value = '';
  input.dispatchEvent(new window.Event('input', {bubbles: true}));
  popup.dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  expect(popup.hidden).toBe(true);
  expect(editor.history).toHaveLength(0);
});

test('Escape cancels the popup before the app handler and restores backward selection', () => {
  const {editor, window, document} = setup();
  editor.setSelection(0, 5, 'backward');
  toolbar.format('link');
  const appHandler = vi.fn();
  document.addEventListener('keydown', appHandler);
  document
    .querySelector('input')
    .dispatchEvent(
      new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}),
    );
  expect(appHandler).not.toHaveBeenCalled();
  expect(document.querySelector('#zen-link-popup').hidden).toBe(true);
  expect(document.activeElement).toBe(editor.element);
  expect(editor.selection()).toMatchObject({start: 0, end: 5, direction: 'backward'});
  expect(editor.value).toBe('Hello world');
});

test('a stale URL popup cannot edit a replaced note', () => {
  const {editor, window, document} = setup();
  toolbar.format('link');
  editor.setValue('Different note');
  document.querySelector('input').value = 'https://example.com';
  document
    .querySelector('form')
    .dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  expect(editor.value).toBe('Different note');
  expect(document.querySelector('#zen-link-popup').hidden).toBe(true);
});

test.each([
  ['Hello\nworld', 0, 11, '**Hello**\n**world**'],
  [' Hello world ', 0, 13, ' **Hello world** '],
  ['[Hello](https://example.com) world', 3, 34, '[He**llo**](https://example.com) **world**'],
])(
  'formats visible spans independently in %s and undoes as one operation',
  (value, start, end, expected) => {
    const {editor} = setup(value);
    editor.setSelection(start, Math.min(end, editor.length));
    toolbar.format('bold');
    expect(editor.value).toBe(expected);
    toolbar.format('bold');
    expect(editor.value).toBe(value);
    editor.undo();
    expect(editor.value).toBe(expected);
    editor.undo();
    expect(editor.value).toBe(value);
  },
);

test('does not insert a nested link across an existing link boundary', () => {
  const {editor, document} = setup('[Hello](https://example.com) world');
  editor.setSelection(3, editor.length);
  toolbar.format('link');
  expect(document.querySelector('#zen-link-popup').hidden).toBe(true);
  expect(editor.value).toBe('[Hello](https://example.com) world');
});

test('inline code can contain literal backticks', () => {
  const {editor} = setup('a`b');
  editor.setSelection(0, 3);
  toolbar.format('code');
  expect(editor.value).toBe('``a`b``');
  expect(editor.element.querySelector('.zen-md-code').textContent).toBe('a`b');
  toolbar.format('code');
  expect(editor.value).toBe('a`b');
  editor.undo();
  expect(editor.value).toBe('``a`b``');
  editor.undo();
  expect(editor.value).toBe('a`b');
});
