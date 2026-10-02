import {expect, test, vi} from 'vitest';

await import('../internal/web/static/js/sync/coordinator.js');

test('does not schedule or enter sync while access is paused or revoked', async () => {
  const leadership = vi.fn();
  const coordinator = globalThis.VylkSyncCoordinator.create({canSync: () => false, leadership});
  coordinator.schedule();
  await expect(coordinator.now()).resolves.toBe(false);
  expect(leadership).not.toHaveBeenCalled();
  expect(coordinator.scheduleState()).toEqual({scheduled: false, options: {}});
});
