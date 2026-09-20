(function (global) {
  'use strict';

  function create({
    api,
    cancelPreviewDelay,
    cancelPreviewRender,
    clearCurrentNote,
    closeModal,
    document,
    getCurrentNoteID,
    getLocalNote,
    getLocalNotes,
    getUnresolvedConflict,
    hasPendingOperation,
    isDashboardVisible,
    isDirty,
    isEditorVisible,
    loadDashboard,
    noteSaver,
    openPreferences,
    pendingOperations,
    putLocalNote,
    routes,
    saveCurrentNote,
    scheduleSync,
    setDashboardHydrationState,
    showConflictResolverFor,
    showNoteInEditor,
    showToast,
    startNewNote,
    unresolvedConflictIDs,
    window,
  }) {
    let restoringHistoryRoute = false;
    let backNavigationInFlight = false;
    const pendingHistoryRestoreResolvers = [];

    async function openNote(id, {route = 'push'} = {}) {
      noteSaver.cancelScheduled();
      cancelPreviewDelay();
      if (
        isEditorVisible() &&
        getCurrentNoteID() !== id &&
        (isDirty() || noteSaver.hasPendingSave())
      ) {
        const saved = await saveCurrentNote(false);
        if (saved === false) return false;
      }
      const data = await getLocalNote(id);
      if (!data) return false;
      showNoteInEditor(data);
      if (route === 'push') routes.setNote(id);
      else if (route === 'replace') routes.setNote(id, {replace: true});
      await showConflictResolverFor(id);
      return true;
    }

    function normalizeWikiTitle(title) {
      return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    }

    async function followWikiLink(title) {
      title = title.trim().replace(/\s+/g, ' ');
      if (!title) return;
      if (isDirty()) await saveCurrentNote(false);
      const existing = (await getLocalNotes()).find(
        (note) => normalizeWikiTitle(note.title || '') === normalizeWikiTitle(title),
      );
      if (existing) {
        await openNote(existing.id, {route: 'replace'});
        return;
      }
      startNewNote(title);
      await saveCurrentNote(false);
      showToast(`Created “${title}”.`, 'success');
      scheduleSync();
    }

    async function restoreNote(noteID, fetchRemote) {
      if (!noteID) return 'missing';
      if (await getLocalNote(noteID)) {
        await openNote(noteID, {route: 'none'});
        return 'loaded';
      }
      if (
        !fetchRemote ||
        (await hasPendingOperation(noteID)) ||
        (await getUnresolvedConflict(noteID))
      ) {
        return 'missing';
      }
      try {
        const remote = await api(`/api/notes/${encodeURIComponent(noteID)}`, {
          syncRequest: true,
          throwOnError: true,
        });
        await putLocalNote({
          ...remote,
          pending: false,
          base_revision: null,
          base_content: null,
          base_title: null,
          base_tags: null,
        });
        await openNote(noteID, {route: 'none'});
        return 'loaded';
      } catch (error) {
        return error?.responseStatus === 404 ? 'missing' : 'failed';
      }
    }

    async function restoreRoute({fetchRemote = false} = {}) {
      if (
        !routes.isPreferences() &&
        !document.querySelector('#prefs-modal').classList.contains('hidden')
      ) {
        closeModal(document.querySelector('#prefs-modal'));
        if (routes.isDashboard() && isDashboardVisible()) return;
        if (
          routes.isNote() &&
          isEditorVisible() &&
          getCurrentNoteID() === window.history.state.noteID
        ) {
          if (isDirty()) await saveCurrentNote(false);
          return;
        }
      }

      if (routes.isPreferences()) {
        const returnRoute = window.history.state?.returnRoute;
        const noteID = returnRoute?.screen === 'note' ? returnRoute.noteID : null;
        const result = await restoreNote(noteID, fetchRemote);
        if (result === 'loaded') {
          openPreferences({route: 'none'});
          return;
        }
        if (result === 'failed') return;
        if (noteID) routes.setDashboard({replace: true});
        clearCurrentNote();
        await loadDashboard({sync: false});
        if (!noteID) openPreferences({route: 'none'});
        return;
      }

      const noteID = routes.noteID();
      if (isEditorVisible() && isDirty()) await saveCurrentNote(false);
      const result = await restoreNote(noteID, fetchRemote);
      if (result === 'loaded' || result === 'failed') return;
      if (noteID) {
        routes.setDashboard({replace: true});
        showToast('That note is no longer available.', 'warning');
      }
      clearCurrentNote();
      await loadDashboard({sync: false});
    }

    async function restoreCachedStartup() {
      const noteID = routes.noteID();
      if (noteID && (await getLocalNote(noteID))) {
        await openNote(noteID, {route: 'none'});
        return;
      }
      setDashboardHydrationState((await getLocalNotes()).length ? 'ready' : 'loading');
      await loadDashboard({sync: false});
      const conflicts = await unresolvedConflictIDs();
      for (const conflictID of conflicts) {
        if ((await getLocalNote(conflictID)) && (await showConflictResolverFor(conflictID))) break;
      }
    }

    function schedulePendingSync() {
      void pendingOperations()
        .then((operations) => {
          if (operations.length) scheduleSync();
        })
        .catch((error) => console.warn('could not inspect pending sync operations', error));
    }

    document.querySelector('#new-note-btn').addEventListener('click', () => startNewNote());
    document.querySelector('#back-btn').addEventListener('click', async () => {
      if (backNavigationInFlight) return;
      backNavigationInFlight = true;
      try {
        noteSaver.cancelScheduled();
        cancelPreviewRender();
        await saveCurrentNote(false);
        clearCurrentNote();
        if (routes.isNote()) {
          const restored = new Promise((resolve) => pendingHistoryRestoreResolvers.push(resolve));
          window.history.back();
          schedulePendingSync();
          await restored;
          return;
        }
        await loadDashboard({sync: false});
        routes.setDashboard({replace: true});
        schedulePendingSync();
      } finally {
        backNavigationInFlight = false;
      }
    });
    document.querySelector('#back-btn').addEventListener('pointerdown', cancelPreviewRender, {
      passive: true,
    });
    window.addEventListener('popstate', () => {
      restoringHistoryRoute = true;
      void restoreRoute().finally(() => {
        restoringHistoryRoute = false;
        pendingHistoryRestoreResolvers.shift()?.();
      });
    });

    return {
      followWikiLink,
      openNote,
      restoreCachedStartup,
      restoreRoute,
      restoring: () => restoringHistoryRoute,
    };
  }

  global.VylkNavigationController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
