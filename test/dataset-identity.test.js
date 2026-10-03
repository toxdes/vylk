import {afterEach, expect, test} from 'vitest';
import {indexedDB} from 'fake-indexeddb';
import sodium from 'libsodium-wrappers-sumo';

await import('../internal/web/static/js/core/indexeddb.js');
await import('../internal/web/static/js/core/vault-crypto.js');
await import('../internal/web/static/js/core/vault-local.js');
await import('../internal/web/static/js/core/offline-store.js');
await sodium.ready;
globalThis.VylkSodium = sodium;
const stores = [];

function create(databaseName = crypto.randomUUID()) {
  const store = globalThis.VylkOfflineStore.create({
    databaseName,
    indexedDB,
    createID: () => crypto.randomUUID(),
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.closeOfflineDatabaseConnection()));
});

test('detects the existing plaintext identity before binding a replacement dataset', async () => {
  const store = create();
  await store.setOfflineState('serverInstanceID', 'old');
  await store.putLocalNote({id: 'note', content: 'Pending edits'});
  expect(await store.inspectDataset({instance_id: 'new', mode: 'legacy'})).toMatchObject({
    changed: true,
  });
  expect((await store.getLocalNote('note')).content).toBe('Pending edits');
  expect(await store.getOfflineState('serverInstanceID')).toBe('old');
  expect(await store.inspectDataset({instance_id: 'old', mode: 'legacy'})).toMatchObject({
    changed: false,
  });
});

test('an offline tab adopts the first identity assigned by another tab without losing edits', async () => {
  const name = crypto.randomUUID();
  const offline = create(name);
  const online = create(name);
  await offline.setOfflineState('serverInstanceID', 'original');
  await offline.putLocalNote({id: 'pending', content: 'Offline edits'});
  expect(await online.inspectDataset({instance_id: 'original', mode: 'legacy'})).toEqual({
    changed: false,
  });
  expect((await offline.getLocalNote('pending')).content).toBe('Offline edits');
  expect(await offline.inspectDataset({instance_id: 'original', mode: 'legacy'})).toEqual({
    changed: false,
  });
  await offline.putLocalNote({id: 'pending', content: 'More offline edits'});
  expect((await online.getLocalNote('pending')).content).toBe('More offline edits');
});

test('first-use adoption does not adopt an explicitly switched replacement', async () => {
  const name = crypto.randomUUID();
  const offline = create(name);
  const online = create(name);
  await offline.getLocalNotes();
  await online.inspectDataset({instance_id: 'original', mode: 'legacy'});
  await online.switchDataset({instance_id: 'replacement', mode: 'legacy'});
  expect(await offline.inspectDataset({instance_id: 'replacement', mode: 'legacy'})).toEqual({
    changed: true,
  });
  await expect(
    offline.putLocalNote({id: 'pending', content: 'Old tab edits'}),
  ).rejects.toMatchObject({code: 'server_instance_changed'});
});

test('an encrypted offline tab adopts the first public identity without losing its key or edits', async () => {
  const name = crypto.randomUUID();
  const offline = create(name);
  const online = create(name);
  const vaultID = globalThis.VylkVaultCrypto.toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await globalThis.VylkVaultCrypto.importRoot(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await offline.putLocalNote({id: 'pending', content: 'Private offline edits'});
  await offline.unlockVaultLocal(key, vaultID, true, 1);
  const config = {instance_id: 'original', mode: 'encrypted', vault_id: vaultID, epoch: 1};
  expect(await online.inspectDataset(config)).toEqual({changed: false});
  expect((await offline.getLocalNote('pending')).content).toBe('Private offline edits');
  expect(await offline.inspectDataset(config)).toEqual({changed: false});
  await offline.putLocalNote({id: 'pending', content: 'More private edits'});
  await online.unlockVaultLocal(key, vaultID, false, 1);
  expect((await online.getLocalNote('pending')).content).toBe('More private edits');
});

test('detects a locked encrypted cache without decrypting it and switches only explicitly', async () => {
  const name = crypto.randomUUID();
  const store = create(name);
  const stale = create(name);
  const vaultID = globalThis.VylkVaultCrypto.toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await globalThis.VylkVaultCrypto.importRoot(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const original = {instance_id: 'old', mode: 'encrypted', vault_id: vaultID, epoch: 1};
  await store.inspectDataset(original);
  await store.putLocalNote({id: 'note', content: 'Private pending edits'});
  await store.unlockVaultLocal(key, vaultID, true, 1);
  await stale.inspectDataset(original);
  store.lockVaultLocal();
  const replacement = {instance_id: 'new', mode: 'legacy'};
  expect(await store.inspectDataset(replacement)).toMatchObject({changed: true});
  expect(await store.vaultLocalFormat()).toBe(true);
  expect(await store.rememberedVaultRoot()).not.toBeNull();
  expect(await store.switchDataset(replacement)).toBe(true);
  const reloaded = create(name);
  await reloaded.inspectDataset(replacement);
  expect(await reloaded.vaultLocalFormat()).toBe(false);
  expect(await reloaded.rememberedVaultRoot()).toBeUndefined();
  expect(await reloaded.pendingOperations()).toEqual([]);
  await expect(
    stale.putLocalNote({id: 'stale', content: 'Must not cross datasets'}),
  ).rejects.toMatchObject({code: 'server_instance_changed'});
  await expect(stale.cacheVaultBootstrap(original)).rejects.toMatchObject({
    code: 'server_instance_changed',
  });
  await reloaded.putLocalNote({id: 'fresh', content: 'New dataset'});
  expect(await stale.switchDataset(replacement)).toBe(false);
  expect((await reloaded.getLocalNote('fresh')).content).toBe('New dataset');
});

test('older encrypted caches use the vault marker when a public instance ID is not yet stored', async () => {
  const store = create();
  const db = await store.openOfflineDB();
  const tx = db.transaction('state', 'readwrite');
  tx.objectStore('state').put({
    key: 'vault-local-format',
    value: 1,
    vaultID: 'previous-vault',
    epoch: 1,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  expect(await store.inspectDataset({instance_id: 'new', mode: 'legacy'})).toMatchObject({
    changed: true,
  });
  expect(
    await store.inspectDataset({
      instance_id: 'old',
      mode: 'encrypted',
      vault_id: 'previous-vault',
      epoch: 1,
    }),
  ).toMatchObject({changed: false});
});

test('an older tab cannot clear a third dataset that replaced its original cache', async () => {
  const name = crypto.randomUUID();
  const stale = create(name);
  await stale.setOfflineState('serverInstanceID', 'original');
  await stale.inspectDataset({instance_id: 'replacement', mode: 'legacy'});
  const active = create(name);
  await active.inspectDataset({instance_id: 'original', mode: 'legacy'});
  await active.switchDataset({instance_id: 'third', mode: 'legacy'});
  const reloaded = create(name);
  await reloaded.inspectDataset({instance_id: 'third', mode: 'legacy'});
  await reloaded.putLocalNote({id: 'fresh', content: 'Third database edits'});
  await expect(
    stale.switchDataset({instance_id: 'replacement', mode: 'legacy'}),
  ).rejects.toMatchObject({code: 'server_instance_changed'});
  expect((await reloaded.getLocalNote('fresh')).content).toBe('Third database edits');
});

test('a tab started offline is fenced by its first local read, without live bootstrap', async () => {
  const name = crypto.randomUUID();
  const active = create(name);
  await active.inspectDataset({instance_id: 'original', mode: 'legacy'});
  await active.putLocalNote({id: 'old', content: 'Original database'});
  const offline = create(name);
  expect((await offline.getLocalNote('old')).content).toBe('Original database');
  await active.switchDataset({instance_id: 'replacement', mode: 'legacy'});
  await expect(offline.putLocalNote({id: 'stale', content: 'Old edits'})).rejects.toMatchObject({
    code: 'server_instance_changed',
  });
  const reloaded = create(name);
  expect(await reloaded.getLocalNote('stale')).toBeUndefined();
});

test('the switching tab cannot reuse its old callbacks before the replacement page loads', async () => {
  const name = crypto.randomUUID();
  const oldPage = create(name);
  await oldPage.inspectDataset({instance_id: 'original', mode: 'legacy'});
  const replacement = {instance_id: 'replacement', mode: 'legacy'};
  await oldPage.switchDataset(replacement);
  await expect(
    oldPage.putLocalNote({id: 'old', content: 'Delayed save from the previous page'}),
  ).rejects.toMatchObject({code: 'server_instance_changed'});
  expect(await oldPage.inspectDataset(replacement)).toEqual({changed: true});
  const newPage = create(name);
  expect(await newPage.inspectDataset(replacement)).toEqual({changed: false});
  expect(await newPage.getLocalNotes()).toEqual([]);
});
