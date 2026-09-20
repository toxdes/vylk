(function (root) {
  'use strict';

  function serialize(operation) {
    const outgoing = {
      client_sequence: operation.client_sequence,
      op_id: operation.op_id,
      type: operation.type,
      note_id: operation.note_id,
      base_revision: operation.base_revision,
    };
    if (operation.type === 'note.save') {
      outgoing.title = operation.note.title;
      outgoing.tags = operation.note.tags;
      outgoing.content = operation.note.content;
      outgoing.pinned = Boolean(operation.note.pinned);
    } else if (operation.type === 'note.pin') {
      outgoing.pinned = Boolean(operation.pinned);
    } else if (operation.type === 'prefs.save') {
      outgoing.prefs = operation.prefs;
    }
    return outgoing;
  }

  function encodedByteLength(value) {
    const encoded = JSON.stringify(value);
    return typeof TextEncoder === 'function'
      ? new TextEncoder().encode(encoded).byteLength
      : encoded.length;
  }

  function create({withOfflineStore}) {
    function claim(deviceID, maxOperations, maxBytes) {
      return withOfflineStore(
        ['queue'],
        'readwrite',
        (stores) =>
          new Promise((resolve, reject) => {
            const batch = [];
            const revisionNoteIDs = new Set();
            const request = stores.queue.index('client_sequence').openCursor();
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              resolve(batch);
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor || batch.length >= maxOperations) {
                finish();
                return;
              }
              const operation = cursor.value;
              const isRevisionOperation =
                ['note.save', 'note.delete', 'note.pin'].includes(operation.type) &&
                operation.note_id;
              if (isRevisionOperation && revisionNoteIDs.has(operation.note_id)) {
                finish();
                return;
              }
              const operations = [...batch.map(serialize), serialize(operation)];
              const requestBytes = encodedByteLength({device_id: deviceID, operations});
              if (batch.length && requestBytes > maxBytes) {
                finish();
                return;
              }
              if (!operation.attempted_at) {
                operation.attempted_at = new Date().toISOString();
                cursor.update(operation);
              }
              batch.push(operation);
              if (isRevisionOperation) revisionNoteIDs.add(operation.note_id);
              if (batch.length >= maxOperations) finish();
              else cursor.continue();
            };
          }),
      );
    }

    return {claim};
  }

  root.VylkSyncBatch = {create, encodedByteLength, serialize};
})(typeof window !== 'undefined' ? window : globalThis);
