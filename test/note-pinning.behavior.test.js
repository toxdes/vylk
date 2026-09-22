import {describe, expect, test} from 'vitest';
import {createApp, response} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('note pinning', () => {
  test('folds a pin into an unsynced note save', async () => {
    const app = track(await createApp());
    const note = {
      id: 'new-note',
      title: 'New',
      tags: '',
      content: 'body',
      revision: 0,
      base_revision: 0,
      pending: true,
    };
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});

    await app.hooks.toggleNotePin(note.id);

    const operations = await app.hooks.pendingOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: 'note.save',
      base_revision: 0,
      note: {pinned: true},
    });
    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({pinned: true, pending: true});
  });

  test('keeps a newer pin made after an initial save was claimed', async () => {
    const app = track(await createApp());
    const note = {
      id: 'new-note',
      title: 'New',
      tags: '',
      content: 'body',
      revision: 0,
      base_revision: 0,
      pending: true,
      pinned: false,
      pin_order: 0,
    };
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});
    const save = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(save.id);
    await app.hooks.toggleNotePin(note.id);
    const pinnedLocally = await app.hooks.getLocalNote(note.id);

    await app.hooks.applySyncAcknowledgement(save, {status: 'applied', revision: 1});

    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({
      pinned: true,
      pin_order: pinnedLocally.pin_order,
      revision: 1,
      pending: true,
      base_revision: 1,
    });
    await expect(app.hooks.pendingOperations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({type: 'note.pin', pinned: true, base_revision: 1}),
      ]),
    );
  });

  test('filters before sorting and queues an offline pin without changing content', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'pinned-work',
      title: 'Pinned work',
      tags: 'work',
      content: 'keep',
      updated_at: '2026-01-01T00:00:00Z',
      revision: 2,
      pinned: true,
      pin_order: 10,
    });
    await app.hooks.putLocalNote({
      id: 'recent-work',
      title: 'Recent work',
      tags: 'work',
      content: 'recent',
      updated_at: '2026-02-01T00:00:00Z',
      revision: 2,
    });
    await app.hooks.putLocalNote({
      id: 'pinned-home',
      title: 'Pinned home',
      tags: 'home',
      content: 'hidden',
      updated_at: '2026-03-01T00:00:00Z',
      revision: 2,
      pinned: true,
      pin_order: 20,
    });

    const notes = await app.hooks.getLocalNotes();
    expect(notes.map((note) => note.id)).toEqual(['pinned-home', 'pinned-work', 'recent-work']);
    expect(
      notes.filter((note) => (note.tags || '').split(',').includes('work')).map((note) => note.id),
    ).toEqual(['pinned-work', 'recent-work']);

    await app.hooks.toggleNotePin('recent-work');
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({
      content: 'recent',
      pinned: true,
      pending: true,
    });
    await expect(app.hooks.pendingOperations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'note.pin',
          note_id: 'recent-work',
          pinned: true,
          base_revision: 2,
        }),
      ]),
    );

    await app.hooks.toggleNotePin('recent-work');
    const pinOperations = (await app.hooks.pendingOperations()).filter(
      (operation) => operation.note_id === 'recent-work' && operation.type === 'note.pin',
    );
    expect(pinOperations).toHaveLength(1);
    expect(pinOperations[0].pinned).toBe(false);
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({
      content: 'recent',
      pinned: false,
      pin_order: 0,
    });
  });

  test('does not let a remote pin update replace a pending local pin', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local',
      content: 'keep',
      revision: 2,
      pending: true,
      base_revision: 2,
      pinned: true,
      pin_order: 42,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 2,
      pinned: true,
    });

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([
        [
          'note-a',
          {
            id: 'note-a',
            title: 'Remote',
            content: 'replace',
            revision: 3,
            pinned: false,
            pin_order: 0,
          },
        ],
      ]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      content: 'keep',
      pinned: true,
      pin_order: 42,
      pending: true,
    });
  });

  test('does not accept remote deletion while a pin operation is queued', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Pinned locally',
      content: 'keep',
      revision: 2,
      pinned: true,
      pin_order: 9,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 2,
      pinned: true,
    });

    await expect(app.hooks.applyRemoteDeletion('note-a')).resolves.toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'keep', pinned: true});
  });

  test('rebases a later content save after a pin acknowledgement', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Note',
      content: 'body',
      revision: 1,
      pinned: false,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 1,
      pinned: true,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'edited'},
    });
    const pin = (await app.hooks.pendingOperations()).find(
      (operation) => operation.type === 'note.pin',
    );

    await app.hooks.applySyncAcknowledgement(pin, {
      status: 'applied',
      op_id: pin.op_id,
      revision: 2,
      pin_order: 11,
    });

    await expect(app.hooks.pendingOperations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({type: 'note.save', note_id: 'note-a', base_revision: 2}),
      ]),
    );
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pinned: true,
      pin_order: 11,
      revision: 2,
    });
  });

  test('does not let an older pin acknowledgement undo a newer toggle', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Note',
      content: 'body',
      revision: 1,
      pinned: true,
      pin_order: 10,
      pending: true,
      base_revision: 1,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 1,
      pinned: true,
      pin_order: 10,
    });
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {
      status: 'applied',
      revision: 2,
      pin_order: 11,
    });

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pinned: false,
      pin_order: 0,
      revision: 2,
      pending: true,
      base_revision: 2,
    });
    await expect(app.hooks.pendingOperations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({type: 'note.pin', pinned: false, base_revision: 2}),
      ]),
    );
  });

  test('does not retry a stale pin over a newer toggle after conflict', async () => {
    const remote = {
      id: 'note-a',
      title: 'Remote',
      tags: '',
      content: 'body',
      revision: 3,
      pinned: false,
      pin_order: 0,
    };
    const app = track(
      await createApp({
        fetchImpl: async (path) =>
          String(path) === '/api/notes/note-a'
            ? response(200, JSON.stringify(remote))
            : response(200, '{}'),
      }),
    );
    await app.hooks.putLocalNote({
      ...remote,
      revision: 2,
      pinned: true,
      pin_order: 10,
      pending: true,
      base_revision: 2,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 2,
      pinned: true,
      pin_order: 10,
    });
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {status: 'conflict', current_revision: 3});

    const remaining = await app.hooks.pendingOperations();
    expect(remaining.filter((operation) => operation.type === 'note.pin')).toEqual([
      expect.objectContaining({pinned: false, base_revision: 3}),
    ]);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pinned: false,
      pin_order: 0,
      revision: 3,
      pending: true,
    });
  });

  test('retries a stale pin against the latest remote revision', async () => {
    let pushCount = 0;
    let lastOperationID = '';
    const remote = {
      id: 'note-a',
      title: 'Remote',
      tags: '',
      content: 'remote',
      revision: 3,
      pinned: false,
      pin_order: 0,
    };
    const app = track(
      await createApp({
        fetchImpl: async (path, options) => {
          if (String(path) === '/api/sync/push') {
            pushCount++;
            lastOperationID = JSON.parse(options.body).operations[0].op_id;
            return response(
              200,
              JSON.stringify(
                pushCount === 1
                  ? {
                      acknowledged: [
                        {op_id: lastOperationID, status: 'conflict', current_revision: 3},
                      ],
                      expected_sequence: 2,
                    }
                  : {
                      acknowledged: [
                        {op_id: lastOperationID, status: 'applied', revision: 4, pin_order: 12},
                      ],
                      expected_sequence: 3,
                    },
              ),
            );
          }
          if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
          throw new Error(`unexpected request: ${path}`);
        },
      }),
    );
    await app.hooks.putLocalNote({
      ...remote,
      title: 'Stale local',
      content: 'stale local',
      updated_at: '2025-01-01T00:00:00Z',
      pinned: false,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 2,
      pinned: true,
    });

    await app.hooks.flushPendingChanges();
    expect(pushCount).toBe(2);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      title: 'Remote',
      content: 'remote',
      pinned: true,
      pin_order: 12,
      revision: 4,
    });
  });

  test('keeps a later local content save while rebasing a stale pin', async () => {
    const remote = {
      id: 'note-a',
      title: 'Remote',
      tags: '',
      content: 'remote',
      revision: 3,
      pinned: false,
      pin_order: 0,
    };
    const app = track(
      await createApp({
        fetchImpl: async (path) =>
          String(path) === '/api/notes/note-a'
            ? response(200, JSON.stringify(remote))
            : response(200, '{}'),
      }),
    );
    await app.hooks.putLocalNote({
      ...remote,
      title: 'Local edit',
      content: 'local edit',
      revision: 2,
      pending: true,
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
      note: {id: 'note-a', title: 'Local edit', tags: '', content: 'local edit'},
    });
    const pin = (await app.hooks.pendingOperations()).find(
      (operation) => operation.type === 'note.pin',
    );

    await app.hooks.applySyncAcknowledgement(pin, {status: 'conflict', current_revision: 3});

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      title: 'Local edit',
      content: 'local edit',
      pinned: true,
      revision: 3,
      pending: true,
    });
  });

  test('recovers a compacted pin acknowledgement from the remote note', async () => {
    const remote = {
      id: 'note-a',
      title: 'Remote',
      tags: '',
      content: 'body',
      revision: 4,
      pinned: true,
      pin_order: 19,
    };
    const app = track(
      await createApp({
        fetchImpl: async (path) =>
          String(path) === '/api/notes/note-a'
            ? response(200, JSON.stringify(remote))
            : response(200, '{}'),
      }),
    );
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local',
      content: 'body',
      revision: 3,
      pending: true,
      pinned: true,
      pin_order: 2,
    });
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 3,
      pinned: true,
    });
    const operation = (await app.hooks.pendingOperations())[0];

    await app.hooks.acknowledgeCompactedOperation(operation);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pinned: true,
      pin_order: 19,
      revision: 4,
      pending: false,
    });
  });

  test('keeps a dirty open note while a remote pin update arrives', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Local',
      content: 'typed',
      revision: 2,
      pinned: false,
    });
    app.hooks.setEditorState({
      id: 'note-a',
      revision: 2,
      dirty: true,
      title: 'Local',
      content: 'typed',
    });

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([
        [
          'note-a',
          {
            id: 'note-a',
            title: 'Remote',
            content: 'remote',
            revision: 3,
            pinned: true,
            pin_order: 21,
          },
        ],
      ]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'typed', pinned: false});
  });

  test('preserves pin state during snapshot reconciliation', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({
      id: 'note-a',
      title: 'Old',
      content: 'body',
      revision: 1,
      pinned: false,
    });
    await app.hooks.applyRemoteSnapshot(
      new Map([
        [
          'note-a',
          {id: 'note-a', title: 'New', content: 'body', revision: 2, pinned: true, pin_order: 30},
        ],
      ]),
      new Set(['note-a']),
    );
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({
      pinned: true,
      pin_order: 30,
      revision: 2,
    });
  });

  test('supersedes a queued pin when a new note is deleted locally', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'New', content: 'body', revision: 0});
    await app.hooks.queueOperation({
      type: 'note.pin',
      note_id: 'note-a',
      base_revision: 0,
      pinned: true,
    });
    const operation = (await app.hooks.pendingOperations())[0];
    await app.hooks.removeLocalNoteAndSupersede('note-a', 0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toEqual([
      expect.objectContaining({id: operation.id, type: 'noop'}),
    ]);
  });
});

describe('offline database migrations', () => {
  test('upgrades the legacy layout to the explicit schema and queue index', async () => {
    const app = track(await createApp());
    const legacy = await new Promise((resolve, reject) => {
      const request = app.window.indexedDB.open('vylk-offline', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('notes', {keyPath: 'id'});
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
        db.createObjectStore('state', {keyPath: 'key'});
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    expect(legacy).toBeUndefined();

    expect(await app.hooks.getOfflineDatabaseInfo()).toMatchObject({
      version: 4,
      queueIndexes: expect.arrayContaining(['note_id', 'client_sequence']),
    });
  });
});
