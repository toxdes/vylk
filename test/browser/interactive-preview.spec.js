import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

async function enableInteractivePreview(page) {
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-editor').click();
  const preference = page.locator('#pref-interactive-preview');
  if (!await preference.isChecked()) await preference.check();
  await page.locator('#prefs-close').click();
  await expect(page.locator('#prefs-modal')).toBeHidden();
}

test('interactive preview preserves selection and tracks drag reflow', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('- Alpha\n- Bravo\n- Charlie\n- Delta');
  await enableInteractivePreview(page);

  const body = page.locator('#preview .preview-list-item-body').first();
  const firstHandle = page.locator('#preview .preview-drag-handle').first();
  const firstEdit = page.getByRole('button', {name:'Edit this block in source'}).first();
  await expect.poll(() => firstHandle.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
  await expect.poll(() => firstEdit.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
  await body.hover();
  await expect.poll(() => firstHandle.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.8);
  await expect.poll(() => firstEdit.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  await firstEdit.click();
  await expect(page.locator('#note-content')).toBeFocused();
  await expect(page.locator('.editor-source-wrap')).toHaveClass(/is-caret-visible/);
  const firstCue = await page.locator('.editor-current-line').boundingBox();
  const firstEditor = await page.locator('#note-content').boundingBox();
  expect(firstCue).not.toBeNull();
  expect(firstEditor).not.toBeNull();
  expect(firstCue.y).toBeGreaterThanOrEqual(firstEditor.y);
  expect(firstCue.y).toBeLessThan(firstEditor.y + firstEditor.height);
  expect(await page.locator('#note-content').evaluate(textarea => getComputedStyle(textarea).caretColor)).not.toBe('auto');
  expect(await page.locator('#note-content').evaluate(textarea => textarea.selectionStart)).toBe(2);
  await body.hover();
  await page.locator('#note-content').evaluate(textarea => {
    const position = textarea.value.indexOf('Charlie');
    textarea.setSelectionRange(position, position);
    textarea.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  });
  await expect(page.locator('#preview .interactive-preview-list-card').nth(2)).toHaveClass(/highlight/);
  await expect(page.locator('#preview > ul')).not.toHaveClass(/highlight/);
  const textBounds = await body.boundingBox();
  expect(textBounds).not.toBeNull();
  await page.mouse.move(textBounds.x + 2, textBounds.y + textBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(textBounds.x + Math.min(44, textBounds.width - 2), textBounds.y + textBounds.height / 2);
  await page.mouse.up();
  await expect(page.locator('.preview-drag-ghost')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString().length || 0)).toBeGreaterThan(0);

  const handles = page.locator('#preview .preview-drag-handle');
  const sourceHandle = await handles.nth(0).boundingBox();
  const targetHandle = await handles.nth(2).boundingBox();
  const sourceCard = await page.locator('#preview .interactive-preview-list-card').nth(0).boundingBox();
  expect(sourceHandle).not.toBeNull();
  expect(targetHandle).not.toBeNull();
  expect(sourceCard).not.toBeNull();
  const start = {x:sourceHandle.x + sourceHandle.width / 2, y:sourceHandle.y + sourceHandle.height / 2};
  const moved = {x:start.x + 36, y:start.y + 14};
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(moved.x, moved.y, {steps:2});

  const ghost = await page.locator('.preview-drag-ghost').boundingBox();
  expect(Math.abs((ghost.x - sourceCard.x) - (moved.x - start.x))).toBeLessThanOrEqual(2);
  expect(Math.abs((ghost.y - sourceCard.y) - (moved.y - start.y))).toBeLessThanOrEqual(2);
  await page.mouse.move(targetHandle.x + targetHandle.width / 2, targetHandle.y + targetHandle.height, {steps:2});
  expect(await page.evaluate(() => document.getAnimations().some(animation => animation.id === 'preview-reflow'))).toBe(true);
  await page.mouse.up();

  await expect(page.locator('#note-content')).toHaveValue('- Bravo\n- Charlie\n- Alpha\n- Delta');
  await expect(page.locator('.preview-drag-ghost')).toHaveCount(0);
});

test('source caret cue follows wrapped visual rows', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const content = 'wrapped '.repeat(40).trim();
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();

  const setCaret = async position => editor.evaluate((textarea, nextPosition) => {
    textarea.setSelectionRange(nextPosition, nextPosition);
    textarea.dispatchEvent(new Event('select', {bubbles:true}));
  }, position);
  await setCaret(0);
  await expect(page.locator('.editor-source-wrap')).toHaveClass(/is-caret-visible/);
  const cueDocumentTop = () => page.locator('#note-content').evaluate(textarea => {
    const cue = document.querySelector('.editor-current-line');
    return parseFloat(getComputedStyle(cue).top) + textarea.scrollTop;
  });
  await expect.poll(cueDocumentTop).toBeLessThan(40);
  const firstRowTop = await cueDocumentTop();
  await setCaret(96);
  await expect.poll(cueDocumentTop).toBeGreaterThan(firstRowTop);
});

test('source caret cue stays on logical line starts, including blank lines', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const content = 'alpha\nbravo\n\ncharlie';
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();

  const lineStarts = [0, content.indexOf('bravo'), content.indexOf('\n\n') + 1, content.indexOf('charlie')];
  const measurements = [];
  for (const position of lineStarts) {
    await editor.evaluate((textarea, nextPosition) => {
      textarea.setSelectionRange(nextPosition, nextPosition);
      textarea.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
    }, position);
    await page.waitForTimeout(140);
    measurements.push(await editor.evaluate(textarea => {
      const cue = document.querySelector('.editor-current-line');
      return {
        top:parseFloat(getComputedStyle(cue).top) + textarea.scrollTop,
        lineHeight:parseFloat(getComputedStyle(textarea).lineHeight),
      };
    }));
  }
  const firstTop = measurements[0].top;
  const lineHeight = measurements[0].lineHeight;
  expect(measurements.map(measurement => measurement.top - firstTop)).toEqual([
    0,
    expect.closeTo(lineHeight, 1),
    expect.closeTo(lineHeight * 2, 1),
    expect.closeTo(lineHeight * 3, 1),
  ]);
});

test('source caret cue stays on the first character of a soft-wrapped row', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const content = 'wrapped '.repeat(80).trim();
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();

  const position = await editor.evaluate(textarea => {
    const computed = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const before = document.createTextNode('');
    const marker = document.createElement('span');
    const after = document.createTextNode(textarea.value);
    mirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;height:auto;overflow:visible;white-space:pre-wrap;';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.boxSizing = 'border-box';
    ['border', 'padding', 'font', 'letterSpacing', 'lineHeight', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textIndent', 'direction', 'unicodeBidi', 'wordSpacing']
      .forEach(property => { mirror.style[property] = computed[property]; });
    marker.textContent = '\u200b';
    mirror.append(before, marker, after);
    textarea.parentElement.append(mirror);
    const mirrorRect = mirror.getBoundingClientRect();
    let previousTop = marker.getBoundingClientRect().top - mirrorRect.top;
    let wrappedPosition = -1;
    for (let nextPosition = 1; nextPosition < textarea.value.length; nextPosition++) {
      before.data = textarea.value.slice(0, nextPosition);
      after.data = textarea.value.slice(nextPosition);
      const top = marker.getBoundingClientRect().top - mirrorRect.top;
      if (top > previousTop + 0.5 && textarea.value[nextPosition - 1] !== '\n') {
        wrappedPosition = nextPosition;
        break;
      }
      previousTop = top;
    }
    mirror.remove();
    return wrappedPosition;
  });
  expect(position).toBeGreaterThan(0);
  await editor.evaluate((textarea, nextPosition) => {
    textarea.setSelectionRange(nextPosition, nextPosition);
    textarea.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  }, position);
  await page.waitForTimeout(140);

  const {actualOffset, expectedOffset} = await editor.evaluate((textarea, nextPosition) => {
    const computed = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    mirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;height:auto;overflow:visible;white-space:pre-wrap;';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.boxSizing = 'border-box';
    ['border', 'padding', 'font', 'letterSpacing', 'lineHeight', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textIndent', 'direction', 'unicodeBidi', 'wordSpacing']
      .forEach(property => { mirror.style[property] = computed[property]; });
    mirror.append(document.createTextNode(textarea.value.slice(0, nextPosition)), marker, document.createTextNode(textarea.value.slice(nextPosition)));
    marker.textContent = '\u200b';
    textarea.parentElement.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const cue = document.querySelector('.editor-current-line');
    const wrapRect = document.querySelector('.editor-source-wrap').getBoundingClientRect();
    const actual = parseFloat(getComputedStyle(cue).top) + textarea.scrollTop;
    mirror.remove();
    return {actualOffset:actual - (textarea.getBoundingClientRect().top - wrapRect.top), expectedOffset:markerRect.top - mirrorRect.top};
  }, position);
  expect(actualOffset).toBeCloseTo(expectedOffset, 1);
});

test('source caret cue stays at the active end while text is selected', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const content = 'first line\nsecond line';
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();
  await editor.evaluate(textarea => {
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  });
  await page.waitForTimeout(140);
  const firstTop = await editor.evaluate(textarea => parseFloat(getComputedStyle(document.querySelector('.editor-current-line')).top) + textarea.scrollTop);
  await editor.evaluate(textarea => {
    textarea.focus({preventScroll:true});
    textarea.setSelectionRange(0, 'first line'.length + 1);
    textarea.dispatchEvent(new Event('select', {bubbles:true}));
  });
  await page.waitForTimeout(140);
  const lineHeight = await editor.evaluate(textarea => parseFloat(getComputedStyle(textarea).lineHeight));
  const top = await editor.evaluate(textarea => parseFloat(getComputedStyle(document.querySelector('.editor-current-line')).top) + textarea.scrollTop);
  expect(top - firstTop).toBeCloseTo(lineHeight, 1);
  expect(await page.locator('.editor-source-wrap')).toHaveClass(/is-caret-visible/);
  expect(lineHeight).toBeGreaterThan(0);
});

test('source caret cue follows a real ArrowUp movement', async ({page}) => {
  await signIn(page);
  await page.setViewportSize({width:1000, height:800});
  await page.locator('#new-note-btn').click();
  const content = [
    '2. [x] UI still feels slow to type on mobile',
    '',
    "1. [x] Markdown preview doesn't render for the first time when it's hidden by default, we need one render extra whenever we go from `hidden` -> `shown`",
    '---',
  ].join('\n') + '\n';
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();
  await editor.press('End');
  await editor.press('ArrowUp');
  await page.waitForTimeout(140);

  const state = await editor.evaluate(textarea => {
    const cue = document.querySelector('.editor-current-line');
    const wrap = document.querySelector('.editor-source-wrap');
    const textareaRect = textarea.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const computed = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    mirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;height:auto;overflow:visible;white-space:pre-wrap;';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.boxSizing = 'border-box';
    ['border', 'padding', 'font', 'letterSpacing', 'lineHeight', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textIndent', 'direction', 'unicodeBidi', 'wordSpacing']
      .forEach(property => { mirror.style[property] = computed[property]; });
    mirror.append(document.createTextNode(textarea.value.slice(0, textarea.selectionStart)), marker, document.createTextNode(textarea.value.slice(textarea.selectionStart)));
    marker.textContent = '\u200b';
    wrap.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const expectedOffset = markerRect.top - mirrorRect.top;
    mirror.remove();
    return {
      position:textarea.selectionStart,
      cueOffset:parseFloat(getComputedStyle(cue).top) + textarea.scrollTop - (textareaRect.top - wrapRect.top),
      expectedOffset,
      value:textarea.value,
    };
  });
  expect(state.position).toBe(state.value.length - 4);
  expect(state.value.slice(state.position, state.position + 3)).toBe('---');
  expect(state.cueOffset).toBeCloseTo(state.expectedOffset, 1);
});

test('editing from preview-only mode opens source at the selected block', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('# Heading\n\nA paragraph to edit.');
  await enableInteractivePreview(page);

  await page.locator('.panel-preview .panel-layout').click();
  await expect(page.locator('.panel-editor')).toBeHidden();
  const paragraphCard = page.locator('#preview .interactive-preview-block-card').filter({hasText:'A paragraph to edit.'});
  await paragraphCard.hover();
  await paragraphCard.getByRole('button', {name:'Edit this block in source'}).click();

  await expect(page.locator('.panel-editor')).toBeVisible();
  await expect(page.locator('.panel-preview')).toBeHidden();
  await expect(page.locator('#note-content')).toBeFocused();
  await expect(page.locator('.editor-source-wrap')).toHaveClass(/is-caret-visible/);
  const cue = await page.locator('.editor-current-line').boundingBox();
  const editor = await page.locator('#note-content').boundingBox();
  expect(cue).not.toBeNull();
  expect(editor).not.toBeNull();
  expect(cue.y).toBeGreaterThanOrEqual(editor.y);
  expect(cue.y).toBeLessThan(editor.y + editor.height);
  const position = await page.locator('#note-content').evaluate(textarea => textarea.selectionStart);
  expect(position).toBe('# Heading\n\n'.length);
});

test('updates a typed preview block without replacing its layout node', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const editor = page.locator('#note-content');
  await editor.fill('# Stable heading\n\nFirst paragraph.\n\nSecond paragraph.');
  await expect(page.locator('#preview p')).toHaveCount(2);

  await page.evaluate(() => {
    window.__typedPreviewBlockBefore = [...document.querySelectorAll('#preview p')]
      .find(element => element.textContent === 'First paragraph.');
  });
  await editor.evaluate(textarea => {
    const position = textarea.value.indexOf('First paragraph.') + 'First paragraph.'.length;
    textarea.focus();
    textarea.setSelectionRange(position, position);
  });
  await editor.type(' Updated');
  await expect(page.locator('#note-content')).toHaveValue(/First paragraph\. Updated/);
  await expect.poll(() => page.locator('#preview p').first().textContent()).toContain('First paragraph. Updated');
  expect(await page.evaluate(() => [...document.querySelectorAll('#preview p')]
    .find(element => element.textContent === 'First paragraph. Updated') === window.__typedPreviewBlockBefore)).toBe(true);
});

test('keeps the current preview highlight while typed Markdown is rendering', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const editor = page.locator('#note-content');
  await editor.fill('# Stable heading\n\nFirst paragraph.\n\nSecond paragraph.');
  await expect(page.locator('#preview p')).toHaveCount(2);
  await page.waitForTimeout(200);

  await editor.evaluate(textarea => {
    const position = textarea.value.indexOf('First paragraph.');
    textarea.focus();
    textarea.setSelectionRange(position, position);
    textarea.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  });
  const isFirstParagraphHighlighted = () => page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('#preview p')]
      .find(element => element.textContent === 'First paragraph.');
    return Boolean((paragraph?.closest('.interactive-preview-card') || paragraph)?.classList.contains('highlight'));
  });
  await expect.poll(isFirstParagraphHighlighted).toBe(true);
  await editor.type(' Updated');
  await page.waitForTimeout(100);

  expect(await isFirstParagraphHighlighted()).toBe(true);
});

test('centers a preview edit target within the source viewport', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const items = Array.from({length:40}, (_, index) => `- Item ${index + 1}`);
  await page.locator('#note-content').fill(items.join('\n'));
  await enableInteractivePreview(page);

  await page.locator('.panel-preview .panel-layout').click();
  const target = page.locator('#preview .interactive-preview-list-card').nth(19);
  await target.hover();
  await target.getByRole('button', {name:'Edit this block in source'}).click();

  await expect(page.locator('#note-content')).toBeFocused();
  await expect.poll(() => page.locator('#note-content').evaluate(textarea => textarea.scrollTop)).toBeGreaterThan(0);
  const scrollState = await page.locator('#note-content').evaluate(textarea => ({
    scrollTop: textarea.scrollTop,
    maxScrollTop: Math.max(0, textarea.scrollHeight - textarea.clientHeight),
  }));
  expect(scrollState.scrollTop).toBeLessThan(scrollState.maxScrollTop);
});

test('interactive preview preserves checkbox position and auto-scrolls during drag', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const items = Array.from({length:50}, (_, index) => index === 12 ? '- [ ] Toggle without jumping' : `- Item ${index + 1}`);
  await page.locator('#note-content').fill(items.join('\n'));
  await enableInteractivePreview(page);

  const checkbox = page.locator('#preview input[type="checkbox"]');
  await checkbox.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.__taskCheckboxBeforeToggle = document.querySelector('#preview input[type="checkbox"]');
    window.__taskItemBeforeToggle = window.__taskCheckboxBeforeToggle?.closest('li');
  });
  const scrollBeforeToggle = await page.locator('#preview').evaluate(element => element.scrollTop);
  await checkbox.click();
  await expect(page.locator('#note-content')).toHaveValue(new RegExp('- \\[x\\] Toggle without jumping'));
  expect(await page.evaluate(() => document.querySelector('#preview input[type="checkbox"]') === window.__taskCheckboxBeforeToggle)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('#preview input[type="checkbox"]')?.closest('li') === window.__taskItemBeforeToggle)).toBe(true);
  await expect.poll(() => page.locator('#preview').evaluate(element => element.scrollTop)).toBe(scrollBeforeToggle);
  await expect(page.locator('#toast-region .toast')).toHaveCount(0);

  await page.locator('#preview').evaluate(element => { element.scrollTop = 0; });
  const previewBounds = await page.locator('#preview').boundingBox();
  const handleBounds = await page.locator('#preview .preview-drag-handle').first().boundingBox();
  expect(previewBounds).not.toBeNull();
  expect(handleBounds).not.toBeNull();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height - 4, {steps:3});
  await expect.poll(() => page.locator('#preview').evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.mouse.move(previewBounds.x - 20, previewBounds.y + previewBounds.height / 2);
  await expect(page.locator('html')).toHaveClass(/preview-drag-outside/);
  await page.mouse.up();
  await expect(page.locator('html')).not.toHaveClass(/preview-drag-outside/);
});

test('loose ordered task lists render one checkbox per item', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('15. [ ] Keyboard thing\n\n16. [ ] Preference');
  await enableInteractivePreview(page);

  const items = page.locator('#preview > ol > li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('input[type="checkbox"]')).toHaveCount(1);
  await expect(items.nth(1).locator('input[type="checkbox"]')).toHaveCount(1);
});

test('keeps long interactive previews fully functional with bounded control DOM', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const sections = Array.from({length:240}, (_, index) => `## Section ${index + 1}\n\n- first item\n- second item\n\nParagraph ${index + 1}.`);
  await page.locator('#note-content').fill(sections.join('\n\n'));
  await enableInteractivePreview(page);

  const preview = page.locator('#preview');
  const cards = page.locator('#preview .interactive-preview-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeLessThan(100);

  await page.waitForTimeout(200);
  expect(await preview.evaluate(async element => {
    const firstHeading = element.querySelector('h2');
    const firstCard = element.querySelector('.interactive-preview-card');
    const editor = document.querySelector('#note-content');
    editor.value += '\n\nIncremental update marker';
    editor.dispatchEvent(new Event('input', {bubbles:true}));
    while (!element.textContent.includes('Incremental update marker')) await new Promise(requestAnimationFrame);
    const currentHeading = element.querySelector('h2');
    return {
      headingPreserved:firstHeading === currentHeading,
      cardPreserved:firstCard?.isConnected && firstCard === element.querySelector('.interactive-preview-card'),
    };
  })).toEqual({headingPreserved:true, cardPreserved:true});

  await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastParagraph = preview.getByText('Paragraph 240.', {exact:true});
  await expect(lastParagraph).toBeVisible();
  await expect(lastParagraph.locator('xpath=ancestor::*[contains(@class,"interactive-preview-card")]')).toHaveCount(1);
  expect(await cards.count()).toBeLessThan(140);
});

test('block dragging keeps its rendered preview and accepts cross-type drops', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('# Compact heading\n\nA short paragraph.\n\n1. [ ] First task\n2. Second item');
  await enableInteractivePreview(page);

  const preview = page.locator('#preview');
  const headingCard = preview.locator('.interactive-preview-block-card').first();
  const heading = headingCard.locator('h1');
  const headingBounds = await headingCard.boundingBox();
  const previewBounds = await preview.boundingBox();
  expect(headingBounds).not.toBeNull();
  expect(previewBounds).not.toBeNull();
  expect(headingBounds.width).toBeLessThan(previewBounds.width * .8);
  const originalFontSize = await heading.evaluate(element => getComputedStyle(element).fontSize);

  const orderedHandle = await preview.locator('.interactive-preview-list-card .preview-drag-handle').first().boundingBox();
  expect(orderedHandle).not.toBeNull();
  await page.mouse.move(orderedHandle.x + orderedHandle.width / 2, orderedHandle.y + orderedHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(orderedHandle.x + orderedHandle.width / 2 + 12, orderedHandle.y + orderedHandle.height / 2);
  await expect(page.locator('.preview-drag-ghost .preview-list-marker')).toHaveText('1.');
  await expect(page.locator('.preview-drag-ghost input[type="checkbox"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();

  const headingHandle = await headingCard.locator('.preview-drag-handle').boundingBox();
  const listTarget = await preview.locator('.interactive-preview-list-card').first().boundingBox();
  expect(headingHandle).not.toBeNull();
  expect(listTarget).not.toBeNull();
  await page.mouse.move(headingHandle.x + headingHandle.width / 2, headingHandle.y + headingHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(listTarget.x + listTarget.width / 2, listTarget.y + 2, {steps:3});
  await expect(page.locator('.preview-drag-ghost h1')).toHaveText('Compact heading');
  expect(await page.locator('.preview-drag-ghost h1').evaluate(element => getComputedStyle(element).fontSize)).toBe(originalFontSize);
  await page.mouse.up();

  const source = await page.locator('#note-content').inputValue();
  expect(source.indexOf('A short paragraph.')).toBeLessThan(source.indexOf('# Compact heading'));
  expect(source.indexOf('# Compact heading')).toBeLessThan(source.indexOf('1. [ ] First task'));
  await expect(preview.locator('ol .preview-list-marker').first()).toHaveText('1.');
});

test('interactive rules span the row and ordered markers never wrap', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('---\n\n13. [ ] A numbered task with enough text to wrap naturally');
  await enableInteractivePreview(page);

  const preview = page.locator('#preview');
  const previewBounds = await preview.boundingBox();
  const ruleCardBounds = await preview.locator('.interactive-preview-rule-card').boundingBox();
  const ruleBounds = await preview.locator('.interactive-preview-rule-card hr').boundingBox();
  const ruleHandleBounds = await preview.locator('.interactive-preview-rule-card .preview-drag-handle').boundingBox();
  expect(previewBounds).not.toBeNull();
  expect(ruleCardBounds).not.toBeNull();
  expect(ruleBounds).not.toBeNull();
  expect(ruleHandleBounds).not.toBeNull();
  expect(ruleCardBounds.width).toBeGreaterThan(previewBounds.width * .8);
  expect(ruleBounds.width).toBeGreaterThan(previewBounds.width * .65);
  const cardCenterY = ruleCardBounds.y + ruleCardBounds.height / 2;
  expect(Math.abs(ruleBounds.y + ruleBounds.height / 2 - cardCenterY)).toBeLessThanOrEqual(1);
  expect(Math.abs(ruleHandleBounds.y + ruleHandleBounds.height / 2 - cardCenterY)).toBeLessThanOrEqual(1);

  const marker = preview.locator('.preview-list-marker').first();
  await expect(marker).toHaveText('13.');
  expect(await marker.evaluate(element => ({height:element.clientHeight, lineHeight:parseFloat(getComputedStyle(element).lineHeight), wraps:element.scrollWidth > element.clientWidth}))).toMatchObject({wraps:false});
  const markerMetrics = await marker.evaluate(element => ({height:element.clientHeight, lineHeight:parseFloat(getComputedStyle(element).lineHeight)}));
  expect(markerMetrics.height).toBeLessThanOrEqual(Math.ceil(markerMetrics.lineHeight));
});
