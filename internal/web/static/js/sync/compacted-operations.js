(function (global) {
  'use strict';

  function create({
    api,
    clearCurrentNote,
    getCurrentNoteID,
    isDirty,
    loadDashboard,
    queueOperationPayload,
    removePendingOperation,
    requestValue,
    setDashboardRoute,
    updateOpenNote,
    withOfflineStore,
  }) {
    async function reconcile(operation, remote) {
      return withOfflineStore(['notes', 'queue'], 'readwrite', async (stores) => {
        const queued = await requestValue(stores.queue.get(operation.id));
        if (
          !queued ||
          queued.op_id !== operation.op_id ||
          queued.client_sequence !== operation.client_sequence ||
          queueOperationPayload(queued) !== queueOperationPayload(operation)
        ) {
          throw new Error('compacted sync operation changed before local reconciliation');
        }
        const operations = await requestValue(
          stores.queue.index('note_id').getAll(operation.note_id),
        );
        let hasLater = false;
        for (const later of operations) {
          if (later.id === operation.id || later.client_sequence < 1 || later.attempted_at)
            continue;
          if (
            later.type !== 'note.save' &&
            later.type !== 'note.delete' &&
            later.type !== 'note.pin'
          )
            continue;
          if (remote) {
            later.base_revision = remote.revision;
            if (later.note) {
              later.note.base_revision = remote.revision;
              later.note.base_content = remote.content;
              later.note.base_title = remote.title;
              later.note.base_tags = remote.tags;
            }
            await requestValue(stores.queue.put(later));
          }
          hasLater = true;
        }
        const local = await requestValue(stores.notes.get(operation.note_id));
        if (remote && !hasLater) {
          await requestValue(
            stores.notes.put({
              ...local,
              ...remote,
              pending: false,
              base_revision: null,
              base_content: null,
              base_title: null,
              base_tags: null,
            }),
          );
        } else if (remote && hasLater) {
          await requestValue(
            stores.notes.put({
              ...remote,
              ...local,
              revision: remote.revision,
              pending: true,
              base_revision: remote.revision,
              base_content: remote.content,
              base_title: remote.title,
              base_tags: remote.tags,
            }),
          );
        } else if (!remote && !hasLater) {
          await requestValue(stores.notes.delete(operation.note_id));
        }
        await requestValue(stores.queue.delete(operation.id));
        return hasLater;
      });
    }

    async function acknowledge(operation) {
      if (!['note.save', 'note.delete', 'note.pin'].includes(operation.type)) {
        const removed = await removePendingOperation(operation.id, operation);
        if (!removed) throw new Error('compacted sync operation changed before acknowledgement');
        return;
      }
      let remote = null;
      try {
        remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`, {
          syncRequest: true,
          throwOnError: true,
        });
      } catch (error) {
        if (error?.responseStatus !== 404) throw error;
      }
      const hasLater = await reconcile(operation, remote);
      if (!hasLater && remote) updateOpenNote(remote);
      if (!hasLater && !remote && getCurrentNoteID() === operation.note_id && !isDirty()) {
        clearCurrentNote();
        await loadDashboard({sync: false});
        setDashboardRoute({replace: true});
      }
    }

    return {acknowledge, reconcile};
  }

  global.VylkCompactedOperations = {create};
})(typeof window !== 'undefined' ? window : globalThis);
