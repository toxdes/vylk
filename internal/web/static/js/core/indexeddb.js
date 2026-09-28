(function (root) {
  'use strict';

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function withTransaction(openDatabase, names, mode, work, transformStores = null) {
    const database = await openDatabase();
    const transaction = database.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
    const complete = transactionComplete(transaction);
    try {
      const result = await work(transformStores ? transformStores(stores, transaction) : stores);
      await complete;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch (_) {}
      await complete.catch(() => {});
      throw error;
    }
  }

  function encryptedStores(stores, cryptor, transaction) {
    function wrapRequest(request, transform = (value) => value) {
      let result;
      let error;
      const wrapped = {
        get result() {
          return result;
        },
        get error() {
          return error;
        },
        onsuccess: null,
        onerror: null,
      };
      request.onsuccess = () => {
        try {
          result = transform(request.result);
          wrapped.onsuccess?.({target: wrapped});
        } catch (cause) {
          error = cause;
          try {
            transaction.abort();
          } catch (_) {}
          wrapped.onerror?.({target: wrapped});
        }
      };
      request.onerror = () => {
        error = request.error;
        wrapped.onerror?.({target: wrapped});
      };
      return wrapped;
    }

    function wrapCursor(storeName, cursor) {
      if (!cursor) return null;
      return {
        get key() {
          return cursor.key;
        },
        get primaryKey() {
          return cursor.primaryKey;
        },
        get value() {
          return cryptor.decryptRecord(storeName, cursor.value);
        },
        continue: (...args) => cursor.continue(...args),
        advance: (...args) => cursor.advance(...args),
        update: (value) => cursor.update(cryptor.encryptRecord(storeName, value)),
        delete: () => cursor.delete(),
      };
    }

    function wrapStore(storeName, store) {
      const reads = {
        get: (...args) =>
          wrapRequest(store.get(...args), (value) => cryptor.decryptRecord(storeName, value)),
        getAll: (...args) =>
          wrapRequest(store.getAll(...args), (values) =>
            values.map((value) => cryptor.decryptRecord(storeName, value)),
          ),
        openCursor: (...args) =>
          wrapRequest(store.openCursor(...args), (cursor) => wrapCursor(storeName, cursor)),
      };
      return {
        ...reads,
        add: (value) => store.add(cryptor.encryptRecord(storeName, value)),
        put: (value) => store.put(cryptor.encryptRecord(storeName, value)),
        delete: (...args) => store.delete(...args),
        index: (name) => {
          const index = store.index(name);
          return {
            get: (...args) =>
              wrapRequest(index.get(...args), (value) => cryptor.decryptRecord(storeName, value)),
            getAll: (...args) =>
              wrapRequest(index.getAll(...args), (values) =>
                values.map((value) => cryptor.decryptRecord(storeName, value)),
              ),
            openCursor: (...args) =>
              wrapRequest(index.openCursor(...args), (cursor) => wrapCursor(storeName, cursor)),
          };
        },
      };
    }

    return Object.fromEntries(
      Object.entries(stores).map(([name, store]) => [name, wrapStore(name, store)]),
    );
  }

  root.VylkIndexedDB = Object.freeze({
    encryptedStores,
    requestValue,
    transactionComplete,
    withTransaction,
  });
})(globalThis);
