import {expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./motion.js');

function pendingAnimation(endTime = 140) {
  let resolve;
  const finished = new Promise((done) => {
    resolve = done;
  });
  return {currentTime: 0, effect: {getComputedTiming: () => ({endTime})}, finished, resolve};
}

function fakeTimers() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimeout: (callback, delay) => {
      timers.set(++next, {callback, delay});
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
  };
}

test('exit completion waits for both surface and backdrop and ignores infinite indicators', async () => {
  const body = pendingAnimation();
  const backdrop = pendingAnimation(180);
  const spinner = pendingAnimation(Infinity);
  const browser = fakeTimers();
  let completions = 0;
  globalThis.VylkMotion.afterExit(
    {getAnimations: () => [body, backdrop, spinner]},
    browser,
    () => completions++,
  );
  expect([...browser.timers.values()][0].delay).toBe(230);
  body.resolve();
  await Promise.resolve();
  expect(completions).toBe(0);
  backdrop.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completions).toBe(1);
  expect(browser.timers.size).toBe(0);
});

test('interrupted exits release the fallback and ignore late completion', async () => {
  const animation = pendingAnimation();
  const browser = fakeTimers();
  let completions = 0;
  const cancel = globalThis.VylkMotion.afterExit(
    {getAnimations: () => [animation]},
    browser,
    () => completions++,
  );
  cancel();
  expect(browser.timers.size).toBe(0);
  animation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completions).toBe(0);
});

test('the bounded fallback finishes an exit when animation completion stalls', async () => {
  const animation = pendingAnimation(5000);
  const browser = fakeTimers();
  let completions = 0;
  globalThis.VylkMotion.afterExit({getAnimations: () => [animation]}, browser, () => completions++);
  const timer = [...browser.timers.values()][0];
  expect(timer.delay).toBe(1000);
  timer.callback();
  expect(completions).toBe(1);
  expect(browser.timers.size).toBe(0);
  animation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completions).toBe(1);
});

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
