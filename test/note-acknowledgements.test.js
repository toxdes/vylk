import {afterEach, describe, expect, test, vi} from 'vitest';
import {IDBObjectStore, indexedDB} from 'fake-indexeddb';
import sodium from 'libsodium-wrappers-sumo';

await import('../internal/web/static/js/core/indexeddb.js');
await import('../internal/web/static/js/core/vault-crypto.js');
await import('../internal/web/static/js/core/vault-local.js');
await import('../internal/web/static/js/core/offline-store.js');
await import('../internal/web/static/js/sync/acknowledgements.js');
await sodium.ready;
globalThis.VylkSodium = sodium;

afterEach(() => vi.restoreAllMocks());

async function makeStore(encrypted) {
  const store = globalThis.VylkOfflineStore.create({
    databaseName: `acknowledgement-race-${crypto.randomUUID()}`,
    indexedDB,
    createID: () => crypto.randomUUID(),
  });
  if (encrypted) {
    const root = await globalThis.VylkVaultCrypto.importRoot(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const vaultID = globalThis.VylkVaultCrypto.toBase64(crypto.getRandomValues(new Uint8Array(16)));
    await store.unlockVaultLocal(root, vaultID, false, 1);
  }
  return store;
}

async function save(store, content) {
  const note = {
    id: 'note-a',
    title: 'Note',
    tags: '',
    content,
    revision: 0,
    base_revision: 0,
    pending: true,
  };
  await store.saveLocalNoteAndQueue(note, {
    type: 'note.save',
    note_id: note.id,
    base_revision: 0,
    note,
  });
  return note;
}

function acknowledgements(store) {
  return globalThis.VylkSyncAcknowledgements.create({
    commitNoteAcknowledgement: store.commitNoteAcknowledgement,
    pendingOperationsForNote: store.pendingOperationsForNote,
    latestLaterOperation: store.latestLaterOperation,
    rebaseOperations: store.rebaseQueuedNoteOperations,
    getLocalNote: store.getLocalNote,
    putLocalNote: store.putLocalNote,
    getCurrentNoteID: () => null,
    refreshDashboard: async () => {},
    removePendingOperation: store.removePendingOperationIfIdentityMatches,
  });
}

describe.each([false, true])('note acknowledgements (encrypted: %s)', (encrypted) => {
  test.each(['note.save', 'note.pin'])(
    '%s cannot overwrite a save started during its note read',
    async (type) => {
      const store = await makeStore(encrypted);
      let concurrentSave;
      try {
        const initial = {
          id: 'note-a',
          title: 'Note',
          tags: '',
          content: 'Saved before browser navigation',
          revision: 0,
          base_revision: 0,
          pending: true,
        };
        await store.putLocalNote(initial);
        await store.queueOperation({
          type,
          note_id: initial.id,
          base_revision: 0,
          ...(type === 'note.save' ? {note: initial} : {pinned: true}),
        });
        const operation = await store.claimQueueOperation((await store.pendingOperations())[0].id);
        const edited = {...initial, content: 'Saved before browser navigation and Back'};
        const get = IDBObjectStore.prototype.get;
        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (key) {
          const request = get.call(this, key);
          if (this.name === 'notes' && key === initial.id && !concurrentSave) {
            // Queue a competing write at the actual IndexedDB read boundary,
            // without holding a transaction open with a timer or external gate.
            request.addEventListener('success', () => {
              if (concurrentSave) return;
              concurrentSave = store.saveLocalNoteAndQueue(edited, {
                type: 'note.save',
                note_id: edited.id,
                base_revision: 0,
                note: edited,
              });
            });
          }
          return request;
        });
        await acknowledgements(store).apply(operation, {status: 'applied', revision: 1});
        expect(concurrentSave).toBeDefined();
        await concurrentSave;
        expect(await store.getLocalNote(initial.id)).toMatchObject({
          content: edited.content,
          pending: true,
        });
        expect(await store.pendingOperations()).toMatchObject([{note: {content: edited.content}}]);
      } finally {
        await concurrentSave;
        vi.restoreAllMocks();
        await store.closeOfflineDatabaseConnection();
      }
    },
  );

  test.each([false, true])('preserves a later save (already attempted: %s)', async (attempted) => {
    const store = await makeStore(encrypted);
    try {
      await save(store, 'original');
      const first = await store.claimQueueOperation((await store.pendingOperations())[0].id);
      await save(store, 'newer edit');
      const later = (await store.pendingOperations())[1];
      if (attempted) await store.claimQueueOperation(later.id);
      await store.commitNoteAcknowledgement(first, {revision: 1});
      expect(await store.getLocalNote('note-a')).toMatchObject({
        content: 'newer edit',
        revision: 1,
        pending: true,
        base_revision: 1,
        base_content: 'original',
      });
      expect(await store.pendingOperations()).toMatchObject([
        {op_id: later.op_id, note: {content: 'newer edit'}, base_revision: attempted ? 0 : 1},
      ]);
      await expect(store.commitNoteAcknowledgement(first, {revision: 999})).resolves.toBeNull();
      expect((await store.getLocalNote('note-a')).revision).toBe(1);
    } finally {
      await store.closeOfflineDatabaseConnection();
    }
  });

  test('rolls back note metadata, queue rebasing, and removal together on storage failure', async () => {
    const store = await makeStore(encrypted);
    try {
      await save(store, 'original');
      const first = await store.claimQueueOperation((await store.pendingOperations())[0].id);
      await save(store, 'newer edit');
      const before = await store.pendingOperations();
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
        if (this.name === 'notes') throw new Error('test storage failure');
        return put.apply(this, args);
      });
      await expect(store.commitNoteAcknowledgement(first, {revision: 1})).rejects.toThrow(
        'test storage failure',
      );
      expect(await store.pendingOperations()).toEqual(before);
      expect(await store.getLocalNote('note-a')).toMatchObject({
        content: 'newer edit',
        revision: 0,
        pending: true,
      });
    } finally {
      vi.restoreAllMocks();
      await store.closeOfflineDatabaseConnection();
    }
  });
});
