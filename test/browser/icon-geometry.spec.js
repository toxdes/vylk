import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {expect, test} from '@playwright/test';
import {useEditorFixture} from './editor-fixture.js';

const phase = process.env.VYLK_ICON_PHASE || 'after';
const destination = process.env.VYLK_ICON_OUTPUT || path.join(tmpdir(), 'vylk-icons');

test('icon roles scale consistently and controls center canonical artwork and share dialog action bounds', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  const results = [];
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const theme of ['default-light', 'default-dark']) {
      for (const size of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
        await page.evaluate(
          ({theme, size}) => {
            const root = document.documentElement;
            const choice = window.VylkThemes.find((item) => item.id === theme);
            root.classList.toggle('dark', choice.dark);
            for (const [key, value] of Object.entries(choice.vars))
              root.style.setProperty(
                `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                value,
              );
            root.style.setProperty('--font-size', `${size}rem`);
            root.dataset.reduceMotion = 'always';
          },
          {theme, size},
        );
        const measurements = await page.evaluate((requestedSize) => {
          const base = parseFloat(getComputedStyle(document.body).fontSize);
          const checks = [];
          const check = (name, actual, expected) =>
            checks.push({name, actual, expected, error: Math.abs(actual - expected)});
          check(
            'configured interface font',
            base,
            requestedSize * parseFloat(getComputedStyle(document.documentElement).fontSize),
          );
          for (const selector of [
            '.fmt-bar .icon',
            '.label-input__toggle .icon',
            '.shortcut-clear .icon',
          ]) {
            for (const icon of document.querySelectorAll(selector))
              check(
                `${selector}: compact size`,
                parseFloat(getComputedStyle(icon).width),
                base * 0.75,
              );
          }
          for (const icon of document.querySelectorAll(
            '.modal-close .icon, .header-right > .prefs-btn .icon, .back-chevron, .zen-controls .icon',
          ))
            check('regular control size', parseFloat(getComputedStyle(icon).width), base * 0.875);
          for (const icon of document.querySelectorAll('.vault-status-icon'))
            check('status size', parseFloat(getComputedStyle(icon).width), base);
          for (const icon of document.querySelectorAll('.icon')) {
            const css = getComputedStyle(icon);
            check('square icon frame', parseFloat(css.width), parseFloat(css.height));
            check('shared outline stroke', parseFloat(css.strokeWidth), 2);
          }
          for (const button of document.querySelectorAll('.header-right > .prefs-btn')) {
            if (!button.getClientRects().length) continue;
            const frame = button.getBoundingClientRect();
            const icon = button.querySelector('.icon').getBoundingClientRect();
            check(
              'settings icon centered horizontally',
              (icon.left + icon.right) / 2,
              (frame.left + frame.right) / 2,
            );
            check(
              'settings icon centered vertically',
              (icon.top + icon.bottom) / 2,
              (frame.top + frame.bottom) / 2,
            );
            const css = getComputedStyle(button);
            check(
              'settings symmetric inline padding',
              parseFloat(css.paddingLeft),
              parseFloat(css.paddingRight),
            );
            check(
              'settings symmetric block padding',
              parseFloat(css.paddingTop),
              parseFloat(css.paddingBottom),
            );
          }
          for (const modal of document.querySelectorAll('.modal:not(#prefs-modal)')) {
            const wasHidden = modal.classList.contains('hidden');
            modal.classList.remove('hidden');
            const icon = modal.querySelector('.modal-close .icon');
            const actions = [...modal.querySelectorAll('.modal-actions button')].filter(
              (button) => button.getClientRects().length,
            );
            if (icon && actions.length) {
              const box = icon.getBoundingClientRect();
              const button = icon.closest('button').getBoundingClientRect();
              check(
                `${modal.id}: icon centered horizontally`,
                (box.left + box.right) / 2,
                (button.left + button.right) / 2,
              );
              check(
                `${modal.id}: icon centered vertically`,
                (box.top + box.bottom) / 2,
                (button.top + button.bottom) / 2,
              );
              check(
                `${modal.id}: close / final action bounds`,
                button.right,
                actions.at(-1).getBoundingClientRect().right,
              );
            }
            if (wasHidden) modal.classList.add('hidden');
          }
          return checks;
        }, size);
        results.push({width, theme, size, measurements});
        if ([390, 1440].includes(width) && [1, 1.5].includes(size)) {
          const folder = path.join(destination, phase, `${width}-${size}-${theme}`);
          mkdirSync(folder, {recursive: true});
          await page.evaluate(() =>
            document.querySelector('#restore-defaults-modal').classList.remove('hidden'),
          );
          await page.screenshot({path: path.join(folder, 'confirmation.png')});
          await page.evaluate(() =>
            document.querySelector('#restore-defaults-modal').classList.add('hidden'),
          );
        }
      }
    }
  }
  mkdirSync(path.join(destination, phase), {recursive: true});
  writeFileSync(path.join(destination, phase, 'measurements.json'), JSON.stringify(results));
  if (phase !== 'before')
    expect(
      results.flatMap((profile) =>
        profile.measurements
          .filter((check) => check.error > 0.5)
          .map(
            (check) =>
              `${profile.width}/${profile.size}/${profile.theme}: ${check.name}: ${check.actual} vs ${check.expected}`,
          ),
      ),
    ).toEqual([]);
});
