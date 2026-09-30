import {afterEach, expect, test, vi} from 'vitest';

await import('../internal/web/static/js/ui/feedback.js');

afterEach(() => vi.useRealTimers());

function serviceWorker(revision = 'old') {
  const worker = new EventTarget();
  worker.controller = {scriptURL: `https://vylk.test/sw.js?revision=${revision}`};
  return worker;
}

test('waits for the requested worker rather than merely completing registration', async () => {
  const worker = serviceWorker();
  const complete = vi.fn();
  const waiting = globalThis.VylkFeedback.waitForRevisionController(worker, 'new').then(complete);
  worker.dispatchEvent(new Event('controllerchange'));
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  worker.controller.scriptURL = 'https://vylk.test/sw.js?revision=new';
  worker.dispatchEvent(new Event('controllerchange'));
  await waiting;
  expect(complete).toHaveBeenCalledOnce();
});

test('allows an already controlling update and fails safely when installation stalls', async () => {
  vi.useFakeTimers();
  const worker = serviceWorker('new');
  await expect(
    globalThis.VylkFeedback.waitForRevisionController(worker, 'new'),
  ).resolves.toBeUndefined();
  const stalled = globalThis.VylkFeedback.waitForRevisionController(worker, 'next', 100);
  const rejected = expect(stalled).rejects.toThrow('update is not ready');
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
