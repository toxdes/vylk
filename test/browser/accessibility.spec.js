import AxeBuilder from '@axe-core/playwright';
import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('dashboard and preferences have no serious accessibility violations', async ({page}) => {
  await signIn(page);

  const dashboardResults = await new AxeBuilder({page}).include('#dashboard').analyze();
  expect(
    dashboardResults.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);

  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-modal .modal-body').evaluate(async (modal) => {
    await Promise.all(modal.getAnimations().map((animation) => animation.finished));
  });
  const preferencesResults = await new AxeBuilder({page}).include('#prefs-modal').analyze();
  expect(
    preferencesResults.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);
});

test('preferences use a modal with a nested encryption dialog', async ({page}) => {
  await signIn(page);

  await page.locator('#prefs-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page.locator('#prefs-title')).toBeFocused();

  await page.locator('#prefs-tab-appearance').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#prefs-tab-editor')).toBeFocused();
  await expect(page.locator('#prefs-tab-editor')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/preferences\/editor$/);

  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-setup').click();
  await expect(page).toHaveURL(/\/preferences\/encryption\/setup$/);
  await expect(page.locator('#vault-setup-modal')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#prefs-modal')).toHaveAttribute('inert', '');
  await expect(page.locator('#vault-setup-modal')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#prefs-modal .prefs-content-header #prefs-close')).toBeVisible();
  await expect(page.locator('#prefs-modal #prefs-btn')).toHaveCount(0);
  await expect(page.locator('#prefs-title')).toHaveText('Encryption');
  await page.keyboard.press('Escape');
  await expect(page.locator('#vault-setup-modal')).toBeHidden();
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#vault-open-setup')).toBeFocused();
  await expect(page).toHaveURL(/\/preferences\/encryption$/);

  await page.keyboard.press('Escape');
  await expect(page.locator('#prefs-modal')).toBeHidden();
  await expect(page.locator('#prefs-btn')).toBeFocused();
});

test('dashboard note actions are reachable as native controls', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#note-title').fill('Keyboard note');
  await page.locator('#note-content').fill('Keyboard content');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteID = new URL(page.url()).pathname.slice(1);
  await page.locator('#back-btn').click();

  const note = page.locator(`.note-item[data-id="${noteID}"]`);
  await expect(note).toHaveAttribute('type', 'button');
  await note.focus();
  await expect(note).toBeFocused();
  await page
    .locator('#tag-bar .tag')
    .first()
    .evaluate((button) => button.click());
  await expect(note).toBeFocused();
  await note.press('Enter');
  await expect(page.locator('#editor')).toBeVisible();
});
