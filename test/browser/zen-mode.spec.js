import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

async function openZenMode(page) {
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('A calm page');
  await page.locator('#note-content').fill(Array.from({length:120}, (_, index) => `A deliberately long paragraph ${index} keeps the writing surface scrollable without changing its shape.`).join('\n\n'));
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-zen').click();
  await page.locator('#pref-zen-word-count').check();
  await page.locator('#prefs-close').click();
  await page.locator('[data-panel="zen"]').click();
  await expect(page.locator('#editor')).toHaveClass(/zen-mode/);
  await page.locator('#zen-source-editor').press('Control+End');
  await page.keyboard.type('!');
  await page.waitForTimeout(80);
}

async function replaceZenSource(page, source, lineIndex = 0) {
  await page.locator('[data-zen-action="exit"]').click();
  await page.locator('#note-content').fill(source);
  await page.locator('[data-panel="zen"]').click();
  const editor = page.locator('#zen-source-editor');
  await editor.evaluate((element, index) => {
    const line = element.children[Math.min(index, element.children.length - 1)];
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus({preventScroll:true});
    element.scrollTop = Math.max(0, line.offsetTop - element.clientHeight * .4);
  }, lineIndex);
  return editor;
}

test('Zen mode presents a page, overlays its controls, and keeps a long document scrollable', async ({page}) => {
  await page.setViewportSize({width:1440, height:960});
  await signIn(page);
  await openZenMode(page);

  const [pageBox, controlsBox, titleBox, metrics] = await Promise.all([
    page.locator('#editor-panel').boundingBox(),
    page.locator('.zen-controls').boundingBox(),
    page.locator('#zen-note-title').boundingBox(),
    page.locator('#zen-source-editor').evaluate(editor => ({
      canScroll: editor.scrollHeight > editor.clientHeight,
      scrollTop: editor.scrollTop,
      maxScrollTop: editor.scrollHeight - editor.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(editor).lineHeight),
      scrollbarWidth: getComputedStyle(editor).scrollbarWidth,
      width: editor.getBoundingClientRect().width,
      wordCount: document.querySelector('#zen-word-count')?.textContent,
    })),
  ]);
  expect(pageBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(controlsBox.width).toBeLessThan(110);
  expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
  expect(controlsBox.y).toBeGreaterThanOrEqual(pageBox.y);
  expect(titleBox.x).toBeGreaterThanOrEqual(pageBox.x);
  expect(titleBox.y).toBeGreaterThanOrEqual(pageBox.y);
  expect(metrics.canScroll).toBe(true);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.maxScrollTop).toBeGreaterThan(metrics.lineHeight * 3);
  expect(metrics.scrollTop).toBeLessThanOrEqual(metrics.maxScrollTop);
  expect(metrics.scrollbarWidth).toBe('none');
  expect(metrics.width).toBeGreaterThan(pageBox.width * .8);
  expect(metrics.wordCount).toMatch(/\d+ words/);

  await page.screenshot({path:'/tmp/vylk-zen-desktop.png'});
});

test('Zen mode styles Markdown without replacing its editable source', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const source = '# Heading\n> A quote with **bold**, *italic*, ~~removed~~, and `code`';
  await page.locator('#note-content').fill(source);
  await page.locator('[data-panel="zen"]').click();

  const editor = page.locator('#zen-source-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.zen-md-h1')).toHaveText('# Heading');
  await expect(editor.locator('.zen-md-quote')).toContainText('A quote with');
  await expect(editor.locator('.zen-md-strong')).toHaveText('bold');
  await expect(editor.locator('.zen-md-em')).toHaveText('italic');
  await expect(editor.locator('.zen-md-strike')).toHaveText('removed');
  await expect(editor.locator('.zen-md-code')).toHaveText('code');

  const styles = await editor.evaluate(element => ({
    headingWeight:getComputedStyle(element.querySelector('.zen-md-h1')).fontWeight,
    italic:getComputedStyle(element.querySelector('.zen-md-em')).fontStyle,
    strike:getComputedStyle(element.querySelector('.zen-md-strike')).textDecorationLine,
    quoteBorder:getComputedStyle(element.querySelector('.zen-md-quote')).borderInlineStartWidth,
  }));
  expect(Number(styles.headingWeight)).toBeGreaterThanOrEqual(700);
  expect(styles.italic).toBe('italic');
  expect(styles.strike).toContain('line-through');
  expect(styles.quoteBorder).toBe('1px');

  await editor.press('End');
  await page.keyboard.type('!');
  await page.locator('[data-zen-action="exit"]').click();
  await expect(page.locator('#note-content')).toHaveValue(`${source}!`);
});

test('Zen mode keeps formatting shortcuts, structural edits, and undo', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('Format me');
  await page.locator('[data-panel="zen"]').click();

  const editor = page.locator('#zen-source-editor');
  await editor.press('Control+A');
  await editor.press('Control+B');
  await expect(editor.locator('.zen-md-strong')).toHaveText('Format me');
  await editor.press('Control+End');
  await editor.press('Enter');
  await page.keyboard.type('Next line');
  await expect(editor.locator('.zen-editor-line')).toHaveCount(2);
  await editor.press('Control+Z');
  await expect(editor.locator('.zen-editor-line').last()).toHaveText('Next lin');

  await page.locator('[data-zen-action="exit"]').click();
  await expect(page.locator('#note-content')).toHaveValue('**Format me**\nNext lin');
});

test('Zen mode styles a heading as soon as its separating space is typed', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('[data-panel="zen"]').click();

  const editor = page.locator('#zen-source-editor');
  await page.keyboard.type('##');
  await expect(editor.locator('.zen-md-heading')).toHaveCount(0);
  await page.keyboard.type(' ');
  await expect(editor.locator('.zen-md-h2')).toHaveCount(1);
  await page.keyboard.type('Heading');
  await expect(editor.locator('.zen-md-h2')).toHaveText('## Heading');
});

test('Zen mode styles supported inline tokens as soon as their first character is typed', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('[data-panel="zen"]').click();

  const editor = page.locator('#zen-source-editor');
  const cases = [
    {source:'*i', selector:'.zen-md-em', text:'i'},
    {source:'_i', selector:'.zen-md-em', text:'i'},
    {source:'**b', selector:'.zen-md-strong', text:'b'},
    {source:'__b', selector:'.zen-md-strong', text:'b'},
    {source:'***x', selector:'.zen-md-strong.zen-md-em', text:'x'},
    {source:'___x', selector:'.zen-md-strong.zen-md-em', text:'x'},
    {source:'~~s', selector:'.zen-md-strike', text:'s'},
    {source:'`c', selector:'.zen-md-code', text:'c'},
  ];
  for (const entry of cases) {
    await editor.press('Control+A');
    await editor.press('Backspace');
    await page.keyboard.type(entry.source);
    await expect(editor.locator(entry.selector)).toHaveText(entry.text);
  }
});

test('Zen mode reconciles composed mobile input without duplicating text', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('Alpha');
  await page.locator('[data-panel="zen"]').click();

  const editor = page.locator('#zen-source-editor');
  await editor.evaluate(element => {
    const node = element.firstElementChild.firstChild;
    const selection = getSelection();
    const initial = document.createRange();
    initial.setStart(node, 2);
    initial.collapse(true);
    selection.removeAllRanges();
    selection.addRange(initial);
    element.focus({preventScroll:true});
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true, data:''}));
    node.data = 'Al語pha';
    selection.collapse(node, 3);
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'語'}));
  });

  await expect(editor).toHaveText('Al語pha');
  await page.locator('[data-zen-action="exit"]').click();
  await expect(page.locator('#note-content')).toHaveValue('Al語pha');
});

test('Zen mode does not force a scroll recenter while typing', async ({page}) => {
  await page.setViewportSize({width:1440, height:960});
  await signIn(page);
  await openZenMode(page);

  const editor = await replaceZenSource(page, Array.from({length:400}, (_, index) => `Line ${index}`).join('\n'), 240);
  const before = await editor.evaluate(element => {
    element.dataset.scrollEvents = '0';
    element.addEventListener('scroll', () => {
      element.dataset.scrollEvents = String(Number(element.dataset.scrollEvents || 0) + 1);
    });
    return element.scrollTop;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await editor.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dataset.scrollEvents = '0';
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    window.__zenScrollWrites = [];
    Object.defineProperty(element, 'scrollTop', {
      configurable:true,
      get() { return descriptor.get.call(this); },
      set(value) {
        window.__zenScrollWrites.push({value, stack:new Error().stack});
        descriptor.set.call(this, value);
      },
    });
  }, before);

  await page.keyboard.type('x');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const after = await editor.evaluate(element => ({
    scrollTop: element.scrollTop,
    scrollEvents: Number(element.dataset.scrollEvents || 0),
    writes: window.__zenScrollWrites,
  }));
  expect(after.writes).toEqual([]);
  expect(after.scrollEvents).toBeLessThanOrEqual(1);
});

test('Zen mode does not recenter a visible caret during keyboard navigation', async ({page}) => {
  await page.setViewportSize({width:1440, height:960});
  await signIn(page);
  await openZenMode(page);

  const editor = await replaceZenSource(page, Array.from({length:400}, (_, index) => `Line ${index}`).join('\n'), 240);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const before = await editor.evaluate(element => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    window.__zenNavigationScrollWrites = [];
    Object.defineProperty(element, 'scrollTop', {
      configurable:true,
      get() { return descriptor.get.call(this); },
      set(value) {
        window.__zenNavigationScrollWrites.push(value);
        descriptor.set.call(this, value);
      },
    });
    return element.scrollTop;
  });

  await page.keyboard.press('ArrowUp');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const after = await editor.evaluate(element => ({
    scrollTop:element.scrollTop,
    lineHeight:Number.parseFloat(getComputedStyle(element).lineHeight),
    writes:window.__zenNavigationScrollWrites,
  }));
  expect(after.writes).toEqual([]);
  expect(Math.abs(after.scrollTop - before)).toBeLessThanOrEqual(after.lineHeight);

  await editor.evaluate(element => {
    const lastLine = element.lastElementChild;
    const range = document.createRange();
    range.selectNodeContents(lastLine);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.scrollTop = element.scrollHeight - element.clientHeight;
    window.__zenNavigationScrollWrites = [];
  });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await editor.evaluate(() => window.__zenNavigationScrollWrites)).toEqual([]);
});

test('Zen mode defers word counting until the browser is idle', async ({page}) => {
  await signIn(page);
  await openZenMode(page);

  const count = page.locator('#zen-word-count');
  const before = await count.textContent();
  await page.evaluate(() => {
    window.__pendingZenWordCount = null;
    window.requestIdleCallback = callback => {
      window.__pendingZenWordCount = callback;
      return 1;
    };
    window.cancelIdleCallback = () => {
      window.__pendingZenWordCount = null;
    };
  });

  await page.locator('#zen-source-editor').press('End');
  await page.keyboard.type(' extra');
  await expect(count).toHaveText(before);
  await page.evaluate(() => {
    const callback = window.__pendingZenWordCount;
    window.__pendingZenWordCount = null;
    callback?.({didTimeout:false, timeRemaining:() => 16});
  });

  const previousWords = Number.parseInt(before, 10);
  await expect(count).toHaveText(`${previousWords + 1} words`);
});

test('Zen mode exposes which writing view is active', async ({page}) => {
  await signIn(page);
  await openZenMode(page);

  const editorControl = page.locator('[data-zen-action="editor"]');
  const previewControl = page.locator('[data-zen-action="preview"]');
  await expect(editorControl).toHaveAttribute('aria-pressed', 'true');
  await expect(previewControl).toHaveAttribute('aria-pressed', 'false');

  await previewControl.click();
  await expect(editorControl).toHaveAttribute('aria-pressed', 'false');
  await expect(previewControl).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-zen-action="exit"]').click();
  await expect(page.locator('#editor')).not.toHaveClass(/zen-mode/);
  await expect(page.locator('#note-content')).toBeFocused();
});

test('Zen mode keeps actionable connection feedback visible without showing routine toasts', async ({page}) => {
  await signIn(page);
  await openZenMode(page);
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    document.querySelector('#editor > .offline-notice').classList.remove('hidden');
    const routine = document.createElement('div');
    routine.className = 'toast visible';
    routine.dataset.testToast = 'routine';
    routine.textContent = 'Routine status';
    const warning = document.createElement('div');
    warning.className = 'toast warning visible';
    warning.dataset.testToast = 'warning';
    warning.textContent = 'Sync needs attention';
    document.querySelector('#toast-region').append(routine, warning);
  });

  await expect(page.locator('#editor > .offline-notice')).toBeVisible();
  await expect(page.locator('[data-test-toast="warning"]')).toBeVisible();
  await expect(page.locator('[data-test-toast="routine"]')).toBeHidden();
});

test('Zen preview renders stale Markdown away from the main UI thread', async ({page}) => {
  await signIn(page);
  await openZenMode(page);

  await page.evaluate(() => {
    window.__mainThreadMarkdownParses = 0;
    const originalMarked = window.marked;
    const parse = originalMarked.parse.bind(originalMarked);
    const wrappedParse = (...args) => {
      window.__mainThreadMarkdownParses++;
      return parse(...args);
    };
    window.marked = new Proxy(originalMarked, {
      get(target, property, receiver) {
        if (property === 'parse') return wrappedParse;
        return Reflect.get(target, property, receiver);
      },
    });
    window.__markdownParseProbeInstalled = window.marked.parse === wrappedParse;
  });
  expect(await page.evaluate(() => window.__markdownParseProbeInstalled)).toBe(true);
  await page.locator('#zen-source-editor').press('End');
  await page.keyboard.type('\n\nRendered away from the typing thread');
  await page.locator('[data-zen-action="preview"]').click();

  await expect(page.locator('#preview')).toContainText('Rendered away from the typing thread');
  await expect(page.locator('#preview')).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__mainThreadMarkdownParses)).toBe(0);
});

test('Zen mode preserves its writing page on a narrow screen', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await signIn(page);
  await openZenMode(page);
  await expect(page.locator('#zen-source-editor')).toBeVisible();
  await expect(page.locator('.zen-controls button')).toHaveCount(3);
  const [textareaBox, controlsBox, firstControlBox, titleBox, wordCountBox] = await Promise.all([
    page.locator('#zen-source-editor').boundingBox(),
    page.locator('.zen-controls').boundingBox(),
    page.locator('.zen-controls button').first().boundingBox(),
    page.locator('#zen-note-title').boundingBox(),
    page.locator('#zen-word-count').boundingBox(),
  ]);
  expect(textareaBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(firstControlBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(wordCountBox).not.toBeNull();
  expect(textareaBox.x).toBeLessThanOrEqual(20);
  expect(390 - textareaBox.x - textareaBox.width).toBeLessThanOrEqual(20);
  expect(firstControlBox.width).toBeGreaterThanOrEqual(44);
  expect(controlsBox.y).toBeLessThanOrEqual(12);
  expect(titleBox.x).toBeLessThanOrEqual(20);
  expect(390 - wordCountBox.x - wordCountBox.width).toBeLessThanOrEqual(20);
  await page.screenshot({path:'/tmp/vylk-zen-mobile.png'});
});

test.describe('touch editing', () => {
  test.use({hasTouch:true, isMobile:true, viewport:{width:390, height:844}});

  test('Zen mode accepts touch-focused input without horizontal overflow', async ({page}) => {
    await signIn(page);
    await page.locator('#new-note-btn').click();
    await page.locator('[data-panel="zen"]').click();

    const editor = page.locator('#zen-source-editor');
    await editor.tap();
    await page.keyboard.insertText('## Mobile heading');
    await expect(editor.locator('.zen-md-h2')).toHaveText('## Mobile heading');
    const metrics = await editor.evaluate(element => ({
      fontSize:Number.parseFloat(getComputedStyle(element).fontSize),
      overflows:element.scrollWidth > element.clientWidth,
    }));
    expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
    expect(metrics.overflows).toBe(false);
  });
});
