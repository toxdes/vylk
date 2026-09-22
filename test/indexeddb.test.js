import {beforeEach, describe, expect, test} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';

await import('../internal/web/static/js/core/indexeddb.js');

describe('IndexedDB transaction helpers', () => {
  let indexedDB;
  let database;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('test', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });

  test('returns request results and waits for a committed transaction', async () => {
    await globalThis.VylkIndexedDB.withTransaction(
      async () => database,
      ['records'],
      'readwrite',
      async ({records}) => {
        await globalThis.VylkIndexedDB.requestValue(records.put({name: 'one'}, 'key'));
      },
    );

    const record = await globalThis.VylkIndexedDB.withTransaction(
      async () => database,
      ['records'],
      'readonly',
      ({records}) => globalThis.VylkIndexedDB.requestValue(records.get('key')),
    );
    expect(record).toEqual({name: 'one'});
  });

  test('rejects failed requests', async () => {
    await expect(
      globalThis.VylkIndexedDB.withTransaction(
        async () => database,
        ['missing'],
        'readonly',
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
