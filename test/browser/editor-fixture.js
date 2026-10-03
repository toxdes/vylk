import {expect} from '@playwright/test';

export async function waitForEditorEntrance(page) {
  // Geometry must be measured after the entrance scale releases its transform.
  // Await actual completion rather than assuming a particular frame rate.
  await page.locator('#editor .editor-body').evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
}

// Geometry and interaction tests deliberately use split view and local fonts.
// First-run defaults are tested separately, without these saved preferences.
export async function useEditorFixture(page) {
  const response = await page.request.get('/api/prefs');
  expect(response.ok()).toBe(true);
  const preferences = await response.json();
  const saved = await page.request.patch('/api/prefs', {
    headers: {'If-Match': String(preferences.revision)},
    data: {
      ...preferences,
      startView: 'split',
      reduceMotion: 'system',
      hideSaveButton: false,
      interactivePreview: false,
      zenFontFamily: 'system-monospace',
      zenFontFamilyGoogle: false,
      zenFontSize: '1rem',
      zenWordCount: false,
    },
  });
  expect(saved.ok()).toBe(true);
  const current = await page.request.get('/api/prefs');
  expect(current.ok()).toBe(true);
  // Cached startup can display the dashboard before its remote refresh finishes.
  // Seed the same saved settings so the first interaction cannot race that fetch.
  await page.evaluate(
    (value) => {
      localStorage.setItem('vylk-prefs', JSON.stringify(value));
    },
    await current.json(),
  );
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
}
