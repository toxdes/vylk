import {describe, expect, test, vi} from 'vitest';
import {createApp, response} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('F-04 service worker revisions', () => {
  test('does not register a provisional legacy revision before the server revision is known', async () => {
    const register = vi.fn(async () => {});
    track(await createApp({serviceWorker: {register}}));

    expect(register).not.toHaveBeenCalled();
  });

  test('registers the worker with the server-provided frontend revision', async () => {
    const register = vi.fn(async () => {});
    const app = track(await createApp({serviceWorker: {register}}));
    register.mockClear();

    app.hooks.registerServiceWorker('frontend-hash-123');
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith('/sw.js?revision=frontend-hash-123', {
      updateViaCache: 'none',
    });
  });
});

describe('startup responsiveness', () => {
  test('shows a cached note before a slow server check completes', async () => {
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
    await app.hooks.putLocalNote({
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Cached note',
      tags: '',
      content: 'Available immediately',
      revision: 1,
      pending: false,
    });
    app.window.history.replaceState({}, '', '/note-a');

    const startup = app.hooks.init();
    await checkStarted;

    expect(app.window.document.querySelector('#app').classList.contains('booting')).toBe(false);
    expect(app.window.document.querySelector('#editor').classList.contains('hidden')).toBe(false);
    expect(app.window.document.querySelector('#note-title').value).toBe('Cached note');

    releaseCheck();
    await startup;
  });
});

describe('remote deletion coordination', () => {
  test('preserves a note while a local operation is pending', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local edit',
      content: 'Keep me',
      pending: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', content: 'Keep me'},
    });

    expect(await app.hooks.applyRemoteDeletion('note-a')).toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      title: 'Local edit',
      content: 'Keep me',
    });
  });
});

describe('permanent queue rejection recovery', () => {
  test('quarantines a rejected head operation and replays its sequence as a noop', async () => {
    let pushCount = 0;
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          pushCount++;
          if (pushCount === 1) {
            return response(
              400,
              JSON.stringify({
                error: 'invalid note save operation',
                code: 'invalid_sync_operation',
                permanent: true,
                op_id: operation.op_id,
              }),
            );
          }
          if (pushCount === 2) {
            expect(request.operations).toHaveLength(1);
            expect(operation.type).toBe('note.save');
            return response(
              400,
              JSON.stringify({
                error: 'invalid note save operation',
                permanent: true,
                op_id: operation.op_id,
              }),
            );
          }
          if (pushCount === 3) expect(operation.type).toBe('noop');
          else expect(operation.type).toBe('note.save');
          return response(
            200,
            JSON.stringify({
              acknowledged: [
                {
                  client_sequence: operation.client_sequence,
                  op_id: operation.op_id,
                  status: 'applied',
                  revision: pushCount === 3 ? undefined : 1,
                },
              ],
              expected_sequence: operation.client_sequence + 1,
            }),
          );
        },
      }),
    );
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Too large',
      content: 'Keep locally',
      pending: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Too large', content: 'Keep locally'},
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-b',
      base_revision: 0,
      note: {id: 'note-b', title: 'Later note', content: 'Continue syncing'},
    });

    expect(await app.hooks.flushPendingChanges()).toBe(true);
    expect(pushCount).toBe(4);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('rejectedSync:note-a')).toMatchObject({
      type: 'note.save',
    });
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pending: true,
      content: 'Keep locally',
    });
  });
});

describe('batched queue flushing', () => {
  test('keeps the conflict base local when syncing a large edited note', async () => {
    let pushBody = '';
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
          pushBody = options.body;
          const request = JSON.parse(pushBody);
          const operation = request.operations[0];
          return response(
            200,
            JSON.stringify({
              acknowledged: [
                {
                  client_sequence: operation.client_sequence,
                  op_id: operation.op_id,
                  status: 'applied',
                  revision: 2,
                },
              ],
              expected_sequence: operation.client_sequence + 1,
            }),
          );
        },
      }),
    );
    const baseContent = 'a'.repeat(3_310_106);
    const content = `${baseContent.slice(0, -1)}b`;
    await app.hooks.putLocalNote({
      id: 'large-note',
      title: 'Large note',
      tags: '',
      content,
      revision: 1,
      pending: true,
      base_revision: 1,
      base_content: baseContent,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'large-note',
      base_revision: 1,
      note: {
        id: 'large-note',
        title: 'Large note',
        tags: '',
        content,
        base_revision: 1,
        base_content: baseContent,
      },
    });

    const queued = (await app.hooks.pendingOperations())[0];
    expect(queued.note.base_content).toBe(baseContent);
    await app.hooks.flushPendingChanges();

    const sent = JSON.parse(pushBody).operations[0];
    expect(new TextEncoder().encode(pushBody).byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(sent.content).toBe(content);
    expect(sent).not.toHaveProperty('base_content');
  });

  test('sends ordered pending operations in one bounded push', async () => {
    const requests = [];
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
          const request = JSON.parse(options.body);
          requests.push(request);
          return response(
            200,
            JSON.stringify({
              acknowledged: request.operations.map((operation, index) => ({
                client_sequence: operation.client_sequence,
                op_id: operation.op_id,
                status: 'applied',
                revision: index + 1,
              })),
              expected_sequence: request.operations.at(-1).client_sequence + 1,
            }),
          );
        },
      }),
    );
    for (const [index, id] of ['note-a', 'note-b', 'note-c'].entries()) {
      await app.hooks.queueOperation({
        type: 'note.save',
        note_id: id,
        base_revision: 0,
        note: {id, title: `Note ${index}`, content: `Content ${index}`},
      });
    }

    await app.hooks.flushPendingChanges();
    expect(requests).toHaveLength(1);
    expect(requests[0].operations.map((operation) => operation.note_id)).toEqual([
      'note-a',
      'note-b',
      'note-c',
    ]);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });
});

describe('batched remote application', () => {
  test('applies a change page and cursor in one logical local update', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Old', content: 'Old content', revision: 1});
    await app.hooks.putLocalNote({
      id: 'note-b',
      title: 'Delete me',
      content: 'Remove',
      revision: 1,
    });
    const remote = {id: 'note-a', title: 'New', tags: 'work', content: 'New content', revision: 2};

    await app.hooks.applyRemoteChangePage(
      [
        {note_id: 'note-a', deleted: false},
        {note_id: 'note-b', deleted: true},
      ],
      new Map([['note-a', remote]]),
      42,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({...remote, pending: false});
    expect(await app.hooks.getLocalNote('note-b')).toBeUndefined();
    expect(await app.hooks.getOfflineState('syncSequence')).toBe(42);
  });
});

describe('sync request lifecycle', () => {
  test('tracks and cancels a pull-style request through the shared manager', async () => {
    let markStarted;
    let release;
    let signal;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          signal = options.signal;
          markStarted();
          await gate;
          return response(200, '{}');
        },
      }),
    );
    const request = app.hooks.api('/api/sync?since=0', {syncRequest: true});
    await started;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('syncing');
    app.hooks.cancelActiveSyncRequests();
    expect(signal.aborted).toBe(true);
    release();
    await request;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('online');
  });
});

describe('preference sync coordination', () => {
  test('syncs every Google font fetch switch as preference patches', async () => {
    const app = track(await createApp());

    for (const selector of [
      '#pref-font-google',
      '#pref-editor-font-google',
      '#pref-preview-font-google',
      '#pref-zen-font-google',
    ]) {
      const fetchFonts = app.window.document.querySelector(selector);
      fetchFonts.checked = true;
      fetchFonts.dispatchEvent(new app.window.Event('change'));
      expect(fetchFonts.checked).toBe(true);
    }
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({
      fontFamilyGoogle: true,
      editorFontFamilyGoogle: true,
      previewFontFamilyGoogle: true,
      zenFontFamilyGoogle: true,
    });
  });

  test('restores Google font fetch switches from remote preferences', async () => {
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path) === '/api/prefs')
            return response(
              200,
              JSON.stringify({
                revision: 2,
                autoSave: true,
                fontFamily: 'Inter',
                fontFamilyGoogle: true,
                editorFontFamily: 'system-monospace',
                editorFontFamilyGoogle: false,
                previewFontFamily: 'system-sans',
                previewFontFamilyGoogle: false,
              }),
            );
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );

    const head = app.window.document.head;
    const append = head.append.bind(head);
    head.append = (...nodes) => {
      append(...nodes);
      nodes
        .filter((node) => node.rel === 'stylesheet')
        .forEach((node) => setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0));
    };
    app.window.document.fonts.load = async () => [{}];
    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    await app.hooks.loadPrefs();
    expect(fetchFonts.checked).toBe(true);
  });

  test('restores and normalizes global and Zen width preferences independently', async () => {
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path) === '/api/prefs')
            return response(
              200,
              JSON.stringify({
                revision: 2,
                autoSave: true,
                contentWidth: 'full',
                zenPageWidth: 'compact',
              }),
            );
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );

    await app.hooks.loadPrefs();
    expect(app.window.document.documentElement.dataset.contentWidth).toBe('full');
    expect(app.window.document.documentElement.dataset.zenPageWidth).toBe('compact');

    app.window.fetch = async (path) => {
      if (String(path) === '/api/prefs')
        return response(
          200,
          JSON.stringify({
            revision: 3,
            autoSave: true,
            contentWidth: 'not-a-width',
            zenPageWidth: 'also-not-a-width',
          }),
        );
      throw new Error(`unexpected request: ${path}`);
    };
    await app.hooks.loadPrefs();
    expect(app.window.document.documentElement.dataset.contentWidth).toBe('standard');
    expect(app.window.document.documentElement.dataset.zenPageWidth).toBe('standard');
  });

  test('restores font sizes from remote preferences and defaults missing sizes', async () => {
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path) === '/api/prefs')
            return response(
              200,
              JSON.stringify({
                revision: 2,
                autoSave: true,
                fontSize: '1.1rem',
                editorFontSize: 'bad-size',
                previewFontSize: '3rem',
              }),
            );
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );

    await app.hooks.loadPrefs();
    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font-size')).toBe('1.1rem');
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('1rem');
    expect(root.style.getPropertyValue('--preview-font-size')).toBe('1rem');
  });

  test('coalesces preference changes into field-level patches', async () => {
    const app = track(await createApp());

    await app.hooks.savePref('theme', 'default-dark');
    await app.hooks.savePref('accentColor', '#123456');
    await app.hooks.savePref('saveButtonLocation', 'header');
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].base_revision).toBe(1);
    expect(pending[0].prefs._sync_patch).toEqual({
      theme: 'default-dark',
      accentColor: '#123456',
      saveButtonLocation: 'header',
    });
    expect(pending[0].prefs._sync_base).toEqual({
      theme: 'default-light',
      accentColor: '',
      saveButtonLocation: 'panel',
    });
  });

  test('surfaces same-field preference conflicts and keeps the remote value', async () => {
    const remote = {
      revision: 2,
      autoSave: true,
      startView: 'split',
      hideToolbar: false,
      collapseDetails: false,
      hideCursorHighlight: false,
      theme: 'solarized-dark',
      accentColor: '',
      fontFamily: 'system-sans',
      editorFontFamily: 'system-monospace',
      previewFontFamily: 'system-sans',
    };
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) === '/api/sync/push') {
            const request = JSON.parse(options.body);
            const operation = request.operations[0];
            return response(
              200,
              JSON.stringify({
                acknowledged: [
                  {
                    client_sequence: operation.client_sequence,
                    op_id: operation.op_id,
                    status: 'conflict',
                    current_revision: 2,
                  },
                ],
                expected_sequence: operation.client_sequence + 1,
              }),
            );
          }
          if (String(path) === '/api/prefs') return response(200, JSON.stringify(remote));
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    app.window.console.error = () => {};
    await app.hooks.savePref('theme', 'default-dark');
    app.hooks.cancelScheduledSync();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('vylk-prefs'))).toMatchObject({
      theme: 'solarized-dark',
      revision: 2,
    });
    expect(app.window.document.querySelector('#toast-region').textContent).toContain(
      'Some preferences changed on another device',
    );
  });
});

describe('deep-link restoration', () => {
  test('fetches an uncached deep-linked note before declaring it missing', async () => {
    const remote = {
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Remote note',
      tags: 'work',
      content: 'Loaded directly',
      revision: 4,
    };
    const app = track(
      await createApp({
        fetchImpl: async (path) => {
          if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    app.window.history.replaceState({}, '', '/note-a');

    await app.hooks.restoreRoute({fetchRemote: true});

    expect(app.window.location.pathname).toBe('/note-a');
    expect(app.window.document.querySelector('#note-title').value).toBe('Remote note');
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject(remote);
  });
});

describe('logout storage cleanup', () => {
  test('waits for other database connections before reporting cleanup complete', async () => {
    const first = track(await createApp());
    const originalIndexedDB = first.window.indexedDB;
    let deleteRequest;
    Object.defineProperty(first.window, 'indexedDB', {
      configurable: true,
      value: {
        deleteDatabase: () => {
          deleteRequest = {};
          setTimeout(() => deleteRequest.onblocked?.(), 0);
          return deleteRequest;
        },
      },
    });

    let completed = false;
    const cleanup = first.hooks.clearOfflineData().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);

    deleteRequest.onsuccess();
    await cleanup;
    expect(completed).toBe(true);
    Object.defineProperty(first.window, 'indexedDB', {
      configurable: true,
      value: originalIndexedDB,
    });
  });
});
