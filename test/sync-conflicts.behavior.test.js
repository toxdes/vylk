import {describe, expect, test, vi} from 'vitest';
import {createApp, response} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('F-01 editor save coordination', () => {
  test('returns to the dashboard with one Back after closing note preferences', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({
      id: 'note-a',
      revision: 1,
      title: 'Note',
      tags: '',
      content: 'saved version',
    });
    app.window.history.replaceState({app: 'vylk', screen: 'dashboard'}, '', '/');
    app.window.history.pushState({app: 'vylk', screen: 'note', noteID: 'note-a'}, '', '/note-a');

    app.window.document.querySelector('#editor-prefs-btn').click();
    expect(app.window.location.pathname).toBe('/preferences');
    app.window.document.querySelector('#prefs-close').click();
    await vi.waitFor(() => expect(app.window.location.pathname).toBe('/note-a'));

    app.window.document.querySelector('#back-btn').click();
    await vi.waitFor(() => {
      expect(app.window.location.pathname).toBe('/');
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(
        false,
      );
    });
  });

  test('returns to the dashboard without waiting for an in-flight network sync', async () => {
    let resolvePushStarted;
    let releasePush;
    const pushStarted = new Promise((resolve) => {
      resolvePushStarted = resolve;
    });
    const pushGate = new Promise((resolve) => {
      releasePush = resolve;
    });
    const app = track(
      await createApp({
        fetchImpl: async (path, options = {}) => {
          const url = String(path);
          if (url.startsWith('/api/sync?')) {
            return response(200, {changes: [], nextSequence: 0, hasMore: false});
          }
          if (url === '/api/sync/push') {
            resolvePushStarted();
            await pushGate;
            const payload = JSON.parse(options.body);
            return response(200, {
              acknowledged: payload.operations.map((operation) => ({
                op_id: operation.op_id,
                status: 'applied',
                revision: 1,
              })),
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      }),
    );
    app.hooks.showNoteInEditor({
      id: 'note-a',
      revision: 0,
      title: 'Note',
      tags: '',
      content: 'saved version',
    });
    app.window.history.replaceState({app: 'vylk', screen: 'dashboard'}, '', '/');
    app.window.history.pushState({app: 'vylk', screen: 'note', noteID: 'note-a'}, '', '/note-a');
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'new version',
      savedSnapshot: {title: 'Note', tags: '', content: 'saved version'},
    });

    const save = app.hooks.saveCurrentNote();
    await pushStarted;
    app.window.document.querySelector('#back-btn').click();

    let navigationError;
    try {
      await vi.waitFor(
        () => {
          expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(
            false,
          );
          expect(app.window.location.pathname).toBe('/');
        },
        {timeout: 250},
      );
    } catch (error) {
      navigationError = error;
    } finally {
      releasePush();
      await save;
    }

    await vi.waitFor(() => {
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(
        false,
      );
      expect(app.window.location.pathname).toBe('/');
    });
    expect(navigationError).toBeUndefined();
  });

  test('drains an edit made while the previous local save is in flight', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;

    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    const secondSave = app.hooks.saveCurrentNote(false);
    expect(secondSave).toBe(firstSave);

    app.releaseFirstSave();
    await firstSave;

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[0].note.content).toBe('first version');
    expect(app.saveCalls[1].note.content).toBe('newest version');
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-a',
      isDirty: false,
      savedSnapshot: {content: 'newest version'},
    });
  });

  test('does not let an old save completion mutate a newly opened note', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'old content',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const save = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.hooks.showNoteInEditor({
      id: 'note-b',
      revision: 4,
      title: 'New note',
      tags: '',
      content: 'new content',
    });
    app.releaseFirstSave();
    await save;

    expect(app.saveCalls).toHaveLength(1);
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-b',
      currentRevision: 4,
      isDirty: false,
      savedSnapshot: {title: 'New note', content: 'new content'},
    });
  });

  test('drains the latest snapshot before exposing the new-note action', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      revision: 1,
      title: 'Old note',
      tags: '',
      content: 'saved version',
    });
    app.window.history.replaceState({}, '', '/note-a');
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    app.hooks.saveCurrentNote(false);

    app.window.document.querySelector('#back-btn').click();
    expect(
      app.window.document
        .querySelector('#new-note-btn')
        .closest('#dashboard')
        .classList.contains('hidden'),
    ).toBe(true);
    app.releaseFirstSave();
    await firstSave;
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(
        false,
      );
      expect(app.window.location.pathname).toBe('/');
    });

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[1]).toMatchObject({
      note: {id: 'note-a', content: 'newest version'},
      operation: {note_id: 'note-a'},
    });

    app.window.document.querySelector('#new-note-btn').click();
    expect(app.hooks.getState().currentNoteId).not.toBe('note-a');
  });
});

describe('F-02 immutable queue operations', () => {
  test('appends a new identity after an operation has been attempted', async () => {
    const app = track(await createApp());
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'first'},
    });
    const first = (await app.hooks.pendingOperations())[0];
    const attempted = await app.hooks.claimQueueOperation(first.id);

    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'second'},
    });

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      id: first.id,
      op_id: first.op_id,
      attempted_at: expect.any(String),
    });
    expect(pending[0].note.content).toBe('first');
    expect(pending[1].note.content).toBe('second');
    expect(pending[1].op_id).not.toBe(first.op_id);

    expect(await app.hooks.removePendingOperationIfIdentityMatches(attempted.id, attempted)).toBe(
      true,
    );
    expect(
      (await app.hooks.pendingOperations()).map((operation) => operation.note.content),
    ).toEqual(['second']);
  });

  test('does not self-conflict when a newer note save is queued during an earlier push', async () => {
    let revision = 1;
    let remote = {id: 'note-a', title: 'Note', tags: '', content: 'base', revision};
    const pushes = [];
    const app = track(
      await createApp({
        fetchImpl: async (path, options = {}) => {
          if (String(path) === '/api/sync/push') {
            const request = JSON.parse(options.body);
            pushes.push(request.operations);
            const acknowledged = request.operations.map((operation) => {
              if (operation.base_revision !== revision) {
                return {
                  client_sequence: operation.client_sequence,
                  op_id: operation.op_id,
                  status: 'conflict',
                  current_revision: revision,
                };
              }
              revision++;
              remote = {
                ...remote,
                title: operation.title,
                tags: operation.tags,
                content: operation.content,
                revision,
              };
              return {
                client_sequence: operation.client_sequence,
                op_id: operation.op_id,
                status: 'applied',
                revision,
              };
            });
            return response(
              200,
              JSON.stringify({
                acknowledged,
                expected_sequence: request.operations.at(-1).client_sequence + 1,
              }),
            );
          }
          if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );

    await app.hooks.putLocalNote({
      ...remote,
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {
        ...remote,
        content: 'first edit',
        base_revision: revision,
        base_content: remote.content,
        base_title: remote.title,
        base_tags: remote.tags,
      },
    });
    const first = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(first.id);

    await app.hooks.putLocalNote({
      ...remote,
      content: 'newest edit',
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {
        ...remote,
        content: 'newest edit',
        base_revision: revision,
        base_content: remote.content,
        base_title: remote.title,
        base_tags: remote.tags,
      },
    });

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toHaveLength(1);
    expect(pushes[1]).toHaveLength(1);
    expect(pushes[1][0].base_revision).toBe(2);
    expect(remote.content).toBe('newest edit');
    expect(app.window.document.querySelector('#toast-region').textContent).not.toContain(
      'conflict',
    );
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('does not overwrite a remote edit when a stale pin precedes a local save', async () => {
    let revision = 3;
    let remote = {
      id: 'note-a',
      title: 'Note',
      tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision,
      pinned: false,
      pin_order: 0,
    };
    const app = track(
      await createApp({
        realMerge: true,
        fetchImpl: async (path, options = {}) => {
          if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
          if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
          const request = JSON.parse(options.body);
          const acknowledged = request.operations.map((operation) => {
            if (operation.type !== 'noop' && operation.base_revision !== revision) {
              return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
            }
            if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
            revision++;
            if (operation.type === 'note.save') {
              remote = {
                ...remote,
                title: operation.title,
                tags: operation.tags,
                content: operation.content,
                revision,
              };
            } else if (operation.type === 'note.pin') {
              remote = {
                ...remote,
                pinned: operation.pinned,
                pin_order: operation.pinned ? 9 : 0,
                revision,
              };
            }
            return {
              op_id: operation.op_id,
              status: 'applied',
              revision,
              pin_order: remote.pin_order,
            };
          });
          return response(
            200,
            JSON.stringify({
              acknowledged,
              expected_sequence: request.operations.at(-1).client_sequence + 1,
            }),
          );
        },
      }),
    );
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote,
      content: localContent,
      revision: 2,
      pinned: true,
      pin_order: 5,
      pending: true,
      base_revision: 2,
      base_content: base,
      base_title: 'Note',
      base_tags: '',
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 2,
      pinned: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 2,
      note: {
        id: 'note-a',
        title: 'Note',
        tags: '',
        content: localContent,
        revision: 2,
        pinned: true,
        base_revision: 2,
        base_content: base,
        base_title: 'Note',
        base_tags: '',
      },
    });

    await app.hooks.flushPendingChanges();

    expect(remote.content).toBe('one\nlocal change\nthree\nremote change');
  });

  test('preserves a later pin when an earlier save conflicts', async () => {
    let revision = 2;
    let remote = {
      id: 'note-a',
      title: 'Note',
      tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision,
      pinned: false,
      pin_order: 0,
    };
    const app = track(
      await createApp({
        realMerge: true,
        fetchImpl: async (path, options = {}) => {
          if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
          if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
          const request = JSON.parse(options.body);
          const acknowledged = request.operations.map((operation) => {
            if (operation.type !== 'noop' && operation.base_revision !== revision) {
              return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
            }
            if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
            revision++;
            if (operation.type === 'note.save') {
              remote = {
                ...remote,
                title: operation.title,
                tags: operation.tags,
                content: operation.content,
                pinned: operation.pinned,
                revision,
                pin_order: operation.pinned ? 12 : 0,
              };
            } else if (operation.type === 'note.pin') {
              remote = {
                ...remote,
                pinned: operation.pinned,
                revision,
                pin_order: operation.pinned ? 12 : 0,
              };
            }
            return {
              op_id: operation.op_id,
              status: 'applied',
              revision,
              pin_order: remote.pin_order,
            };
          });
          return response(
            200,
            JSON.stringify({
              acknowledged,
              expected_sequence: request.operations.at(-1).client_sequence + 1,
            }),
          );
        },
      }),
    );
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote,
      content: localContent,
      revision: 1,
      pinned: true,
      pin_order: 5,
      pending: true,
      base_revision: 1,
      base_content: base,
      base_title: 'Note',
      base_tags: '',
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {
        id: 'note-a',
        title: 'Note',
        tags: '',
        content: localContent,
        revision: 1,
        pinned: false,
        base_revision: 1,
        base_content: base,
        base_title: 'Note',
        base_tags: '',
      },
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 1,
      pinned: true,
      pin_order: 5,
    });

    await app.hooks.flushPendingChanges();

    expect(remote).toMatchObject({
      content: 'one\nlocal change\nthree\nremote change',
      pinned: true,
    });
  });

  test('allows only one tab to hold the fallback sync lease', async () => {
    const firstTab = track(await createApp());
    const secondTab = track(await createApp());
    let release;
    let resolveStarted;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const leaderRun = firstTab.hooks.withSyncLeadership(async () => {
      resolveStarted();
      await gate;
      return 'leader';
    });
    await started;
    expect(await secondTab.hooks.withSyncLeadership(() => 'unexpected follower')).toBe(false);
    secondTab.hooks.cancelScheduledSync();
    release();
    expect(await leaderRun).toBe('leader');
  });

  test('does not fall through to the fallback lease when a Web Lock is held', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.navigator, 'locks', {
      configurable: true,
      value: {request: vi.fn(async (_name, _options, callback) => callback(null))},
    });
    const work = vi.fn(() => 'unexpected leader');

    expect(await app.hooks.withSyncLeadership(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    app.hooks.cancelScheduledSync();
  });
});

describe('F-03 compacted acknowledgement recovery', () => {
  async function queueAttemptedNote(app) {
    const note = {
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Local',
      tags: '',
      content: 'local content',
      revision: 2,
      base_revision: 2,
      base_content: 'remote base',
      base_title: 'Local',
      base_tags: '',
      pending: true,
    };
    await app.hooks.saveLocalNoteAndQueue(note, {
      type: 'note.save',
      note_id: note.id,
      base_revision: note.base_revision,
      note,
    });
    const queued = (await app.hooks.pendingOperations())[0];
    return app.hooks.claimQueueOperation(queued.id);
  }

  test('keeps the queue and local note when reconciliation times out', async () => {
    const app = track(await createApp({fetchImpl: async () => response(503, 'temporary failure')}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await expect(app.hooks.acknowledgeCompactedOperation(operation)).rejects.toMatchObject({
      responseStatus: 503,
    });
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pending: true,
      content: 'local content',
    });
  });

  test('removes local state only after an authoritative 404', async () => {
    const app = track(await createApp({fetchImpl: async () => response(404)}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
  });

  test('applies the authoritative remote note and clears pending state', async () => {
    const remote = {
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Remote',
      tags: 'work',
      content: 'remote content',
      revision: 9,
    };
    const app = track(
      await createApp({fetchImpl: async () => response(200, JSON.stringify(remote))}),
    );
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      ...remote,
      pending: false,
      base_revision: null,
    });
  });
});

describe('conflict deletion recovery', () => {
  async function createDeletedConflictApp() {
    let remoteReads = 0;
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
          if (String(path) === '/api/notes/note-a') {
            remoteReads++;
            return response(404);
          }
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local edit',
      content: 'Keep this',
      pending: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });
    return {app, getRemoteReads: () => remoteReads};
  }

  test('persists the decision and keeps local content when the remote note was deleted', async () => {
    const {app, getRemoteReads} = await createDeletedConflictApp();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(getRemoteReads()).toBe(1);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({
      kind: 'remote-deleted',
      note_id: 'note-a',
    });
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pending: false,
      content: 'Keep this',
    });
    expect(app.window.document.querySelector('#conflict-title').textContent).toBe(
      'Note deleted on another device',
    );

    app.window.document.querySelector('#conflict-later').click();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({
      kind: 'remote-deleted',
    });

    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Updated locally',
      content: 'Newer local content',
    });
    await app.hooks.saveCurrentNote(false);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({
      local: {title: 'Updated locally', content: 'Newer local content'},
    });
  });

  test('keeps the local version as a new note when requested', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-copy').click();
    let pending = [];
    for (let attempt = 0; attempt < 20 && !pending.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      pending = await app.hooks.pendingOperations();
    }
    app.hooks.cancelScheduledSync();

    expect(pending).toHaveLength(1);
    expect(pending[0].note_id).not.toBe('note-a');
    expect(pending[0].note).toMatchObject({
      title: 'Local edit (conflict copy)',
      content: 'Keep this',
    });
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
  });

  test('discards the local version only when deletion is accepted', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-save').click();
    let localNote;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      localNote = await app.hooks.getLocalNote('note-a');
      if (!localNote) break;
    }
    app.hooks.cancelScheduledSync();

    expect(localNote).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('keeps the original operation when the remote lookup fails transiently', async () => {
    let pushCount = 0;
    let remoteReads = 0;
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) === '/api/sync/push') {
            pushCount++;
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
          if (String(path) === '/api/notes/note-a') {
            remoteReads++;
            return response(503, 'temporary failure');
          }
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local edit',
      content: 'Keep this',
      pending: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });

    await expect(app.hooks.flushPendingChanges()).rejects.toMatchObject({responseStatus: 503});

    expect(pushCount).toBe(1);
    expect(remoteReads).toBe(1);
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pending: true,
      content: 'Keep this',
    });
  });
});
