import {expect, test, vi} from 'vitest';

await import('../internal/web/static/js/sync/coordinator.js');
await import('../internal/web/static/js/core/http.js');
await import('../internal/web/static/js/sync/pusher.js');
await import('../internal/web/static/js/sync/remote-notes.js');

function createCoordinator(overrides = {}) {
  const diagnostic = {detail: ''};
  const dependencies = {
    apiClient: {consumeCancellation: () => false},
    authenticationRequired: () => false,
    beforeCompletion: async () => {},
    clearDiagnostic: () => {},
    connectEvents: () => {},
    document: {visibilityState: 'visible'},
    feedback: {getDiagnostic: () => diagnostic, cancelStatusPresentation: () => {}},
    finishStatus: vi.fn(),
    flush: async () => false,
    getCursor: async () => 0,
    getHydrationState: () => 'ready',
    getPendingOperations: async () => [],
    hideOfflineNotice: () => {},
    isDashboardVisible: () => false,
    isEditorVisible: () => false,
    leadership: (work) => work(),
    localStorage: {setItem: () => {}},
    notifyCompleted: () => {},
    onOffline: vi.fn(),
    pull: async () => {},
    serverEventsConnected: () => true,
    serverWorkRemains: () => true,
    setDiagnostic: (detail) => {
      diagnostic.detail = detail;
    },
    setHydrationState: () => {},
    showToast: vi.fn(),
    startStatus: () => {},
    window: {setTimeout: vi.fn(() => 1), clearTimeout: vi.fn()},
    ...overrides,
  };
  return {dependencies, coordinator: globalThis.VylkSyncCoordinator.create(dependencies)};
}

test('pauses a non-advancing reset/event loop and requires an explicit retry', async () => {
  let pulls = 0;
  let remaining = true;
  const {coordinator, dependencies} = createCoordinator({
    serverWorkRemains: () => remaining,
    pull: async () => {
      if (++pulls > 5) throw new Error('test guard: an infinite sync loop');
    },
  });
  await expect(coordinator.now()).resolves.toBe(false);
  expect(pulls).toBe(2);
  expect(dependencies.showToast).toHaveBeenCalledWith(expect.stringContaining('paused'), 'warning');
  expect(dependencies.onOffline).not.toHaveBeenCalled();
  coordinator.schedule();
  await expect(coordinator.now()).resolves.toBe(false);
  expect(pulls).toBe(2);
  expect(dependencies.window.setTimeout).not.toHaveBeenCalled();
  remaining = false;
  await expect(coordinator.now({retryPaused: true})).resolves.toBe(true);
  expect(pulls).toBe(3);
});

test('allows long sync histories while the cursor keeps advancing', async () => {
  let cursor = 0;
  const {coordinator} = createCoordinator({
    pull: async () => {
      cursor++;
    },
    getCursor: async () => cursor,
    serverWorkRemains: () => cursor < 25,
  });
  await expect(coordinator.now()).resolves.toBe(true);
  expect(cursor).toBe(25);
});

test('coalesces requests while leadership is being acquired and retains their intent', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const leadership = vi.fn(async (work) => {
    await gate;
    return work();
  });
  const reconcileLocal = vi.fn(async () => {});
  const {coordinator} = createCoordinator({
    leadership,
    reconcileLocal,
    serverWorkRemains: () => false,
  });
  const first = coordinator.now();
  const second = coordinator.now({reconcile: true});
  const attempts = leadership.mock.calls.length;
  release();
  await Promise.all([first, second]);
  await coordinator.waitForIdle();
  expect(attempts).toBe(1);
  expect(reconcileLocal).toHaveBeenCalledOnce();
});

test('retains follow-up work until leadership cleanup finishes', async () => {
  let release;
  let completed;
  const cleanupGate = new Promise((resolve) => {
    release = resolve;
  });
  const workCompleted = new Promise((resolve) => {
    completed = resolve;
  });
  const timers = [];
  const reconcileLocal = vi.fn(async () => {});
  let first = true;
  const {coordinator} = createCoordinator({
    serverWorkRemains: () => false,
    reconcileLocal,
    window: {
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    },
    beforeCompletion: async () => {
      if (first) coordinator.schedule({reconcile: true}, 0);
    },
    leadership: async (work) => {
      const result = await work();
      if (first) {
        first = false;
        completed();
        await cleanupGate;
      }
      return result;
    },
  });
  const initial = coordinator.now();
  await workCompleted;
  // Execute any prematurely scheduled timer while the leadership lease is held.
  if (timers.length) await timers.shift()();
  release();
  await initial;
  expect(timers).toHaveLength(1);
  await timers.shift()();
  await coordinator.waitForIdle();
  expect(reconcileLocal).toHaveBeenCalledOnce();
  expect(timers).toHaveLength(0);
});

test.each([409, 200])('bounds repeated identical push batches after HTTP %s', async (status) => {
  let requests = 0;
  const operation = {op_id: 'edit-1', client_sequence: 1, type: 'note.save', base_revision: 0};
  const flush = globalThis.VylkSyncPusher.create({
    APIError: globalThis.VylkHTTP.APIError,
    claimBatch: async () => [operation],
    getDeviceID: async () => 'device-a',
    serialize: (item) => item,
    repairSequenceGap: async () => true,
    showToast: () => {},
    applyAcknowledgement: async () => {},
    syncFetch: async () => {
      if (++requests > 5) throw new Error('test guard: an infinite push loop');
      return {
        response: {status, ok: status === 200},
        data: {
          expected_sequence: 1,
          acknowledged: [{op_id: operation.op_id, status: 'applied', revision: 1}],
        },
      };
    },
  });
  await expect(flush()).rejects.toMatchObject({code: 'sync_no_progress'});
  expect(requests).toBe(2);
});

test.each([0, -1, 'invalid'])(
  'rejects a non-advancing download cursor %s',
  async (nextSequence) => {
    let requests = 0;
    const remote = globalThis.VylkRemoteNotes.create({
      api: async () => {
        requests++;
        return {changes: [], nextSequence, hasMore: true};
      },
      getOfflineState: async () => 0,
      handleServerIdentity: async () => false,
      requestValue: async (value) => value,
      withOfflineStore: async (_names, _mode, work) =>
        work({
          queue: {getAll: () => []},
          state: {getAll: () => []},
        }),
    });
    await expect(remote.pull()).rejects.toMatchObject({code: 'sync_no_progress'});
    expect(requests).toBe(1);
  },
);
