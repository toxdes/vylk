import {expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./motion.js');

test('motion choices follow the system or explicitly override it', () => {
  for (const systemReduced of [false, true]) {
    const browser = {matchMedia: () => ({matches: systemReduced})};
    const document = {documentElement: {dataset: {}}};
    expect(globalThis.VylkMotion.reduced(document, browser)).toBe(systemReduced);
    for (const [preference, expected] of [
      ['system', systemReduced],
      ['always', true],
      ['never', false],
    ]) {
      document.documentElement.dataset.reduceMotion = preference;
      expect(globalThis.VylkMotion.reduced(document, browser)).toBe(expected);
    }
  }
});

test('popup exits release their timer and can be interrupted without stale inert state', () => {
  const dom = new JSDOM('<div class="hidden"></div>');
  const element = dom.window.document.querySelector('div');
  const timers = new Map();
  const browser = {
    setTimeout: (callback) => {
      timers.set(1, callback);
      return 1;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const popups = globalThis.VylkMotion.createPopups(dom.window.document, browser);
  popups.show(element);
  popups.hide(element);
  expect(element.hasAttribute('inert')).toBe(true);
  popups.show(element);
  expect(element.className).toBe('');
  expect(element.hasAttribute('inert')).toBe(false);
  expect(timers.size).toBe(0);
  popups.hide(element);
  timers.get(1)();
  expect(element.className).toBe('hidden');
  expect(timers.size).toBe(0);
  dom.window.close();
});
