(function (global) {
  'use strict';

  function create({
    clearCurrentNote,
    closeResolver,
    getConflict,
    isCurrentNote,
    isDashboardVisible,
    loadDashboard,
    newNoteID,
    queueOperationInStores,
    refreshDashboard,
    requestValue,
    scheduleSync,
    selectNote,
    setDashboardRoute,
    setNoteRoute,
    showToast,
    unresolvedConflictKey,
    withOfflineStore,
  }) {
    async function save(noteID, resolution) {
      const conflict = noteID && (await getConflict(noteID));
      if (!conflict) return;
      const resolved = {
        ...conflict.remote,
        id: noteID,
        title: resolution.title.trim() || 'Untitled',
        tags: resolution.tags.trim(),
        content: resolution.content,
        updated_at: new Date().toISOString(),
        pending: true,
        base_revision: conflict.remote.revision,
        base_title: conflict.remote.title || '',
        base_tags: conflict.remote.tags || '',
        base_content: conflict.remote.content || '',
      };
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.put(resolved));
        await queueOperationInStores(stores, {
          type: 'note.save',
          note_id: noteID,
          base_revision: resolved.base_revision,
          note: resolved,
        });
        await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
      });
      selectNote(noteID, resolved);
      closeResolver();
      showToast('Conflict resolution saved.', 'success');
      if (isDashboardVisible()) void refreshDashboard();
      scheduleSync();
    }

    async function keepCopy(noteID) {
      const conflict = noteID && (await getConflict(noteID));
      if (!conflict) return;
      const copyID = newNoteID();
      const now = new Date().toISOString();
      const copy = {
        id: copyID,
        title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
        filename: `${copyID}.md`,
        tags: conflict.local.tags || '',
        content: conflict.local.content || '',
        created_at: now,
        updated_at: now,
        revision: 0,
        base_revision: 0,
        base_title: '',
        base_tags: '',
        base_content: '',
        pending: true,
      };
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.put(copy));
        await queueOperationInStores(stores, {
          type: 'note.save',
          note_id: copy.id,
          base_revision: 0,
          note: copy,
        });
        await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
      });
      selectNote(copy.id, copy);
      setNoteRoute(copy.id);
      closeResolver();
      showToast('Your version was saved as a separate note.', 'success');
      if (isDashboardVisible()) void refreshDashboard();
      scheduleSync();
    }

    async function keepDeletedCopy(noteID) {
      const conflict = noteID && (await getConflict(noteID));
      if (!conflict || conflict.kind !== 'remote-deleted') return;
      const copyID = newNoteID();
      const now = new Date().toISOString();
      const copy = {
        ...conflict.local,
        id: copyID,
        title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
        filename: `${copyID}.md`,
        created_at: conflict.local.created_at || now,
        updated_at: now,
        revision: 0,
        base_revision: 0,
        base_title: '',
        base_tags: '',
        base_content: '',
        pending: true,
      };
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.put(copy));
        await queueOperationInStores(stores, {
          type: 'note.save',
          note_id: copyID,
          base_revision: 0,
          note: copy,
        });
        await requestValue(stores.notes.delete(noteID));
        await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
      });
      selectNote(copyID, copy);
      setNoteRoute(copyID);
      closeResolver();
      showToast('Your changes were saved as a new note.', 'success');
      if (isDashboardVisible()) void refreshDashboard();
      scheduleSync();
    }

    async function acceptDeletion(noteID) {
      const conflict = noteID && (await getConflict(noteID));
      if (!conflict || conflict.kind !== 'remote-deleted') return;
      await withOfflineStore(['notes', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.delete(noteID));
        await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
      });
      if (isCurrentNote(noteID)) {
        clearCurrentNote();
        await loadDashboard({sync: false});
        setDashboardRoute({replace: true});
      }
      closeResolver();
      showToast('The remote deletion was accepted.', 'success');
      scheduleSync();
    }

    return {acceptDeletion, keepCopy, keepDeletedCopy, save};
  }

  global.VylkConflictActions = {create};
})(typeof window !== 'undefined' ? window : globalThis);
