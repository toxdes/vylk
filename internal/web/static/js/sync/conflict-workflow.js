(function (global) {
  'use strict';

  function create({
    api,
    getCurrentNoteID,
    getLocalNote,
    isDashboardVisible,
    isDirty,
    latestLaterOperation,
    mergeVersions,
    newNoteID,
    pendingOperationsForNote,
    putLocalNote,
    queueOperation,
    queueOperationPayload,
    refreshDashboard,
    removeLocalNote,
    removePendingOperation,
    requestValue,
    saveCurrentNote,
    selectNoteID,
    setNoteRoute,
    setUnresolvedConflict,
    showNoteInEditor,
    showResolver,
    supersedeOperations,
    unresolvedConflictKey,
    updateOpenNote,
    withOfflineStore,
  }) {
    async function loadRemoteNote(noteID) {
      try {
        return await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true});
      } catch (error) {
        if (error?.responseStatus === 404) return null;
        throw error;
      }
    }

    function base(local, operation) {
      return {
        title: local.base_title ?? operation.note?.base_title ?? operation.note?.title ?? '',
        tags: local.base_tags ?? operation.note?.base_tags ?? operation.note?.tags ?? '',
        content: local.base_content ?? operation.note?.base_content ?? '',
      };
    }

    async function merge(operation, remote) {
      if (operation.type !== 'note.save' || !operation.note || !mergeVersions) return false;
      if (getCurrentNoteID() === operation.note_id && isDirty()) await saveCurrentNote(false);
      const local = await getLocalNote(operation.note_id);
      if (!local || !remote) return false;
      if (local.base_title === undefined || local.base_tags === undefined) return false;
      const merged = mergeVersions(base(local, operation), local, remote);
      if (!merged) return false;
      const queued = await pendingOperationsForNote(operation.note_id);
      const laterPin = latestLaterOperation(queued, operation, 'note.pin');
      const mergedLocal = {
        ...remote,
        ...merged,
        ...(laterPin
          ? {
              pinned: Boolean(laterPin.pinned),
              pin_order: laterPin.pinned ? local.pin_order || 0 : 0,
            }
          : {}),
        updated_at: new Date().toISOString(),
        pending: true,
        base_revision: remote.revision,
        base_content: remote.content || '',
        base_title: remote.title || '',
        base_tags: remote.tags || '',
      };
      await putLocalNote(mergedLocal);
      await supersedeOperations(operation.note_id, operation.client_sequence);
      await removePendingOperation(operation.id, operation);
      await queueOperation({
        type: 'note.save',
        note_id: mergedLocal.id,
        base_revision: remote.revision,
        note: mergedLocal,
      });
      updateOpenNote(mergedLocal);
      return true;
    }

    async function preserveCopy(operation, local, remote) {
      if (remote)
        await putLocalNote({
          ...remote,
          pending: false,
          base_revision: null,
          base_content: null,
          base_title: null,
          base_tags: null,
        });
      else await removeLocalNote(operation.note_id);
      if (local && operation.type === 'note.save') {
        const conflictID = newNoteID();
        const now = new Date().toISOString();
        const conflict = {
          id: conflictID,
          title: `${local.title || 'Untitled'} (conflict copy)`,
          filename: `${conflictID}.md`,
          tags: local.tags || '',
          content: local.content || '',
          base_content: '',
          created_at: now,
          updated_at: now,
          revision: 0,
          base_revision: 0,
          base_title: '',
          base_tags: '',
          pending: true,
        };
        await putLocalNote(conflict);
        await queueOperation({
          type: 'note.save',
          note_id: conflictID,
          base_revision: 0,
          note: conflict,
        });
        if (getCurrentNoteID() === operation.note_id) {
          selectNoteID(conflictID);
          updateOpenNote(conflict);
        }
      }
      await supersedeOperations(operation.note_id, operation.client_sequence);
      await removePendingOperation(operation.id, operation);
    }

    async function createRemoteDeletion(operation, local) {
      const preserved = {
        ...local,
        id: operation.note_id,
        title: local.title || 'Untitled',
        tags: local.tags || '',
        content: local.content || '',
      };
      const conflict = {
        kind: 'remote-deleted',
        note_id: operation.note_id,
        created_at: new Date().toISOString(),
        base: base(preserved, operation),
        local: preserved,
        remote: null,
      };
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        const queued = await requestValue(stores.queue.get(operation.id));
        if (
          !queued ||
          queued.op_id !== operation.op_id ||
          queued.client_sequence !== operation.client_sequence ||
          queueOperationPayload(queued) !== queueOperationPayload(operation)
        ) {
          throw new Error('conflicting sync operation changed before deletion resolution');
        }
        await requestValue(stores.notes.put({...preserved, pending: false}));
        await requestValue(
          stores.state.put({key: unresolvedConflictKey(operation.note_id), value: conflict}),
        );
        const laterOperations = await requestValue(
          stores.queue.index('note_id').getAll(operation.note_id),
        );
        for (const later of laterOperations) {
          if (
            later.id !== operation.id &&
            later.client_sequence > operation.client_sequence &&
            !later.attempted_at
          ) {
            later.type = 'noop';
            await requestValue(stores.queue.put(later));
          }
        }
        await requestValue(stores.queue.delete(operation.id));
      });
    }

    async function prepare(operation, remote) {
      if (getCurrentNoteID() === operation.note_id && isDirty()) await saveCurrentNote(false);
      const local = await getLocalNote(operation.note_id);
      if (!remote && operation.type === 'note.save' && (local || operation.note)) {
        await createRemoteDeletion(operation, local || operation.note);
        return 'remote-deleted';
      }
      if (!local || !remote || operation.type !== 'note.save') {
        await preserveCopy(operation, local, remote);
        return false;
      }
      const queued = await pendingOperationsForNote(operation.note_id);
      const laterPin = latestLaterOperation(queued, operation, 'note.pin');
      const resolvedRemote = laterPin
        ? {
            ...remote,
            pinned: Boolean(laterPin.pinned),
            pin_order: laterPin.pinned ? local.pin_order || 0 : 0,
          }
        : remote;
      const conflict = {
        note_id: operation.note_id,
        created_at: new Date().toISOString(),
        base: base(local, operation),
        local: {title: local.title || '', tags: local.tags || '', content: local.content || ''},
        remote: {
          ...resolvedRemote,
          title: remote.title || '',
          tags: remote.tags || '',
          content: remote.content || '',
          revision: remote.revision || 0,
          filename: remote.filename || '',
        },
      };
      await setUnresolvedConflict(conflict);
      await putLocalNote({
        ...resolvedRemote,
        pending: false,
        base_revision: null,
        base_content: null,
        base_title: null,
        base_tags: null,
      });
      await supersedeOperations(operation.note_id, operation.client_sequence);
      await removePendingOperation(operation.id, operation);
      if (isDirty()) await saveCurrentNote(false);
      showNoteInEditor(remote);
      setNoteRoute(remote.id);
      showResolver(conflict);
      if (isDashboardVisible()) void refreshDashboard();
      return true;
    }

    return {loadRemoteNote, merge, prepare};
  }

  global.VylkConflictWorkflow = {create};
})(typeof window !== 'undefined' ? window : globalThis);
