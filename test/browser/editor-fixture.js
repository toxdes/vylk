import {expect} from '@playwright/test';

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
