import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';

const source = readFileSync(
  new URL('../internal/web/static/js/editor/zen-editor.js', import.meta.url),
  'utf8',
);
const motionSource = readFileSync(
  new URL('../internal/web/static/js/core/motion.js', import.meta.url),
  'utf8',
);
let dom;

afterEach(() => {
  dom?.window.close();
});

function createEditor(value) {
  dom = new JSDOM('<button>Before editor</button><div id="editor" tabindex="0"></div>', {
    runScripts: 'outside-only',
    url: 'https://vylk.test/',
  });
  dom.window.requestAnimationFrame = vi.fn(() => 1);
  dom.window.cancelAnimationFrame = vi.fn();
  dom.window.eval(motionSource);
  for (const file of [
    'vendor/marked.min.js',
    'js/editor/markdown-links.js',
    'js/editor/zen-inline.js',
  ])
    dom.window.eval(
      readFileSync(new URL(`../internal/web/static/${file}`, import.meta.url), 'utf8'),
    );
  dom.window.eval(source);
  const editor = new dom.window.VylkZenEditor(dom.window.document.querySelector('#editor'));
  editor.setValue(value);
  editor.active = true;
  editor.focus();
  return editor;
}

test.each(['😀', '👩🏽‍💻', 'e\u0301', 'क़'])(
  'deletes %s as one grapheme in either direction',
  (cluster) => {
    const editor = createEditor(`A${cluster}B`);
    editor.setSelection(1 + cluster.length);
    editor.deleteBackward(editor.selection());
    expect(editor.value).toBe('AB');
    editor.undo();
    expect(editor.value).toBe(`A${cluster}B`);
    editor.setSelection(1);
    editor.deleteForward(editor.selection());
    expect(editor.value).toBe('AB');
  },
);

test('browser select-all boundaries map to the complete Markdown document', () => {
  const original = 'One **two**\n- three\n\nLast';
  const editor = createEditor(original);
  dom.window.getSelection().selectAllChildren(editor.element);
  expect(editor.selection()).toMatchObject({start: 0, end: original.length});
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('');
  editor.undo();
  expect(editor.value).toBe(original);
});

test.each(['forward', 'backward'])(
  'reconciles a cross-line %s composition as one undoable edit',
  (direction) => {
    const editor = createEditor('Alpha\nBeta\nGamma');
    const untouched = editor.lines[2].element;
    editor.setSelection(1, 8, direction);
    editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
    editor.lines[0].element.textContent = 'A語ta';
    editor.lines[1].element.remove();
    dom.window.getSelection().collapse(editor.lines[0].element.firstChild, 2);
    editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionend', {data: '語'}));
    expect(editor.value).toBe('A語ta\nGamma');
    expect(editor.lines).toHaveLength(2);
    expect(editor.lines[1].element).toBe(untouched);
    expect(editor.selectionStart).toBe(2);
    editor.undo();
    expect(editor.value).toBe('Alpha\nBeta\nGamma');
    editor.redo();
    expect(editor.value).toBe('A語ta\nGamma');
  },
);

test('formatting preserves prior undo and untouched line nodes', () => {
  const editor = createEditor('Hello\nUnchanged');
  const untouched = editor.lines[1].element;
  editor.setSelection(5);
  editor.replaceSelection('!');
  editor.applyValue('**Hello!**\nUnchanged', 10);
  expect(editor.lines[1].element).toBe(untouched);
  editor.undo();
  expect(editor.value).toBe('Hello!\nUnchanged');
  editor.undo();
  expect(editor.value).toBe('Hello\nUnchanged');
  editor.redo();
  editor.redo();
  expect(editor.value).toBe('**Hello!**\nUnchanged');
});

test('completed links render labels and retain exact source offsets and undo', () => {
  const editor = createEditor('See [a **bold** label](https://example.com/a(b))\nUntouched');
  const anchor = editor.element.querySelector('a');
  expect(anchor.textContent).toBe('a **bold** label');
  expect(anchor.querySelector('.zen-md-strong').textContent).toBe('bold');
  const source = editor.value;
  for (const offset of [0, 4, 5, 7, 12, 20, source.indexOf('\n'), source.length]) {
    editor.setSelection(offset);
    const point = editor.domPoint(offset);
    expect(point.node.parentElement?.closest('.zen-md-link-syntax')).toBeFalsy();
    expect(editor.selectionStart).toBe(offset);
  }
  const untouched = editor.lines[1].element;
  editor.setSelection(6);
  editor.replaceSelection('new');
  expect(editor.value).toBe(source.slice(0, 6) + 'new' + source.slice(6));
  expect(editor.lines[1].element).toBe(untouched);
  editor.undo();
  expect(editor.value).toBe(source);
});

test('a link becomes rendered only when its closing parenthesis arrives', () => {
  const editor = createEditor('[link](https://example.com');
  editor.setSelection(editor.length);
  expect(editor.element.querySelector('a')).toBeNull();
  editor.replaceSelection(')');
  expect(editor.element.querySelector('a').textContent).toBe('link');
  expect(editor.selectionStart).toBe(editor.length);
  editor.undo();
  expect(editor.element.querySelector('a')).toBeNull();
});

test.each([
  ['**', 'zen-md-strong'],
  ['__', 'zen-md-strong'],
  ['*', 'zen-md-em'],
  ['_', 'zen-md-em'],
  ['~~', 'zen-md-strike'],
  ['`', 'zen-md-code'],
])('completed %s syntax is hidden without changing source or undo', (marker, className) => {
  const editor = createEditor(`${marker}Hello\nUntouched`);
  const untouched = editor.lines[1].element;
  expect(editor.element.querySelector('.zen-md-inline-syntax')).toBeNull();
  editor.setSelection(marker.length + 5);
  editor.replaceSelection(marker);
  expect(editor.element.querySelector(`.${className}`).textContent).toBe('Hello');
  expect(editor.lines[0].element.querySelectorAll('.zen-md-inline-syntax')).toHaveLength(2);
  expect(editor.lines[0].element.textContent).toBe(`${marker}Hello${marker}`);
  expect(editor.selectionStart).toBe(marker.length * 2 + 5);
  expect(editor.lines[1].element).toBe(untouched);
  editor.replaceSelection(' after');
  expect(editor.value).toBe(`${marker}Hello${marker} after\nUntouched`);
  editor.undo();
  editor.undo();
  expect(editor.value).toBe(`${marker}Hello\nUntouched`);
  expect(editor.element.querySelector('.zen-md-inline-syntax')).toBeNull();
});

test.each([
  'word_with_underscores',
  '\\*literal\\*',
  '**unfinished',
  '~~unfinished',
  '`unfinished',
])('keeps non-formatting or incomplete %s visible', (source) => {
  const editor = createEditor(source);
  expect(editor.element.querySelector('.zen-md-inline-syntax')).toBeNull();
  expect(editor.element.textContent).toBe(source);
});

test('nested formatting and links preserve source and keep structural markers visible', () => {
  const source = '# **a *nested* [link](https://example.com)**\n> ~~strike~~ and `code`\n- list';
  const editor = createEditor(source);
  expect(editor.element.textContent).toBe(source.replaceAll('\n', ''));
  expect(editor.element.querySelector('.zen-md-strong .zen-md-em').textContent).toBe('nested');
  expect(editor.element.querySelector('.zen-md-strong a').textContent).toBe('link');
  expect(
    editor.element.querySelectorAll('.zen-md-heading-marker, .zen-md-quote-marker'),
  ).toHaveLength(2);
  const marker = editor.element.querySelector('.zen-md-format-syntax');
  expect(marker.getAttribute('aria-hidden')).toBe('true');
});

test.each([1, 2, 3, 4, 5, 6])(
  'recognizes H%s and preserves its literal Markdown markers',
  (level) => {
    const source = '#'.repeat(level) + ' Heading';
    const editor = createEditor(source);
    expect(editor.lines[0].element.classList.contains(`zen-md-h${level}`)).toBe(true);
    expect(editor.lines[0].element.querySelector('.zen-md-heading-marker').textContent).toBe(
      '#'.repeat(level),
    );
    expect(editor.value).toBe(source);
  },
);

test('seven hashes remain ordinary prose rather than an H7 heading', () => {
  const editor = createEditor('####### Ordinary prose');
  expect(editor.element.querySelector('.zen-md-heading')).toBeNull();
  expect(editor.value).toBe('####### Ordinary prose');
});

test('blank-line styling follows whitespace edits through the plain-text fast path', () => {
  const editor = createEditor(' \nUntouched');
  const line = editor.lines[0].element;
  expect(line.classList.contains('zen-md-blank')).toBe(true);
  editor.setSelection(1);
  editor.replaceSelection('text');
  expect(editor.lines[0].element).toBe(line);
  expect(line.classList.contains('zen-md-blank')).toBe(false);
  editor.undo();
  expect(line.classList.contains('zen-md-blank')).toBe(true);
  expect(editor.value).toBe(' \nUntouched');
});

test.each(['- ', '* ', '+ ', '12. ', '3) ', '  - ', '\t- '])(
  'list typography preserves the literal %s prefix and source selection',
  (prefix) => {
    const editor = createEditor(prefix + 'A **bold** item\nUntouched');
    const line = editor.lines[0].element;
    const untouched = editor.lines[1].element;
    expect(line.querySelector('.zen-md-list-marker').textContent).toBe(prefix);
    expect(line.querySelector('.zen-md-strong').textContent).toBe('bold');
    editor.setSelection(prefix.length + 1);
    editor.replaceSelection(' longer');
    expect(editor.value).toBe(prefix + 'A longer **bold** item\nUntouched');
    expect(editor.lines[1].element).toBe(untouched);
    editor.undo();
    expect(editor.value).toBe(prefix + 'A **bold** item\nUntouched');
  },
);

test('typing and removing a list prefix updates its layout without changing source', () => {
  const editor = createEditor('-');
  editor.setSelection(1);
  editor.replaceSelection(' ');
  expect(editor.lines[0].element.classList.contains('zen-md-list')).toBe(true);
  expect(editor.lines[0].element.querySelector('.zen-md-list-content')).not.toBeNull();
  expect(editor.value).toBe('- ');
  editor.undo();
  expect(editor.lines[0].element.classList.contains('zen-md-list')).toBe(false);
  expect(editor.lines[0].element.querySelector('.zen-md-list-content')).toBeNull();
  expect(editor.value).toBe('-');
});

test.each(['**', '*', '~~', '`'])(
  'deleting across hidden %s boundaries preserves unselected formatting',
  (marker) => {
    const original = `Before ${marker}Hello${marker} after`;
    const editor = createEditor(original);
    const middle = 7 + marker.length + 2;
    editor.setSelection(0, middle);
    editor.deleteBackward(editor.selection());
    expect(editor.value).toBe(`${marker}llo${marker} after`);
    editor.undo();
    editor.setSelection(middle, editor.length);
    editor.replaceSelection('!');
    expect(editor.value).toBe(`Before ${marker}He${marker}!`);
    editor.undo();
    expect(editor.value).toBe(original);
  },
);

test('deleting the final visible nested character removes all empty wrappers', () => {
  const editor = createEditor('**[~~😀~~](https://example.com)**');
  const offset = editor.value.indexOf('😀') + 2;
  editor.setSelection(offset);
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('');
  editor.undo();
  expect(editor.value).toBe('**[~~😀~~](https://example.com)**');
});

test('hidden inline boundaries unwrap or delete visible text, with one-step undo', () => {
  const editor = createEditor('A **Hello** B');
  editor.setSelection(4);
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('A Hello B');
  editor.undo();
  editor.setSelection(9);
  editor.deleteForward(editor.selection());
  expect(editor.value).toBe('A Hello B');
  editor.undo();
  editor.setSelection(11);
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('A **Hell** B');
  editor.undo();
  editor.setSelection(2);
  editor.deleteForward(editor.selection());
  expect(editor.value).toBe('A **ello** B');
});

test('Enter inside nested formatting closes each retained fragment on its own line', () => {
  const editor = createEditor('**one *two three* four**');
  editor.setSelection(editor.value.indexOf(' three'));
  editor.replaceSelection('\n');
  expect(editor.value).toBe('**one *two***\n ***three* four**');
  expect(editor.lines[1].element.querySelector('.zen-md-strong .zen-md-em').textContent).toBe(
    'three',
  );
  editor.undo();
  expect(editor.value).toBe('**one *two three* four**');
});

test('IME replacement across a hidden style boundary preserves its unselected prefix', () => {
  const editor = createEditor('**Hello** world\nUntouched');
  const untouched = editor.lines[1].element;
  editor.setSelection(4, 12);
  editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  editor.lines[0].element.textContent = '**He語rld';
  dom.window.getSelection().collapse(editor.lines[0].element.firstChild, 5);
  editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionend', {data: '語'}));
  expect(editor.value).toBe('**He**語rld\nUntouched');
  expect(editor.selectionStart).toBe(7);
  expect(editor.lines[1].element).toBe(untouched);
  editor.undo();
  expect(editor.value).toBe('**Hello** world\nUntouched');
});

test.each(['Plain', '**Hello**', '[Hello](https://example.com)'])(
  'deleting inside %s does not materialize the full document',
  (source) => {
    const editor = createEditor(source + '\nUntouched');
    editor.setSelection(source.indexOf('l') + 1);
    const read = vi.spyOn(editor, 'value', 'get').mockImplementation(() => {
      throw new Error('Full-document read on the deletion path');
    });
    editor.deleteBackward(editor.selection());
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(editor.value).toBe(source.replace('l', '') + '\nUntouched');
  },
);

test.each([
  '`[code](https://example.com)`',
  '![image](https://example.com)',
  '\\[escaped](https://example.com)',
  '[unsafe](javascript:alert(1))',
])('does not turn %s into an active link', (text) => {
  const editor = createEditor(text);
  expect(editor.element.querySelector('a')).toBeNull();
  expect(editor.value).toBe(text);
});

test('deleting at hidden link boundaries preserves visible text and stays undoable', () => {
  const editor = createEditor('A [label](https://example.com) B');
  const link = editor.linkAt(4);
  editor.setSelection(link.labelStart);
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('A label B');
  expect(editor.selectionStart).toBe(2);
  editor.undo();
  editor.setSelection(link.labelStart, link.labelEnd);
  editor.deleteForward(editor.selection());
  expect(editor.value).toBe('A  B');
  editor.undo();
  editor.setSelection(link.end);
  editor.deleteBackward(editor.selection());
  expect(editor.value).toBe('A [labe](https://example.com) B');
});

test.each(['delete', 'type', 'cut'])(
  '%s across a partial link preserves the unselected linked label and destination',
  (action) => {
    const original = 'Before [Hello](https://example.com) after';
    const editor = createEditor(original);
    editor.setSelection(0, 10);
    if (action === 'delete') editor.deleteBackward(editor.selection());
    else if (action === 'type') editor.replaceSelection('New ');
    else editor.onCut({preventDefault() {}, clipboardData: {setData() {}}});
    expect(editor.value).toBe(
      (action === 'type' ? 'New ' : '') + '[llo](https://example.com) after',
    );
    editor.undo();
    expect(editor.value).toBe(original);
    editor.setSelection(10, editor.length);
    editor.replaceSelection('!');
    expect(editor.value).toBe('Before [He](https://example.com)!');
    editor.undo();
    expect(editor.value).toBe(original);
  },
);

test.each(['😀', 'word'])('deleting the final linked %s removes its hidden wrapper', (label) => {
  const editor = createEditor(`[${label}](https://example.com)`);
  editor.setSelection(label.length + 1);
  editor.deleteBackward(editor.selection(), label === 'word');
  expect(editor.value).toBe('');
  editor.undo();
  expect(editor.value).toBe(`[${label}](https://example.com)`);
});

test('Shift+Tab leaves navigation to the browser and does not edit text', () => {
  const editor = createEditor('Hello');
  editor.setSelection(5);
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    cancelable: true,
  });
  editor.element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(editor.value).toBe('Hello');
});

test('caret geometry follows the focus endpoint of a backward selection', () => {
  const editor = createEditor('Alpha\nBeta');
  editor.setSelection(0, editor.length, 'backward');
  const selection = dom.window.getSelection();
  let measured;
  dom.window.Range.prototype.getClientRects = function () {
    measured = {node: this.startContainer, offset: this.startOffset, collapsed: this.collapsed};
    return [{top: 10, height: 20}];
  };
  editor.caretRect();
  expect(measured).toEqual({
    node: selection.focusNode,
    offset: selection.focusOffset,
    collapsed: true,
  });
});

test('cancelled composition preserves text, selection, and history', () => {
  const editor = createEditor('Alpha\n\nBeta');
  editor.setSelection(1, 8, 'backward');
  editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  editor.element.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
  expect(editor.value).toBe('Alpha\n\nBeta');
  expect(editor.selection()).toEqual({start: 1, end: 8, direction: 'backward'});
  expect(editor.history).toHaveLength(0);
});

function animationClock(editor) {
  const frames = new Map();
  let id = 0;
  let time = 0;
  dom.window.requestAnimationFrame = (callback) => {
    frames.set(++id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (frame) => frames.delete(frame);
  Object.defineProperties(editor.element, {
    scrollHeight: {value: 4000, configurable: true},
    clientHeight: {value: 1000},
  });
  editor.element.getBoundingClientRect = () => ({top: 0, height: 1000});
  let caret = 900;
  editor.caretRect = () => ({top: caret - editor.element.scrollTop, height: 20});
  return {
    frames,
    caret: (next) => {
      caret = next;
    },
    tick: () => {
      time += 16;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
    },
  };
}

test('scroll animation follows the latest edit and stops when settled', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  editor.scheduleTypingAnchor({smooth: true});
  clock.tick();
  clock.tick();
  clock.caret(2400);
  editor.scheduleTypingAnchor();
  for (let index = 0; index < 100; index++) clock.tick();
  expect(editor.element.scrollTop).toBeCloseTo(1990, 0);
  expect(clock.frames.size).toBe(0);
});

test('an edit already in the comfortable band cancels an obsolete target', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  editor.scheduleTypingAnchor();
  clock.tick();
  clock.tick();
  clock.caret(600);
  editor.scheduleTypingAnchor();
  clock.tick();
  const position = editor.element.scrollTop;
  for (let index = 0; index < 100; index++) clock.tick();
  expect(editor.element.scrollTop).toBe(position);
  expect(clock.frames.size).toBe(0);
});

test.each(['wheel', 'touchstart', 'pointerdown', 'blur'])(
  '%s interrupts automatic scrolling without a trailing snap-back',
  (type) => {
    const editor = createEditor('Hello');
    const clock = animationClock(editor);
    editor.scheduleTypingAnchor({smooth: true});
    clock.tick();
    clock.tick();
    const position = editor.element.scrollTop;
    editor.element.dispatchEvent(
      type === 'pointerdown'
        ? new dom.window.MouseEvent(type, {button: 0})
        : new dom.window.Event(type),
    );
    for (let index = 0; index < 100; index++) clock.tick();
    expect(editor.element.scrollTop).toBe(position);
    expect(clock.frames.size).toBe(0);
  },
);

test('reduced motion uses immediate positioning without an animation loop', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  dom.window.matchMedia = () => ({matches: true});
  editor.scheduleTypingAnchor({smooth: true});
  clock.tick();
  expect(editor.element.scrollTop).toBe(490);
  expect(clock.frames.size).toBe(0);
});

test('a shrinking document clamps an in-flight scroll and releases its frame', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  editor.scheduleTypingAnchor({smooth: true});
  clock.tick();
  clock.tick();
  Object.defineProperty(editor.element, 'scrollHeight', {value: 1100});
  clock.caret(400);
  for (let index = 0; index < 100; index++) clock.tick();
  expect(editor.element.scrollTop).toBeLessThanOrEqual(100);
  expect(clock.frames.size).toBe(0);
});

test('scroll animation settles when the browser rounds scrollTop to whole pixels', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  let position = 0;
  Object.defineProperty(editor.element, 'scrollTop', {
    get: () => position,
    set: (value) => {
      position = Math.round(value);
    },
  });
  clock.caret(400);
  editor.animateAnchor(100);
  for (let index = 0; index < 100; index++) clock.tick();
  expect(position).toBe(100);
  expect(clock.frames.size).toBe(0);
});

test('writing view changes preserve undo while a new note resets it', () => {
  createEditor('');
  const document = dom.window.document;
  document.body.innerHTML =
    '<textarea id="note-content"></textarea><div id="zen-source-editor" tabindex="0"></div>';
  dom.window.eval(
    readFileSync(
      new URL('../internal/web/static/js/editor/source-adapter.js', import.meta.url),
      'utf8',
    ),
  );
  const onInput = vi.fn();
  const adapter = dom.window.VylkEditorSource.create({
    document,
    window: dom.window,
    onInput,
    onLengthChange: vi.fn(),
  });
  adapter.setValue('Hello', 5);
  adapter.activateZen();
  const editor = adapter.zenEditor();
  expect(editor.history).toHaveLength(0);
  expect(onInput).not.toHaveBeenCalled();
  editor.replaceSelection('!');
  adapter.deactivateZen();
  adapter.textarea.value = 'Hello! Normal edit';
  adapter.activateZen();
  expect(onInput).toHaveBeenCalledTimes(1);
  editor.undo();
  expect(adapter.value()).toBe('Hello!');
  editor.undo();
  expect(adapter.value()).toBe('Hello');
  adapter.deactivateZen();
  adapter.setValue('Different note');
  adapter.activateZen();
  editor.undo();
  expect(adapter.value()).toBe('Different note');
});

test('extending a selection does not schedule caret recentering', () => {
  const editor = createEditor('Hello');
  const clock = animationClock(editor);
  editor.onKeyUp({key: 'ArrowDown', shiftKey: true});
  expect(clock.frames.size).toBe(0);
});
