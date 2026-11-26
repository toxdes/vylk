import {expect, test} from './server-fixture.js';
import {useEditorFixture} from './editor-fixture.js';

test('opposite container insets remain equal across sizes and scrollbars', async ({page}) => {
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  const results = [];
  const inspect = async (profile) => {
    const measurements = await page.evaluate(() => {
      const pairs = [];
      const pair = (name, first, second) =>
        pairs.push({name, first, second, error: Math.abs(first - second)});
      for (const element of document.querySelectorAll(
        '.prefs-modal-body, .prefs-sidebar, .prefs-content, .prefs-content-header, .prefs-section.active, .prefs-nav, .pref-control, .pref-row, .font-control select, .modal:not(.hidden) > .modal-body',
      )) {
        if (!element.getClientRects().length) continue;
        const css = getComputedStyle(element);
        const name = element.id || element.className;
        pair(`${name}: padding inline`, parseFloat(css.paddingLeft), parseFloat(css.paddingRight));
        pair(`${name}: padding block`, parseFloat(css.paddingTop), parseFloat(css.paddingBottom));
      }
      const content = document.querySelector('.prefs-content');
      const box = content.getBoundingClientRect();
      const heading = content.querySelector('.prefs-content-header');
      const head = heading.getBoundingClientRect();
      const css = getComputedStyle(heading);
      pair(
        'Preferences effective inline inset',
        head.left + heading.clientLeft + parseFloat(css.paddingLeft) - box.left,
        box.right -
          head.left -
          heading.clientLeft -
          heading.clientWidth +
          parseFloat(css.paddingRight),
      );
      const modal = document.querySelector('.prefs-modal-body').getBoundingClientRect();
      pair('Preferences viewport centering', modal.left, innerWidth - modal.right);
      const dialog = document.querySelector('#restore-defaults-modal .modal-body');
      if (dialog.getClientRects().length) {
        const frame = dialog.getBoundingClientRect();
        const row = dialog.querySelector('.modal-heading').getBoundingClientRect();
        pair('Dialog effective inline inset', row.left - frame.left, frame.right - row.right);
      }
      return pairs;
    });
    results.push({profile, measurements});
  };
  // Insets are theme-independent; the narrowest and widest layouts at the size extremes bound them.
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.locator('#prefs-btn').click();
    for (const size of [0.8, 1, 1.5]) {
      await page.locator('#pref-font-size').selectOption(`${size}rem`);
      await expect
        .poll(() =>
          page
            .locator('body')
            .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        )
        .toBeCloseTo(size * 16, 1);
      await page.evaluate(() => {
        document.documentElement.dataset.reduceMotion = 'always';
        document.querySelector('#restore-defaults-modal').classList.remove('hidden');
      });
      await inspect(`${width}-${size}`);
      await page.evaluate(() =>
        document.querySelector('#restore-defaults-modal').classList.add('hidden'),
      );
    }
    await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
  }
  expect(
    results.flatMap(({profile, measurements}) =>
      measurements
        .filter((item) => item.error > 1)
        .map((item) => `${profile}: ${item.name} (${item.first}, ${item.second})`),
    ),
  ).toEqual([]);
});
