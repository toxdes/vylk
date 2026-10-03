import {expect, test} from '@playwright/test';
import {useEditorFixture} from './editor-fixture.js';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
}

test('direct view shortcuts follow the editor button order', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  for (const [key, panel] of [
    ['2', 'preview'],
    ['3', 'both'],
    ['4', 'zen'],
    ['1', 'editor'],
  ]) {
    await page.keyboard.press(`Control+${key}`);
    await expect(page.locator(`.view-control[data-panel="${panel}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(page.locator('#editor')).not.toHaveClass(/zen-mode/);
  await expect(page.locator('#editor-panel')).toBeVisible();
  await expect(page.locator('#preview-panel')).toBeHidden();
});

test('note deletion uses the shared confirmation dialog', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Note to delete');
  await page.locator('#note-content').fill('Delete only after confirmation');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);

  await page.locator('#delete-btn').click();
  await expect(page.locator('#delete-note-modal')).toBeVisible();
  await expect(page.locator('#delete-note-modal .modal-body')).toHaveCSS(
    'animation-name',
    'app-content-in',
  );
  await page.locator('#delete-note-cancel').click();
  await expect(page.locator('#delete-note-modal')).toBeHidden();
  await expect(page.locator('#note-title')).toHaveValue('Note to delete');

  await page.locator('#delete-btn').click();
  await page.locator('#delete-note-confirm').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.note-item').filter({hasText: 'Note to delete'})).toHaveCount(0);
});

test('in-app Back does not leave a stale note in browser history', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('History test note');
  await page.locator('#note-content').fill('History test content');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteID = new URL(page.url()).pathname.slice(1);
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#dashboard .dashboard-body')).toHaveCSS(
    'animation-name',
    'app-content-return',
  );

  await page.locator(`.note-item[data-id="${noteID}"]`).click();
  await expect(page.locator('#editor')).toBeVisible();
  const noteURL = page.url();
  await page.locator('#back-btn').evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() => page.evaluate(() => history.state))
    .toMatchObject({app: 'vylk', screen: 'dashboard'});

  await page.goBack();
  expect(page.url()).not.toBe(noteURL);
});

test('browser Back saves the current note before returning to the dashboard', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Browser Back save test');
  await page.locator('#note-content').fill('Saved before browser navigation');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();

  await page.locator('#note-content').fill('Saved before browser navigation and Back');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#dashboard .dashboard-body')).toHaveCSS(
    'animation-name',
    'app-content-return',
  );

  await page
    .locator(`.note-item[data-id="${noteURL.slice(noteURL.lastIndexOf('/') + 1)}"]`)
    .click();
  await expect(page).toHaveURL(noteURL);
  await expect(page.locator('#note-content')).toHaveValue(
    'Saved before browser navigation and Back',
  );
});

test('direct note URLs get one dashboard history parent', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Deep link history test');
  await page.locator('#note-content').fill('Deep link content');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.goto(noteURL);
  await expect(page.locator('#editor')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#dashboard')).toBeVisible();
});

test('editor preferences are available after Save', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Editor preferences test');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);

  const editorActions = page.locator('#editor header .header-right button');
  await expect(editorActions).toHaveCount(1);
  await expect(page.locator('#editor-panel #save-btn')).toBeVisible();
  await expect(page.locator('#editor-prefs-btn')).toBeVisible();
  await page.locator('#editor-prefs-btn').click();
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('browser Back closes Preferences and restores the note', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Preferences history test');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();

  await page.locator('#editor-prefs-btn').click();
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page).toHaveURL(/\/preferences$/);

  await page.goBack();
  await expect(page).toHaveURL(noteURL);
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toBeHidden();

  await page.goForward();
  await expect(page).toHaveURL(/\/preferences$/);
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('closing note Preferences leaves one Back step to the dashboard', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Preferences close history test');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);

  await page.locator('#editor-prefs-btn').click();
  await expect(page).toHaveURL(/\/preferences$/);
  await page.locator('#prefs-close').click();
  await expect(page).not.toHaveURL(/\/preferences$/);

  await page.locator('#back-btn').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#dashboard')).toBeVisible();
});

test('closing Preferences from an unsaved note returns to that note', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('A note in progress');
  await page.locator('#editor-prefs-btn').click();
  await expect(page).toHaveURL(/\/preferences$/);
  await page.locator('#prefs-tab-editor').click();
  await page.locator('#prefs-close').click();
  await expect(page.locator('#prefs-modal')).toBeHidden();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#note-content')).toHaveValue('A note in progress');
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
});

test('direct Preferences section URL opens the selected section', async ({page}) => {
  await signIn(page);
  await page.goto('/preferences/encryption');
  await expect(page).toHaveURL(/\/preferences\/encryption$/);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page.locator('#prefs-title')).toHaveText('Encryption');
  await expect(page.locator('#prefs-tab-encryption')).toHaveAttribute('aria-selected', 'true');
});

test('browser history moves between Preferences and its encryption dialog', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-setup').click();
  await expect(page).toHaveURL(/\/preferences\/encryption\/setup$/);
  await expect(page.locator('#vault-setup-modal')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/preferences\/encryption$/);
  await expect(page.locator('#vault-setup-modal')).toBeHidden();
  await expect(page.locator('#prefs-modal')).toBeVisible();

  await page.goForward();
  await expect(page.locator('#vault-setup-modal')).toBeVisible();
  await page.locator('#vault-setup-cancel').click();
  await expect(page).toHaveURL(/\/preferences\/encryption$/);
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('direct encryption dialog URL returns to Preferences on close', async ({page}) => {
  await signIn(page);
  await page.goto('/preferences/encryption/setup');
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page.locator('#vault-setup-modal')).toBeVisible();
  await page.locator('#vault-setup-cancel').click();
  await expect(page.locator('#vault-setup-modal')).toBeHidden();
  await expect(page).toHaveURL(/\/preferences\/encryption$/);
  await expect(page.locator('#prefs-modal')).toBeVisible();
});
