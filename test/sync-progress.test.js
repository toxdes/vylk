import {expect, test, vi} from 'vitest';

await import('../internal/web/static/js/sync/coordinator.js');
await import('../internal/web/static/js/sync/leadership.js');
await import('../internal/web/static/js/core/http.js');
await import('../internal/web/static/js/sync/pusher.js');
await import('../internal/web/static/js/sync/remote-notes.js');

function createCoordinator(overrides = {}) {
  const diagnostic = {detail: ''};
  const dependencies = {
    apiClient: {consumeCancellation: () => false},
    authenticationRequired: () => false,
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
    leadership: async (work) => {
      const result = await work();
      if (first) {
        coordinator.schedule({reconcile: true}, 0);
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

test.each(['Web Locks', 'IndexedDB lease'])(
  'waits between refused %s attempts, then syncs once the other tab releases ownership',
  async (mechanism) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    let coordinator;
    try {
      let heldByOtherTab = true;
      const state = new Map([
        [
          'syncLease',
          {key: 'syncLease', value: {owner: 'other-tab', expiresAt: Date.now() + 60_000}},
        ],
      ]);
      const window = {
        setTimeout: vi.fn((callback, delay) => setTimeout(callback, delay)),
        clearTimeout: (timer) => clearTimeout(timer),
        setInterval: (callback, delay) => setInterval(callback, delay),
        clearInterval: (timer) => clearInterval(timer),
      };
      const leadership = globalThis.VylkSyncLeadership.create({
        navigator:
          mechanism === 'Web Locks'
            ? {
                locks: {
                  request: async (_name, _options, work) => {
                    // Lock acquisition completes asynchronously in the browser. Keep
                    // that ordering deterministic without relying on elapsed real time.
                    await Promise.resolve();
                    return work(heldByOtherTab ? null : {});
                  },
                },
              }
            : {},
        onUnavailable: () => coordinator.schedule({}, 500),
        requestValue: async (request) => request,
        tabID: 'current-tab',
        window,
        withOfflineStore: async (_names, _mode, work) => {
          await Promise.resolve();
          return work({
            state: {
              get: (key) => state.get(key),
              put: (record) => state.set(record.key, record),
              delete: (key) => state.delete(key),
            },
          });
        },
      });
      const acquire = vi.fn(leadership.run);
      const pull = vi.fn(async () => {});
      const reconcileLocal = vi.fn(async () => {});
      ({coordinator} = createCoordinator({
        leadership: acquire,
        pull,
        reconcileLocal,
        serverWorkRemains: () => false,
        window,
      }));

      await expect(coordinator.now({reconcile: true})).resolves.toBe(false);
      for (let attempts = 1; attempts <= 3; attempts++) {
        expect(acquire).toHaveBeenCalledTimes(attempts);
        expect(vi.getTimerCount()).toBe(1);
        // Fail immediately on a zero-delay retry, before advancing a fake clock
        // through that loop. The regression cannot hang or exhaust timer limits.
        expect(window.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 500);
        await vi.advanceTimersByTimeAsync(499);
        expect(acquire).toHaveBeenCalledTimes(attempts);
        await vi.advanceTimersByTimeAsync(1);
        expect(acquire).toHaveBeenCalledTimes(attempts + 1);
        expect(pull).not.toHaveBeenCalled();
      }

      heldByOtherTab = false;
      state.delete('syncLease');
      await vi.advanceTimersByTimeAsync(499);
      expect(acquire).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      await coordinator.waitForIdle();
      expect(acquire).toHaveBeenCalledTimes(5);
      expect(pull).toHaveBeenCalledOnce();
      expect(reconcileLocal).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      coordinator?.cancelScheduled();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test('keeps delayed work when immediate requests overlap, then clears the consumed delay', async () => {
  vi.useFakeTimers();
  let coordinator;
  try {
    let completed = 0;
    const window = {
      setTimeout: vi.fn((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const pull = vi.fn(async () => {});
    const reconcileLocal = vi.fn(async () => {});
    ({coordinator} = createCoordinator({
      pull,
      reconcileLocal,
      serverWorkRemains: () => false,
      window,
      leadership: async (work) => {
        const result = await work();
        if (++completed === 1) {
          coordinator.schedule({reconcile: true}, 500);
          coordinator.schedule({}, 0);
        } else if (completed === 2) {
          coordinator.schedule({}, 0);
        }
        return result;
      },
    }));

    await coordinator.now();
    expect(window.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 500);
    await vi.advanceTimersByTimeAsync(499);
    expect(pull).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(window.setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([500, 0]);
    expect(pull).toHaveBeenCalledTimes(3);
    expect(reconcileLocal).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    coordinator?.cancelScheduled();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('canceling pending work also clears its delay before a new immediate request', async () => {
  vi.useFakeTimers();
  let coordinator;
  try {
    let completed = 0;
    const window = {
      setTimeout: vi.fn((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const pull = vi.fn(async () => {});
    ({coordinator} = createCoordinator({
      pull,
      serverWorkRemains: () => false,
      window,
      leadership: async (work) => {
        const result = await work();
        if (++completed === 1) {
          coordinator.schedule({}, 500);
          coordinator.cancelScheduled();
          coordinator.schedule({}, 0);
        }
        return result;
      },
    }));

    await coordinator.now();
    expect(window.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 0);
    await vi.runAllTimersAsync();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    coordinator?.cancelScheduled();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
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

test('does not repair sequences or discard edits when a push reaches a replacement database', async () => {
  const repairSequenceGap = vi.fn();
  const quarantine = vi.fn();
  const applyAcknowledgement = vi.fn();
  const flush = globalThis.VylkSyncPusher.create({
    APIError: globalThis.VylkHTTP.APIError,
    apiErrorFromPayload: globalThis.VylkHTTP.errorFromPayload,
    getDeviceID: async () => 'device-a',
    getInstanceID: async () => 'original',
    claimBatch: async () => [{op_id: 'edit-1', client_sequence: 1, type: 'noop'}],
    serialize: (item) => item,
    repairSequenceGap,
    quarantine,
    applyAcknowledgement,
    syncFetch: async (_path, options) => {
      expect(options.headers['X-Vylk-Instance-ID']).toBe('original');
      return {
        response: {status: 409, ok: false},
        data: {
          error: 'The server database changed',
          code: 'server_instance_changed',
          expected_sequence: 1,
        },
      };
    },
  });
  await expect(flush()).rejects.toMatchObject({
    code: 'server_instance_changed',
    responseStatus: 409,
  });
  expect(repairSequenceGap).not.toHaveBeenCalled();
  expect(quarantine).not.toHaveBeenCalled();
  expect(applyAcknowledgement).not.toHaveBeenCalled();
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
