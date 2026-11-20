import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {expect, test} from '@playwright/test';
import {useEditorFixture} from './editor-fixture.js';

const destination = process.env.VYLK_SYMMETRY_OUTPUT || path.join(tmpdir(), 'vylk-symmetry');

test('opposite container insets remain equal across themes, sizes, and scrollbars', async ({
  page,
}) => {
  test.setTimeout(180000);
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
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.locator('#prefs-btn').click();
    for (const theme of ['default-light', 'default-dark']) {
      await page.locator('#prefs-tab-appearance').click();
      await page.locator('#pref-theme').selectOption(theme);
      for (const size of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
        await page.locator('#pref-font-size').selectOption(`${size}rem`);
        await expect
          .poll(() =>
            page
              .locator('body')
              .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
          )
          .toBeCloseTo(size * 16, 1);
        const profile = `${width}-${size}-${theme}`;
        await page.evaluate(() => {
          document.documentElement.dataset.reduceMotion = 'always';
          document.querySelector('#restore-defaults-modal').classList.remove('hidden');
        });
        await inspect(profile);
        await page.evaluate(() =>
          document.querySelector('#restore-defaults-modal').classList.add('hidden'),
        );
        if (size === 1 && width !== 768) {
          const folder = path.join(destination, profile);
          mkdirSync(folder, {recursive: true});
          for (const section of ['appearance', 'editor', 'account']) {
            await page.locator(`#prefs-tab-${section}`).click();
            await page.locator('.prefs-content').evaluate((element) => {
              element.scrollTop = 0;
            });
            await page.screenshot({path: path.join(folder, `preferences-${section}.png`)});
          }
          await page.evaluate(() =>
            document.querySelector('#restore-defaults-modal').classList.remove('hidden'),
          );
          await page.screenshot({path: path.join(folder, 'restore-defaults-modal.png')});
          await page.evaluate(() =>
            document.querySelector('#restore-defaults-modal').classList.add('hidden'),
          );
          await page.locator('#prefs-tab-appearance').click();
        }
      }
    }
    await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
  }
  mkdirSync(destination, {recursive: true});
  writeFileSync(path.join(destination, 'measurements.json'), JSON.stringify(results));
  expect(
    results.flatMap(({profile, measurements}) =>
      measurements
        .filter((item) => item.error > 1)
        .map((item) => `${profile}: ${item.name} (${item.first}, ${item.second})`),
    ),
  ).toEqual([]);
});
