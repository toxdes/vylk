(function (global) {
  'use strict';

  function create({
    autoSaveEnabled,
    editorVisible,
    getConflict,
    getLocalNote,
    getSession,
    isRestoringRoute,
    newNoteID,
    noteIDFromLocation,
    persistConflict,
    persistLocalNote,
    readEditor,
    setIdleStatus,
    setNoteID,
    setNoteRoute,
    setPersistedState,
    showToast,
    syncNow,
    window,
  }) {
    let saveTimer = null;
    let localSaveTimer = null;
    let localSavePromise = null;
    let localSaveRequested = false;
    let syncCompletionPromise = Promise.resolve(true);

    function snapshotIsCurrent(snapshot) {
      const session = getSession();
      const editor = readEditor();
      return (
        session.generation === snapshot.sessionGeneration &&
        session.noteID === snapshot.noteID &&
        editor.title === snapshot.title &&
        editor.tags === snapshot.tags &&
        editor.content === snapshot.content
      );
    }

    function finishPersist(snapshot, baseRevision) {
      if (!snapshotIsCurrent(snapshot)) return;
      setPersistedState({
        baseRevision,
        savedSnapshot: {title: snapshot.title, tags: snapshot.tags, content: snapshot.content},
      });
      if (!isRestoringRoute() && noteIDFromLocation() !== snapshot.noteID) {
        setNoteRoute(snapshot.noteID);
      }
      void setIdleStatus();
    }

    async function persistSnapshot(snapshot) {
      const session = getSession();
      if (
        snapshotIsCurrent(snapshot) &&
        snapshot.title === session.savedSnapshot.title &&
        snapshot.tags === session.savedSnapshot.tags &&
        snapshot.content === session.savedSnapshot.content
      ) {
        setPersistedState({savedSnapshot: session.savedSnapshot});
        return true;
      }

      const existing = await getLocalNote(snapshot.noteID);
      const baseRevision = existing?.pending
        ? existing.base_revision
        : (snapshot.baseRevision ?? 0);
      const now = new Date().toISOString();
      const local = {
        ...existing,
        title: snapshot.title,
        tags: snapshot.tags,
        content: snapshot.content,
        id: snapshot.noteID,
        filename: existing?.filename || `${snapshot.noteID}.md`,
        revision: existing?.revision ?? snapshot.revision ?? 0,
        base_revision: baseRevision,
        base_content: existing?.pending ? (existing.base_content ?? '') : existing?.content || '',
        base_title: existing?.pending
          ? (existing.base_title ?? existing.title ?? '')
          : existing?.title || '',
        base_tags: existing?.pending
          ? (existing.base_tags ?? existing.tags ?? '')
          : existing?.tags || '',
        pending: true,
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      const unresolved = await getConflict(snapshot.noteID);
      if (unresolved?.kind === 'remote-deleted') {
        const conflictLocal = {...local, pending: false};
        try {
          await persistConflict(snapshot.noteID, unresolved, conflictLocal);
        } catch (error) {
          console.error('local conflict update failed', error);
          showToast('Could not save locally. Free browser storage and try again.', 'warning');
          return false;
        }
        finishPersist(snapshot, null);
        return true;
      }
      try {
        await persistLocalNote(local, {
          type: 'note.save',
          note_id: snapshot.noteID,
          base_revision: baseRevision,
          note: local,
        });
      } catch (error) {
        console.error('local save failed', error);
        showToast('Could not save locally. Free browser storage and try again.', 'warning');
        return false;
      }
      finishPersist(snapshot, baseRevision);
      return true;
    }

    function save(trySync = true) {
      localSaveRequested = true;
      if (!localSavePromise) {
        localSavePromise = (async () => {
          let result = true;
          while (localSaveRequested) {
            localSaveRequested = false;
            const session = getSession();
            const noteID = session.noteID || newNoteID();
            if (!session.noteID) setNoteID(noteID);
            const snapshot = {
              ...readEditor(),
              noteID,
              revision: session.revision,
              baseRevision: session.baseRevision ?? session.revision ?? 0,
              sessionGeneration: session.generation,
            };
            result = await persistSnapshot(snapshot);
          }
          return result;
        })().finally(() => {
          localSavePromise = null;
        });
      }
      const currentSave = localSavePromise;
      if (!trySync) return currentSave;
      syncCompletionPromise = syncCompletionPromise
        .catch((error) => {
          console.warn('previous sync request failed', error);
          return false;
        })
        .then(() => currentSave)
        .then((saved) => (saved ? syncNow() : false));
      return syncCompletionPromise;
    }

    function schedule() {
      if (localSaveTimer) window.clearTimeout(localSaveTimer);
      localSaveTimer = window.setTimeout(() => {
        localSaveTimer = null;
        if (getSession().isDirty) void save(false);
      }, 250);
      if (!autoSaveEnabled()) return;
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        if (editorVisible()) void save();
      }, 2000);
    }

    function cancelScheduled() {
      if (saveTimer) window.clearTimeout(saveTimer);
      if (localSaveTimer) window.clearTimeout(localSaveTimer);
      saveTimer = null;
      localSaveTimer = null;
    }

    return {
      cancelAutoSave: () => {
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = null;
      },
      cancelScheduled,
      hasPendingSave: () => Boolean(localSavePromise),
      save,
      schedule,
    };
  }

  global.VylkNoteSaver = {create};
})(typeof window !== 'undefined' ? window : globalThis);
