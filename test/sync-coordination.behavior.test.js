import {describe, expect, test, vi} from 'vitest';
import {createApp, response} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('typed API outcomes', () => {
  test('preserves server status, stable code, and retry policy', async () => {
    const app = track(
      await createApp({
        fetchImpl: async () =>
          response(409, JSON.stringify({error: 'note changed', code: 'note_revision_conflict'})),
      }),
    );
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/notes/note-a')).rejects.toMatchObject({
      kind: 'http',
      responseStatus: 409,
      code: 'note_revision_conflict',
      retryable: false,
    });
  });

  test('classifies transport failures separately from HTTP errors', async () => {
    const app = track(
      await createApp({
        fetchImpl: async () => {
          throw new TypeError('network unavailable');
        },
      }),
    );
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/check')).rejects.toMatchObject({
      kind: 'network',
      responseStatus: 0,
      retryable: true,
    });
  });
});

describe('sync scheduling while hidden', () => {
  test('keeps pending sync work dormant until the tab becomes visible', async () => {
    const requests = [];
    const app = track(
      await createApp({
        fetchImpl: async (url) => {
          requests.push(url);
          const path = String(url);
          if (path.includes('/api/sync'))
            return response(200, {changes: [], nextSequence: 0, hasMore: false});
          if (path.endsWith('/api/notes')) return response(200, []);
          return response(200, {});
        },
      }),
    );
    const setVisibility = (value) =>
      Object.defineProperty(app.window.document, 'visibilityState', {value, configurable: true});

    setVisibility('hidden');
    app.hooks.scheduleSync({reconcile: true});
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(requests).toHaveLength(0);
    expect(app.hooks.getSyncScheduleState()).toEqual({
      scheduled: false,
      options: {reconcile: true},
    });

    setVisibility('visible');
    app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(requests.some((url) => String(url).includes('/api/sync'))).toBe(true);
  });
});

describe('server change invalidation', () => {
  test('resets the sync cursor when the server database instance changes', async () => {
    const requests = [];
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          requests.push(String(path));
          if (String(path).startsWith('/api/sync?'))
            return response(200, {
              changes: [],
              nextSequence: 42,
              hasMore: false,
              instance_id: 'new-database-instance',
            });
          if (String(path) === '/api/notes') return response(200, []);
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );

    await app.hooks.applyRemoteChangePage([], new Map(), 42);
    await expect(app.hooks.syncNow()).resolves.toBe(true);
    expect(requests).toContain('/api/sync?since=42&limit=100');
    await expect(app.hooks.getOfflineState('syncSequence')).resolves.toBe(0);
  });

  test('refreshes preferences without scheduling an unrelated note sync', async () => {
    const requests = [];
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          requests.push(String(path));
          if (String(path) === '/api/prefs')
            return response(200, {revision: 2, theme: 'default-light'});
          if (String(path).startsWith('/api/sync?'))
            return response(200, {changes: [], nextSequence: 0, hasMore: false});
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    await expect(
      app.hooks.handleServerChangeEvent({type: 'preferences', revision: 2}),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(requests.filter((path) => path === '/api/prefs')).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(requests.some((path) => path.startsWith('/api/sync?'))).toBe(false);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});
  });

  test('ignores a note event already covered by the local sync cursor', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    await app.hooks.applyRemoteChangePage([], new Map(), 42);

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 42})).resolves.toBe(
      false,
    );
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 43})).resolves.toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    app.hooks.cancelScheduledSync();
  });

  test('pulls again when a newer note event arrives during sync completion', async () => {
    let pullRequests = 0;
    const app = track(
      await createApp({
        deferredSyncCompletion: true,
        fetchImpl: async (path) => {
          if (!String(path).startsWith('/api/sync?'))
            throw new Error(`unexpected request: ${path}`);
          pullRequests++;
          return response(200, {
            changes: [],
            nextSequence: pullRequests > 1 ? 1 : 0,
            hasMore: false,
          });
        },
      }),
    );
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    const sync = app.hooks.syncNow();
    await app.syncCompletionStarted;
    await app.hooks.handleServerChangeEvent({type: 'notes', sequence: 1});
    app.releaseSyncCompletion();
    await sync;

    await vi.waitFor(() => expect(pullRequests).toBe(2));
  });
});

describe('sync coordinator', () => {
  test('reports a durable queued edit as saved but waiting to sync', async () => {
    const app = track(await createApp());
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'local edit',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    await app.hooks.saveCurrentNote(false);
    await vi.waitFor(() => {
      const status = app.window.document.querySelector('#editor-status');
      expect(status).toMatchObject({
        dataset: expect.objectContaining({state: 'local'}),
        title: 'Saved on this device; waiting to sync',
      });
      expect(status.querySelector('.sync-indicator-label').textContent).toBe('Saved');
      expect(status.getAttribute('aria-label')).toBe('Saved on this device; waiting to sync');
    });
  });

  test('does not run a redundant follow-up for requests made during an idle sync', async () => {
    let markSyncStarted;
    let releaseSync;
    const syncStarted = new Promise((resolve) => {
      markSyncStarted = resolve;
    });
    const syncGate = new Promise((resolve) => {
      releaseSync = resolve;
    });
    let syncRequests = 0;
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path).startsWith('/api/sync?')) {
            syncRequests++;
            if (syncRequests === 1) {
              markSyncStarted();
              await syncGate;
            }
            return response(200, {changes: [], nextSequence: 0, hasMore: false});
          }
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    const sync = app.hooks.syncNow();
    await syncStarted;
    app.hooks.scheduleSync();
    app.hooks.scheduleSync();
    releaseSync();
    await sync;
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(syncRequests).toBe(1);
  });

  test('keeps one logical syncing state across pull, push, and final pull', async () => {
    let markPushStarted;
    let releasePush;
    const pushStarted = new Promise((resolve) => {
      markPushStarted = resolve;
    });
    const pushGate = new Promise((resolve) => {
      releasePush = resolve;
    });
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          const value = String(path);
          if (value.startsWith('/api/sync?'))
            return response(200, {changes: [], nextSequence: 0, hasMore: false});
          if (value === '/api/sync/push') {
            const request = JSON.parse(options.body);
            markPushStarted();
            await pushGate;
            return response(200, {
              acknowledged: request.operations.map((operation) => ({
                client_sequence: operation.client_sequence,
                op_id: operation.op_id,
                status: 'applied',
                revision: 1,
              })),
              expected_sequence: request.operations.at(-1).client_sequence + 1,
            });
          }
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Note',
      tags: '',
      content: 'body',
      revision: 0,
      pending: true,
      base_revision: 0,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 0,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'body', revision: 0},
    });

    const states = [];
    const status = app.window.document.querySelector('#sync-status');
    const observer = new app.window.MutationObserver(() => states.push(status.dataset.state));
    observer.observe(status, {attributes: true, subtree: true, childList: true});
    const sync = app.hooks.syncNow();
    await pushStarted;
    await new Promise((resolve) => setTimeout(resolve, 180));
    releasePush();
    await sync;
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    expect(states.filter((state, index) => index === 0 || state !== states[index - 1])).toEqual([
      'syncing',
      'online',
    ]);
  });

  test('flushes a local edit made during sync without starting an empty extra cycle', async () => {
    let markFirstPushStarted;
    let releaseFirstPush;
    const firstPushStarted = new Promise((resolve) => {
      markFirstPushStarted = resolve;
    });
    const firstPushGate = new Promise((resolve) => {
      releaseFirstPush = resolve;
    });
    let app;
    let pullRequests = 0;
    let pushRequests = 0;
    const fetchImpl = async (path, options) => {
      const value = String(path);
      if (value.startsWith('/api/sync?')) {
        pullRequests++;
        return response(200, {changes: [], nextSequence: 0, hasMore: false});
      }
      if (value === '/api/sync/push') {
        pushRequests++;
        const request = JSON.parse(options.body);
        if (pushRequests === 1) {
          markFirstPushStarted();
          await firstPushGate;
        }
        return response(200, {
          acknowledged: request.operations.map((operation) => ({
            client_sequence: operation.client_sequence,
            op_id: operation.op_id,
            status: 'applied',
            revision: 1,
          })),
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        });
      }
      throw new Error(`unexpected request: ${path}`);
    };
    app = track(await createApp({fetchImpl}));
    Object.defineProperty(app.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    const first = {id: 'note-a', title: 'Note', tags: '', content: 'first', revision: 0};
    await app.hooks.putLocalNote({...first, pending: true, base_revision: 0});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: first.id,
      base_revision: 0,
      note: first,
    });

    const sync = app.hooks.syncNow();
    await firstPushStarted;
    const second = {...first, content: 'second', pending: true, base_revision: 0};
    await app.hooks.putLocalNote(second);
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: second.id,
      base_revision: 0,
      note: second,
    });
    app.hooks.scheduleSync();
    releaseFirstPush();
    await sync;
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(pushRequests).toBe(2);
    expect(pullRequests).toBe(2);
  });

  test('shows a loading state instead of a final empty state during initial hydration', async () => {
    let markCheckStarted;
    let releaseCheck;
    const checkStarted = new Promise((resolve) => {
      markCheckStarted = resolve;
    });
    const checkGate = new Promise((resolve) => {
      releaseCheck = resolve;
    });
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path) === '/api/check') {
            markCheckStarted();
            await checkGate;
            return response(503, 'offline');
          }
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    app.window.console.error = () => {};

    const startup = app.hooks.init();
    await checkStarted;
    expect(app.window.document.querySelector('#note-list').textContent).toContain('Loading notes');
    releaseCheck();
    await startup;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
