(function (root) {
  'use strict';

  function create({
    databaseName = 'vylk-offline',
    databaseVersion = 4,
    indexedDB: configuredIndexedDB,
    createID,
    onBlocked = () => {},
    onFailure = () => {},
    onSyncRequested = () => {},
    beforeClear = () => {},
  }) {
    const operationIDPattern = /^[A-Za-z0-9_-]{1,128}$/;
    const {requestValue, transactionComplete, withTransaction} = root.VylkIndexedDB;
    let databasePromise;
    const databaseAPI = () => configuredIndexedDB || root.indexedDB;

    function openOfflineDB() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        // Do not request a fixed database version here. A browser may have a
        // newer local schema from a prior build; opening it with an older version
        // fails before the app can read its offline notes.
        const request = databaseAPI().open(databaseName, databaseVersion);
        request.onupgradeneeded = (event) => {
          const db = request.result;
          if (event.oldVersion < 1 && !db.objectStoreNames.contains('notes')) {
            db.createObjectStore('notes', {keyPath: 'id'});
          }
          if (event.oldVersion < 1 && !db.objectStoreNames.contains('queue')) {
            const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
            queue.createIndex('note_id', 'note_id', {unique: false});
          }
          if (event.oldVersion < 1 && !db.objectStoreNames.contains('state')) {
            db.createObjectStore('state', {keyPath: 'key'});
          }
          if (event.oldVersion < 3 && db.objectStoreNames.contains('queue')) {
            const queue = event.target.transaction.objectStore('queue');
            if (!queue.indexNames.contains('note_id'))
              queue.createIndex('note_id', 'note_id', {unique: false});
            if (!queue.indexNames.contains('client_sequence'))
              queue.createIndex('client_sequence', 'client_sequence', {unique: false});
          }
        };
        request.onsuccess = async () => {
          request.result.onversionchange = () => {
            request.result.close();
            databasePromise = undefined;
          };
          try {
            await repairOfflineQueue(request.result);
            resolve(request.result);
          } catch (error) {
            request.result.close();
            databasePromise = undefined;
            reportOfflineStorageFailure(error);
            reject(error);
          }
        };
        request.onerror = () => {
          databasePromise = undefined;
          const error =
            request.error?.name === 'VersionError'
              ? new Error('offline data was created by a newer app version')
              : request.error;
          reportOfflineStorageFailure(error);
          reject(error);
        };
        request.onblocked = onBlocked;
      });
      return databasePromise;
    }

    function reportOfflineStorageFailure(error) {
      onFailure(error);
    }

    // A previous development build could leave an operation without the replay
    // metadata introduced in version 2. Repair it in place: the note snapshot is
    // kept, and the operation can be acknowledged normally instead of making a
    // healthy server look offline forever.
    async function repairOfflineQueue(db) {
      if (!db.objectStoreNames.contains('queue') || !db.objectStoreNames.contains('state')) {
        throw new Error('offline database is missing required stores');
      }

      // Repair in two cursor passes instead of loading the complete queue into
      // memory. The queue can contain a large backlog after a long offline period.
      let largestSequence = 0;
      await withQueueCursor(db, 'readonly', (operation) => {
        if (
          Number.isSafeInteger(operation.client_sequence) &&
          operation.client_sequence > largestSequence
        ) {
          largestSequence = operation.client_sequence;
        }
      });

      const transaction = db.transaction(['queue', 'state'], 'readwrite');
      const queue = transaction.objectStore('queue');
      const state = transaction.objectStore('state');
      const complete = transactionComplete(transaction);
      const savedSequenceRequest = state.get('clientSequence');
      savedSequenceRequest.onsuccess = () => {
        const previousSequence = Number(savedSequenceRequest.result?.value || 0);
        largestSequence = Math.max(largestSequence, previousSequence);
        const cursorRequest = queue.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const operation = cursor.value;
            if (!Number.isSafeInteger(operation.client_sequence) || operation.client_sequence < 1) {
              operation.client_sequence = ++largestSequence;
            }
            if (!operationIDPattern.test(operation.op_id || ''))
              operation.op_id = `legacy-${operation.id}`;
            if (operation.type === 'save') operation.type = 'note.save';
            if (operation.type === 'delete') operation.type = 'note.delete';
            if (operation.type === 'preferences') operation.type = 'prefs.save';
            if (!operation.type)
              operation.type =
                operation.kind === 'save'
                  ? 'note.save'
                  : operation.kind === 'delete'
                    ? 'note.delete'
                    : 'prefs.save';
            if (operation.type === 'note.save' && !operation.note) operation.note = operation.data;
            if (operation.type === 'note.save' && !operation.note_id)
              operation.note_id = operation.note?.id;
            if (operation.type === 'prefs.save') operation.note_id = '__prefs__';
            queue.put(operation);
            cursor.continue();
            return;
          }
          state.put({key: 'clientSequence', value: Math.max(previousSequence, largestSequence)});
        };
      };
      await complete;
    }

    function withQueueCursor(db, mode, visit) {
      const transaction = db.transaction(['queue'], mode);
      const cursorRequest = transaction.objectStore('queue').openCursor();
      const complete = transactionComplete(transaction);
      return new Promise((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            complete.then(resolve, reject);
            return;
          }
          visit(cursor.value, cursor);
          cursor.continue();
        };
      });
    }

    async function withOfflineStore(names, mode, work) {
      try {
        return await withTransaction(openOfflineDB, names, mode, work);
      } catch (error) {
        if (
          error?.name === 'QuotaExceededError' ||
          error?.name === 'InvalidStateError' ||
          error?.name === 'TransactionInactiveError'
        ) {
          reportOfflineStorageFailure(error);
        }
        throw error;
      }
    }

    function getLocalNote(id) {
      return withOfflineStore(['notes'], 'readonly', (stores) =>
        requestValue(stores.notes.get(id)),
      );
    }

    async function getOfflineDatabaseInfo() {
      const db = await openOfflineDB();
      return {
        version: db.version,
        queueIndexes: [...db.transaction('queue', 'readonly').objectStore('queue').indexNames],
      };
    }

    function putLocalNote(note) {
      return withOfflineStore(['notes'], 'readwrite', (stores) =>
        requestValue(stores.notes.put(note)),
      );
    }

    function removeLocalNote(id) {
      return withOfflineStore(['notes'], 'readwrite', (stores) =>
        requestValue(stores.notes.delete(id)),
      );
    }

    async function getLocalNotes() {
      const notes = await getAllLocalNotes();
      return notes
        .filter((note) => !note.deleted)
        .sort((a, b) => {
          if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
          if (a.pinned && b.pinned && Number(a.pin_order || 0) !== Number(b.pin_order || 0))
            return Number(b.pin_order || 0) - Number(a.pin_order || 0);
          return (
            (b.updated_at || '').localeCompare(a.updated_at || '') ||
            String(a.id).localeCompare(String(b.id))
          );
        });
    }

    async function nextLocalPinOrder() {
      return withOfflineStore(['state'], 'readwrite', async (stores) => {
        const current = Number((await requestValue(stores.state.get('pinOrder')))?.value || 0);
        const next = Math.max(Date.now(), current + 1);
        await requestValue(stores.state.put({key: 'pinOrder', value: next}));
        return next;
      });
    }

    function getAllLocalNotes() {
      return withOfflineStore(['notes'], 'readonly', (stores) =>
        requestValue(stores.notes.getAll()),
      );
    }

    function getOfflineState(key) {
      return withOfflineStore(['state'], 'readonly', async (stores) => {
        const value = await requestValue(stores.state.get(key));
        return value && value.value;
      });
    }

    function setOfflineState(key, value) {
      return withOfflineStore(['state'], 'readwrite', (stores) =>
        requestValue(stores.state.put({key, value})),
      );
    }

    function unresolvedConflictKey(noteID) {
      return `unresolvedConflict:${noteID}`;
    }

    function rejectedSyncKey(noteID) {
      return `rejectedSync:${noteID}`;
    }

    function getUnresolvedConflict(noteID) {
      return getOfflineState(unresolvedConflictKey(noteID));
    }

    function setUnresolvedConflict(conflict) {
      return setOfflineState(unresolvedConflictKey(conflict.note_id), conflict);
    }

    function mergeQueuedPreferencePayload(existing, operation) {
      const existingPatch = existing.prefs?._sync_patch;
      const nextPatch = operation.prefs?._sync_patch;
      if (!existingPatch || !nextPatch) {
        existing.base_revision = operation.base_revision;
        existing.prefs = operation.prefs;
        return;
      }
      const patch = {...existingPatch};
      const base = {...(existing.prefs?._sync_base || {})};
      const nextBase = operation.prefs?._sync_base || {};
      Object.entries(nextPatch).forEach(([key, value]) => {
        if (!(key in base)) base[key] = nextBase[key];
        patch[key] = value;
      });
      existing.prefs = {...operation.prefs, _sync_patch: patch, _sync_base: base};
    }

    async function queueOperationInStores(stores, operation) {
      if (
        operation.type === 'note.save' ||
        operation.type === 'note.delete' ||
        operation.type === 'note.pin' ||
        operation.type === 'prefs.save'
      ) {
        await requestValue(stores.state.delete(rejectedSyncKey(operation.note_id)));
      }
      if (
        operation.type === 'note.save' ||
        operation.type === 'note.pin' ||
        operation.type === 'prefs.save'
      ) {
        const queued = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
        if (operation.type === 'note.pin') {
          const initialSave = queued
            .filter(
              (item) =>
                !item.attempted_at &&
                item.type === 'note.save' &&
                Number(item.base_revision || 0) === 0,
            )
            .sort((left, right) => right.client_sequence - left.client_sequence)[0];
          if (initialSave?.note) {
            initialSave.note.pinned = Boolean(operation.pinned);
            initialSave.note.pin_order = operation.pin_order || 0;
            await requestValue(stores.queue.put(initialSave));
            return;
          }
        }
        const existing = queued
          // Once a request has been attempted, its op_id/client_sequence and
          // payload are immutable. A later edit must get a new queue identity so
          // an acknowledgement for the old payload cannot remove the new edit.
          .filter((item) => !item.attempted_at && item.type === operation.type)
          .sort((left, right) => right.client_sequence - left.client_sequence)[0];
        if (existing) {
          if (operation.type === 'prefs.save') mergeQueuedPreferencePayload(existing, operation);
          else if (operation.type === 'note.pin') {
            existing.base_revision = operation.base_revision;
            existing.pinned = operation.pinned;
          } else {
            existing.base_revision = operation.base_revision;
            existing.note = operation.note;
            existing.prefs = operation.prefs;
          }
          await requestValue(stores.queue.put(existing));
          return;
        }
      }
      const state = await requestValue(stores.state.get('clientSequence'));
      const sequence = Number(state?.value || 0) + 1;
      operation.client_sequence = sequence;
      operation.op_id = createID();
      await requestValue(stores.queue.add(operation));
      await requestValue(stores.state.put({key: 'clientSequence', value: sequence}));
    }

    function queueOperation(operation) {
      return withOfflineStore(['queue', 'state'], 'readwrite', (stores) =>
        queueOperationInStores(stores, operation),
      ).then((result) => {
        onSyncRequested();
        return result;
      });
    }

    async function saveLocalNoteAndQueue(note, operation) {
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.put(note));
        await queueOperationInStores(stores, operation);
      });
      onSyncRequested();
    }

    async function removeLocalNoteAndQueue(id, operation) {
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.delete(id));
        await queueOperationInStores(stores, operation);
      });
      onSyncRequested();
    }

    function removeLocalNoteAndSupersede(id, afterSequence) {
      return withOfflineStore(['notes', 'queue'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.delete(id));
        const operations = await requestValue(stores.queue.index('note_id').getAll(id));
        operations.forEach((operation) => {
          if (operation.client_sequence > afterSequence && !operation.attempted_at) {
            operation.type = 'noop';
            stores.queue.put(operation);
          }
        });
      });
    }

    function pendingOperations() {
      return withOfflineStore(['queue'], 'readonly', async (stores) => {
        const items = await requestValue(stores.queue.getAll());
        return items.sort((a, b) => a.client_sequence - b.client_sequence);
      });
    }

    async function repairSyncSequenceGap(expectedSequence) {
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) return false;
      return withOfflineStore(['queue', 'state'], 'readwrite', async (stores) => {
        const operations = (await requestValue(stores.queue.getAll())).sort(
          (left, right) => left.client_sequence - right.client_sequence || left.id - right.id,
        );
        const unsent = operations.filter(
          (operation) => operation.client_sequence >= expectedSequence,
        );
        if (!unsent.length) return false;
        let sequence = expectedSequence;
        for (const operation of unsent) {
          // The server returned 409 before applying this request, so these rows
          // are safe to re-arm and close the local sequence gap. A normal
          // acknowledgement never changes an attempted row.
          if (operation.client_sequence !== sequence || operation.attempted_at) {
            operation.client_sequence = sequence;
            delete operation.attempted_at;
            await requestValue(stores.queue.put(operation));
          }
          sequence++;
        }
        // These operations have not reached the server (it explicitly requested
        // expectedSequence), so it is safe to close the local numbering gap and
        // let future edits continue immediately after the repaired queue.
        await requestValue(stores.state.put({key: 'clientSequence', value: sequence - 1}));
        return true;
      });
    }

    async function hasPendingOperation(noteID) {
      return withOfflineStore(['queue', 'state'], 'readonly', async (stores) => {
        const item = await requestValue(stores.queue.index('note_id').get(noteID));
        if (item) return true;
        return Boolean(await requestValue(stores.state.get(rejectedSyncKey(noteID))));
      });
    }

    function pendingOperationsForNote(noteID) {
      return withOfflineStore(['queue'], 'readonly', (stores) =>
        requestValue(stores.queue.index('note_id').getAll(noteID)),
      );
    }

    function latestLaterOperation(operations, current, type) {
      return operations
        .filter(
          (operation) =>
            operation.client_sequence > current.client_sequence && operation.type === type,
        )
        .sort((left, right) => right.client_sequence - left.client_sequence)[0];
    }

    async function claimQueueOperation(id) {
      return withOfflineStore(['queue'], 'readwrite', async (stores) => {
        const operation = await requestValue(stores.queue.get(id));
        if (!operation) return null;
        if (!operation.attempted_at) {
          operation.attempted_at = new Date().toISOString();
          await requestValue(stores.queue.put(operation));
        }
        return operation;
      });
    }

    function queueOperationPayload(operation) {
      return JSON.stringify({
        type: operation.type,
        note_id: operation.note_id,
        base_revision: operation.base_revision,
        note: operation.note && {
          id: operation.note.id,
          title: operation.note.title,
          tags: operation.note.tags,
          content: operation.note.content,
          base_revision: operation.note.base_revision,
          base_content: operation.note.base_content,
          base_title: operation.note.base_title,
          base_tags: operation.note.base_tags,
          pinned: operation.note.pinned,
          pin_order: operation.note.pin_order,
        },
        pinned: operation.pinned,
        prefs: operation.prefs || null,
      });
    }

    function removePendingOperationIfIdentityMatches(id, expectedOperation) {
      return withOfflineStore(['queue'], 'readwrite', async (stores) => {
        const operation = await requestValue(stores.queue.get(id));
        if (
          !operation ||
          operation.op_id !== expectedOperation.op_id ||
          operation.client_sequence !== expectedOperation.client_sequence ||
          queueOperationPayload(operation) !== queueOperationPayload(expectedOperation)
        )
          return false;
        await requestValue(stores.queue.delete(id));
        return true;
      });
    }

    async function quarantineQueueOperation(operation, reason) {
      return withOfflineStore(['queue', 'state'], 'readwrite', async (stores) => {
        const queued = await requestValue(stores.queue.get(operation.id));
        if (
          !queued ||
          queued.op_id !== operation.op_id ||
          queued.client_sequence !== operation.client_sequence ||
          queueOperationPayload(queued) !== queueOperationPayload(operation)
        )
          return false;
        await requestValue(
          stores.state.put({
            key: rejectedSyncKey(operation.note_id),
            value: {
              op_id: operation.op_id,
              client_sequence: operation.client_sequence,
              note_id: operation.note_id,
              type: operation.type,
              reason: reason || 'server rejected the operation',
              rejected_at: new Date().toISOString(),
            },
          }),
        );
        queued.type = 'noop';
        delete queued.note;
        delete queued.prefs;
        delete queued.base_revision;
        queued.rejected = true;
        queued.rejected_reason = reason || 'server rejected the operation';
        await requestValue(stores.queue.put(queued));
        return true;
      });
    }

    async function syncDeviceID() {
      let deviceID = await getOfflineState('deviceID');
      if (!deviceID) {
        deviceID = `device_${createID()}`;
        await setOfflineState('deviceID', deviceID);
      }
      return deviceID;
    }

    async function rebaseQueuedNoteOperations(noteID, acknowledgedID, revision, baseNote) {
      return withOfflineStore(['queue'], 'readwrite', async (stores) => {
        const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
        let hasLater = false;
        operations.forEach((operation) => {
          if (
            operation.id === acknowledgedID ||
            operation.client_sequence < 1 ||
            operation.attempted_at
          )
            return;
          if (
            operation.type === 'note.save' ||
            operation.type === 'note.delete' ||
            operation.type === 'note.pin'
          ) {
            operation.base_revision = revision;
            if (operation.note) {
              operation.note.base_revision = revision;
              operation.note.base_content = baseNote.content;
              operation.note.base_title = baseNote.title;
              operation.note.base_tags = baseNote.tags;
            }
            stores.queue.put(operation);
            hasLater = true;
          }
        });
        return hasLater;
      });
    }

    async function supersedeQueuedNoteOperations(noteID, afterSequence) {
      await withOfflineStore(['queue'], 'readwrite', async (stores) => {
        const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
        operations.forEach((operation) => {
          if (operation.client_sequence > afterSequence && !operation.attempted_at) {
            operation.type = 'noop';
            stores.queue.put(operation);
          }
        });
      });
    }

    async function clearOfflineData() {
      beforeClear();
      const dbPromise = databasePromise;
      databasePromise = undefined;
      if (dbPromise) {
        try {
          (await dbPromise).close();
        } catch (_) {}
      }
      await new Promise((resolve, reject) => {
        const request = databaseAPI().deleteDatabase(databaseName);
        const timeout = setTimeout(
          () => reject(new Error('local data cleanup is blocked by another app tab')),
          5000,
        );
        request.onerror = () => {
          clearTimeout(timeout);
          reject(request.error);
        };
        request.onsuccess = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }

    async function closeOfflineDatabaseConnection() {
      const dbPromise = databasePromise;
      databasePromise = undefined;
      if (!dbPromise) return;
      try {
        (await dbPromise).close();
      } catch (_) {}
    }

    return Object.freeze({
      claimQueueOperation,
      clearOfflineData,
      closeOfflineDatabaseConnection,
      getAllLocalNotes,
      getLocalNote,
      getLocalNotes,
      getOfflineDatabaseInfo,
      getOfflineState,
      getUnresolvedConflict,
      hasPendingOperation,
      latestLaterOperation,
      nextLocalPinOrder,
      openOfflineDB,
      pendingOperations,
      pendingOperationsForNote,
      putLocalNote,
      quarantineQueueOperation,
      queueOperation,
      queueOperationInStores,
      queueOperationPayload,
      rebaseQueuedNoteOperations,
      rejectedSyncKey,
      removeLocalNote,
      removeLocalNoteAndQueue,
      removeLocalNoteAndSupersede,
      removePendingOperationIfIdentityMatches,
      repairSyncSequenceGap,
      saveLocalNoteAndQueue,
      setOfflineState,
      setUnresolvedConflict,
      supersedeQueuedNoteOperations,
      syncDeviceID,
      unresolvedConflictKey,
      withOfflineStore,
    });
  }

  root.VylkOfflineStore = Object.freeze({create});
})(globalThis);
