import {beforeEach, describe, expect, test} from 'vitest';
import {indexedDB} from 'fake-indexeddb';

await import('../static/js/core/indexeddb.js');
await import('../static/js/core/offline-store.js');

describe('offline store', () => {
  let databaseName;
  let nextID;
  let syncRequests;
  let store;

  beforeEach(() => {
    databaseName = `vylk-offline-test-${crypto.randomUUID()}`;
    nextID = 0;
    syncRequests = 0;
    store = globalThis.VylkOfflineStore.create({
      databaseName,
      indexedDB,
      createID: () => `operation-${++nextID}`,
      onSyncRequested: () => syncRequests++,
    });
  });

  test('sorts visible notes by pin state, pin order, and update time', async () => {
    await store.putLocalNote({id: 'old', updated_at: '2026-01-01T00:00:00Z'});
    await store.putLocalNote({id: 'new', updated_at: '2026-02-01T00:00:00Z'});
    await store.putLocalNote({
      id: 'pinned',
      pinned: true,
      pin_order: 1,
      updated_at: '2025-01-01T00:00:00Z',
    });
    await store.putLocalNote({id: 'deleted', deleted: true, updated_at: '2027-01-01T00:00:00Z'});

    expect((await store.getLocalNotes()).map((note) => note.id)).toEqual(['pinned', 'new', 'old']);
    await store.clearOfflineData();
  });

  test('coalesces untouched saves but preserves the identity of an attempted operation', async () => {
    const operation = (title) => ({
      type: 'note.save',
      note_id: 'note-1',
      base_revision: 0,
      note: {id: 'note-1', title},
    });

    await store.queueOperation(operation('first'));
    await store.queueOperation(operation('latest'));
    let queued = await store.pendingOperations();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({op_id: 'operation-1', client_sequence: 1});
    expect(queued[0].note.title).toBe('latest');

    await store.claimQueueOperation(queued[0].id);
    await store.queueOperation(operation('after-attempt'));
    queued = await store.pendingOperations();
    expect(queued).toHaveLength(2);
    expect(queued.map(({op_id, client_sequence}) => [op_id, client_sequence])).toEqual([
      ['operation-1', 1],
      ['operation-2', 2],
    ]);
    expect(syncRequests).toBe(3);
    await store.clearOfflineData();
  });
});
