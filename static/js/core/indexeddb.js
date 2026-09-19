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

  async function withTransaction(openDatabase, names, mode, work) {
    const database = await openDatabase();
    const transaction = database.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
    const complete = transactionComplete(transaction);
    const result = await work(stores);
    await complete;
    return result;
  }

  root.VylkIndexedDB = Object.freeze({requestValue, transactionComplete, withTransaction});
})(globalThis);
