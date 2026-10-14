// Seed an already-attempted operation for acknowledgement and recovery scenarios.
// Queue claiming in the app belongs to VylkSyncBatch, not this fixture.
export function markOperationAttempted(store, id) {
  return store.withOfflineStore(
    ['queue'],
    'readwrite',
    ({queue}) =>
      new Promise((resolve, reject) => {
        const request = queue.get(id);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const operation = request.result;
          if (operation) {
            operation.attempted_at ||= '2026-01-01T00:00:00.000Z';
            queue.put(operation);
          }
          resolve(operation || null);
        };
      }),
  );
}
