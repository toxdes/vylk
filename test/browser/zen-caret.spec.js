import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';

const asset = (path) => new URL(`../../internal/web/static/${path}`, import.meta.url).pathname;
const shell = readFileSync(asset('index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');

async function fixture(page, value) {
  await page.setContent(shell);
  await page.addStyleTag({path: asset('style.css')});
  for (const path of [
    'vendor/marked.min.js',
    'js/editor/markdown-links.js',
    'js/editor/zen-inline.js',
    'js/editor/zen-editor.js',
  ])
    await page.addScriptTag({path: asset(path)});
  await page.evaluate((source) => {
    document.querySelector('#app').classList.remove('booting');
    document.querySelector('#boot-screen').hidden = true;
    document.querySelector('#login-screen').classList.add('hidden');
    const screen = document.querySelector('#editor');
    screen.classList.remove('hidden');
    screen.classList.add('zen-mode', 'header-hidden');
    const editor = new window.VylkZenEditor(document.querySelector('#zen-source-editor'));
    window.__zen = editor;
    editor.setValue(source);
    editor.active = true;
    editor.focus();
  }, value);
}

const state = (page) =>
  page.evaluate(() => {
    const editor = window.__zen;
    const {start, end} = editor.selection();
    const location = editor.offsets.locate(start);
    const element = editor.lines[location.line].element;
    // Syntax the writer cannot see must never touch a collapsed caret.
    const hiddenAtCaret = window.VylkZenInline.spans(element).filter(
      (span) => !span.shown && span.start <= location.offset && location.offset <= span.end,
    );
    return {
      value: editor.value,
      start,
      end,
      lineStart: start - location.offset,
      lineLength: editor.lines[location.line].text.length,
      hiddenAtCaret: hiddenAtCaret.length,
    };
  });

// Every offset on the caret's line is one arrow press from its neighbours.
// Left and Right are the editor's own keydown handling, so the sweep runs in
// the page instead of paying a browser round trip per press.
async function expectLineReachable(page, log) {
  const visited = await page.evaluate(() => {
    const editor = window.__zen;
    const caret = editor.selection().start;
    const location = editor.offsets.locate(caret);
    const lineStart = caret - location.offset;
    const length = editor.lines[location.line].text.length;
    const press = (key) =>
      editor.element.dispatchEvent(new KeyboardEvent('keydown', {key, cancelable: true}));
    const offsets = [];
    editor.setSelection(lineStart);
    for (let step = 0; step <= length; step++) {
      offsets.push(editor.selection().start - lineStart);
      if (step < length) press('ArrowRight');
    }
    for (let step = 0; step < length; step++) {
      press('ArrowLeft');
      offsets.push(editor.selection().start - lineStart);
    }
    editor.setSelection(caret);
    return {offsets, length};
  });
  const expected = [
    ...Array.from({length: visited.length + 1}, (_, index) => index),
    ...Array.from({length: visited.length}, (_, index) => visited.length - 1 - index),
  ];
  expect(visited.offsets, log()).toEqual(expected);
}

test('the caret steps out of a link completed inside its parentheses', async ({page}) => {
  await fixture(page, '');
  await page.keyboard.type('[lol]()');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('s');
  expect(await state(page)).toMatchObject({value: '[lol](s)', start: 7});
  await expect(page.locator('.zen-md-shown-syntax')).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' after');
  expect((await state(page)).value).toBe('[lol](s) after');
  await expect(page.locator('.zen-md-link')).toHaveText('lol');
  await expect(page.locator('.zen-md-inline-syntax').first()).toBeHidden();
});

test('arrowing across formatting reveals its syntax only while the caret touches it', async ({
  page,
}) => {
  await fixture(page, 'a **b** c');
  await page.evaluate(() => window.__zen.setSelection(0));
  await expect(page.locator('.zen-md-shown-syntax')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.zen-md-shown-syntax')).toHaveCount(2);
  for (let press = 0; press < 5; press++) await page.keyboard.press('ArrowRight');
  expect((await state(page)).start).toBe(7);
  await expect(page.locator('.zen-md-shown-syntax')).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.zen-md-shown-syntax')).toHaveCount(0);
  await expect(page.locator('#zen-source-editor')).toHaveText('a b c', {useInnerText: true});
});

// Random key sequences over Markdown punctuation. Reproduce a failure with
// ZEN_CARET_SEED=<seed> from its message; add ZEN_CARET_RUNS to search onward.
const seed = Number(process.env.ZEN_CARET_SEED) || 0x5eed;
const runs = Number(process.env.ZEN_CARET_RUNS) || (process.env.ZEN_CARET_SEED ? 1 : 4);
const keys = [
  ...'[]()*~`ab /',
  'ArrowLeft',
  'ArrowLeft',
  'ArrowRight',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Enter',
  'Backspace',
  'Delete',
];

function random(state) {
  // Mulberry32: small, seedable, and reproducible across runs.
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('random editing keeps every offset reachable and edits at the caret', async ({page}) => {
  test.setTimeout(120_000);
  for (let run = 0; run < runs; run++) {
    const runSeed = seed + run;
    const next = random(runSeed);
    const pressed = [];
    const log = () => `ZEN_CARET_SEED=${runSeed} keys: ${JSON.stringify(pressed)}`;
    if (run) await page.evaluate(() => window.__zen.setValue(''));
    else await fixture(page, '');
    let before = await state(page);
    for (let step = 0; step < 30; step++) {
      const key = keys[Math.floor(next() * keys.length)];
      pressed.push(key);
      await page.keyboard.press(key);
      const after = await state(page);
      expect(after.hiddenAtCaret, log()).toBe(0);
      if (key.length === 1) {
        expect(after.value, log()).toBe(
          before.value.slice(0, before.start) + key + before.value.slice(before.start),
        );
        expect(after.start, log()).toBe(before.start + 1);
      }
      if (step % 10 === 9) await expectLineReachable(page, log);
      before = after;
    }
    await expectLineReachable(page, log);
  }
});
