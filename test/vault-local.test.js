import {afterEach, describe, expect, test} from 'vitest';
import {indexedDB} from 'fake-indexeddb';
import sodium from 'libsodium-wrappers-sumo';

await import('../internal/web/static/js/core/indexeddb.js');
await import('../internal/web/static/js/core/vault-crypto.js');
await import('../internal/web/static/js/core/vault-local.js');
await import('../internal/web/static/js/core/offline-store.js');
await sodium.ready;
globalThis.VylkSodium = sodium;

const vaultID = globalThis.VylkVaultCrypto.toBase64(crypto.getRandomValues(new Uint8Array(16)));
const rootKey = await globalThis.VylkVaultCrypto.importRoot(
  crypto.getRandomValues(new Uint8Array(32)),
);
const databases = [];

function makeStore(databaseName) {
  return globalThis.VylkOfflineStore.create({
    databaseName,
    indexedDB,
    createID: () => crypto.randomUUID(),
  });
}

async function raw(databaseName, table, id) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction(table, 'readonly').objectStore(table).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return record;
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const databaseName of databases.splice(0)) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
});

describe('encrypted offline store', () => {
  test('converts existing notes, queue and state and encrypts subsequent writes', async () => {
    const databaseName = `vault-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const store = makeStore(databaseName);
    await store.putLocalNote({id: 'note-1', title: 'Secret title', content: 'Secret body'});
    await store.queueOperation({
      type: 'note.save',
      note_id: 'note-1',
      base_revision: 0,
      note: {id: 'note-1', title: 'Secret title', content: 'Secret body'},
    });
    await store.setOfflineState('private-state', {text: 'Secret state'});

    await store.unlockVaultLocal(rootKey, vaultID, true, 1);
    expect(await raw(databaseName, 'keys', 'root')).toBeTruthy();
    await store.forgetRememberedVaultRoot();
    expect(await raw(databaseName, 'keys', 'root')).toBeUndefined();
    expect(await store.getLocalNote('note-1')).toMatchObject({title: 'Secret title'});
    const queue = await store.pendingOperations();
    expect(queue[0].note.title).toBe('Secret title');
    expect(await store.getOfflineState('private-state')).toEqual({text: 'Secret state'});
    expect(JSON.stringify(await raw(databaseName, 'notes', 'note-1'))).not.toContain('Secret');
    expect(JSON.stringify(await raw(databaseName, 'queue', queue[0].id))).not.toContain('Secret');
    expect(JSON.stringify(await raw(databaseName, 'state', 'private-state'))).not.toContain(
      'Secret',
    );

    await store.putLocalNote({id: 'note-2', title: 'Second secret', content: 'Second body'});
    expect(JSON.stringify(await raw(databaseName, 'notes', 'note-2'))).not.toContain('Second');
    await store.queueOperation({
      type: 'note.save',
      note_id: 'note-2',
      base_revision: 0,
      note: {id: 'note-2', title: 'Second secret', content: 'Second body'},
    });
    const secondQueue = (await store.pendingOperations()).find((item) => item.note_id === 'note-2');
    expect(secondQueue.note.title).toBe('Second secret');
    expect(JSON.stringify(await raw(databaseName, 'queue', secondQueue.id))).not.toContain(
      'Second',
    );
    store.lockVaultLocal();
    await expect(store.getLocalNote('note-1')).rejects.toThrow('locked');
    await store.closeOfflineDatabaseConnection();
  });

  test('discards every local vault record when switching to a new vault', async () => {
    const databaseName = `vault-reset-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const store = makeStore(databaseName);
    await store.unlockVaultLocal(rootKey, vaultID, true, 1);
    await store.putLocalNote({id: 'old-note', title: 'Old vault secret', content: 'offline text'});
    await store.queueOperation({
      type: 'note.save',
      note_id: 'old-note',
      base_revision: 0,
      note: {id: 'old-note', title: 'Old vault secret', content: 'offline text'},
    });
    await store.cacheVaultWrappers({vault_id: vaultID});
    await store.cacheVaultBootstrap({vault_id: vaultID, epoch: 1});

    await store.discardVaultLocalData();

    expect(await store.getAllLocalNotes()).toEqual([]);
    expect(await store.pendingOperations()).toEqual([]);
    expect(await store.cachedVaultWrappers()).toBeNull();
    expect(await store.cachedVaultBootstrap()).toBeNull();
    await store.closeOfflineDatabaseConnection();
  });

  test('clears an old encrypted offline vault when a newer vault epoch unlocks', async () => {
    const databaseName = `vault-epoch-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const store = makeStore(databaseName);
    await store.unlockVaultLocal(rootKey, vaultID, true, 1);
    await store.putLocalNote({id: 'old-note', title: 'Old epoch note', content: 'offline text'});
    const nextVaultID = globalThis.VylkVaultCrypto.toBase64(
      crypto.getRandomValues(new Uint8Array(16)),
    );
    const nextRootKey = await globalThis.VylkVaultCrypto.importRoot(
      crypto.getRandomValues(new Uint8Array(32)),
    );

    await store.unlockVaultLocal(nextRootKey, nextVaultID, true, 2);

    expect(await store.getAllLocalNotes()).toEqual([]);
    await store.closeOfflineDatabaseConnection();
  });
});
