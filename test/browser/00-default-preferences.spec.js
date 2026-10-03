import {expect, test} from '@playwright/test';

test('fresh accounts open in write view with the requested editor and Zen defaults', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  const response = await page.request.get('/api/prefs');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    startView: 'editor',
    hideToolbar: false,
    hideSaveButton: true,
    interactivePreview: true,
    zenFontFamily: 'Inter',
    zenFontFamilyGoogle: true,
    zenFontSize: '1.25rem',
    zenWordCount: true,
    zenShowTitle: true,
    zenShowControls: true,
    shortcutPrefix: {steps: [{key: 'e', modifiers: ['Mod']}]},
  });
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor-panel')).toBeVisible();
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('#save-btn')).toBeHidden();
  await expect(page.getByRole('toolbar', {name: 'Formatting'})).toBeVisible();
  await page.locator('[data-panel="zen"]').click();
  await expect(page.locator('#zen-word-count')).toBeVisible();
  await expect(page.locator('#zen-source-editor')).toHaveCSS('font-size', '20px');
  await expect(page.locator('#zen-source-editor')).toHaveCSS('font-family', /Inter/);
});
