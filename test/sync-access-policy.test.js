import {expect, test, vi} from 'vitest';

await import('../internal/web/static/js/sync/coordinator.js');

test('does not schedule or enter sync while access is paused or revoked', async () => {
  const leadership = vi.fn();
  const setTimeout = vi.fn();
  const coordinator = globalThis.VylkSyncCoordinator.create({
    canSync: () => false,
    leadership,
    window: {setTimeout},
  });
  coordinator.schedule();
  await expect(coordinator.now()).resolves.toBe(false);
  expect(leadership).not.toHaveBeenCalled();
  expect(setTimeout).not.toHaveBeenCalled();
});
