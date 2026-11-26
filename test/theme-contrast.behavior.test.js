import {describe, expect, test} from 'vitest';
import {createApp} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

function contrast(first, second) {
  const luminance = (hex) => {
    const channel = (offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const expand = (hex) =>
    hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [light, dark] = [luminance(expand(first)), luminance(expand(second))].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe('theme contrast', () => {
  test('text on every filled colour meets WCAG AA in every theme and custom accent', async () => {
    const app = track(await createApp());
    const root = app.window.document.documentElement;
    const failures = [];
    const check = (label) => {
      for (const fill of ['accent', 'danger', 'offline', 'syncing']) {
        const background = root.style.getPropertyValue(`--${fill}`).trim();
        const ink = root.style.getPropertyValue(`--on-${fill}`).trim();
        if (contrast(background, ink) < 4.5)
          failures.push(`${label} ${fill}: ${ink} on ${background}`);
      }
    };
    for (const theme of app.window.VylkThemes) {
      await app.hooks.savePref('theme', theme.id);
      check(theme.id);
    }
    await app.hooks.savePref('theme', 'default-dark');
    await app.hooks.savePref('accentColor', '#ffd84d');
    check('custom accent');
    expect(failures).toEqual([]);
  });
});
