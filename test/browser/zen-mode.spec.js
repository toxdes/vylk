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
  await page.locator('#prefs-tab-editor').click();
  await page.locator('#pref-zen-word-count').check();
  await page.locator('#prefs-close').click();
  await page.locator('[data-panel="zen"]').click();
  await expect(page.locator('#editor')).toHaveClass(/zen-mode/);
  await page.locator('#note-content').press('End');
  await page.locator('#note-content').press('!');
  await page.waitForTimeout(80);
}

test('Zen mode presents a page, overlays its controls, and keeps a long document scrollable', async ({page}) => {
  await page.setViewportSize({width:1440, height:960});
  await signIn(page);
  await openZenMode(page);

  const [pageBox, controlsBox, titleBox, metrics] = await Promise.all([
    page.locator('#editor-panel').boundingBox(),
    page.locator('.zen-controls').boundingBox(),
    page.locator('#zen-note-title').boundingBox(),
    page.locator('#note-content').evaluate(textarea => ({
      canScroll: textarea.scrollHeight > textarea.clientHeight,
      scrollTop: textarea.scrollTop,
      maxScrollTop: textarea.scrollHeight - textarea.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(textarea).lineHeight),
      scrollbarWidth: getComputedStyle(textarea).scrollbarWidth,
      width: textarea.getBoundingClientRect().width,
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
  expect(metrics.maxScrollTop - metrics.scrollTop).toBeGreaterThan(metrics.lineHeight * 3);
  expect(metrics.scrollbarWidth).toBe('none');
  expect(metrics.width).toBeGreaterThan(pageBox.width * .8);
  expect(metrics.wordCount).toMatch(/\d+ words/);

  await page.screenshot({path:'/tmp/vylk-zen-desktop.png'});
});

test('Zen mode preserves its writing page on a narrow screen', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await signIn(page);
  await openZenMode(page);
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('.zen-controls button')).toHaveCount(3);
  const [textareaBox, controlsBox, firstControlBox, titleBox, wordCountBox] = await Promise.all([
    page.locator('#note-content').boundingBox(),
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
