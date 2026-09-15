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

test('interactive preview preserves checkbox position and auto-scrolls during drag', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const items = Array.from({length:50}, (_, index) => index === 12 ? '- [ ] Toggle without jumping' : `- Item ${index + 1}`);
  await page.locator('#note-content').fill(items.join('\n'));
  await enableInteractivePreview(page);

  const checkbox = page.locator('#preview input[type="checkbox"]');
  await checkbox.scrollIntoViewIfNeeded();
  const scrollBeforeToggle = await page.locator('#preview').evaluate(element => element.scrollTop);
  await checkbox.click();
  await expect(page.locator('#note-content')).toHaveValue(new RegExp('- \\[x\\] Toggle without jumping'));
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
