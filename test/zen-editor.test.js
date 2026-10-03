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
