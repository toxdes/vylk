(function (global) {
  'use strict';

  function create({
    api,
    cancelPreviewDelay,
    cancelPreviewRender,
    clearCurrentNote,
    dismissPreferences,
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
    let routeRestoreGeneration = 0;
    const pendingHistoryRestoreResolvers = [];

    async function openNote(id, {route = 'push', isCurrent = () => true} = {}) {
      if (route !== 'none') routeRestoreGeneration++;
      noteSaver.cancelScheduled();
      cancelPreviewDelay();
      if (
        isEditorVisible() &&
        getCurrentNoteID() !== id &&
        (isDirty() || noteSaver.hasPendingSave())
      ) {
        const saved = await saveCurrentNote(false);
        if (saved === false || !isCurrent()) return false;
      }
      const data = await getLocalNote(id);
      if (!data || !isCurrent()) return false;
      showNoteInEditor(data);
      if (route === 'push') routes.setNote(id);
      else if (route === 'replace') routes.setNote(id, {replace: true});
      await showConflictResolverFor(id, isCurrent);
      return isCurrent();
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

    async function restoreNote(noteID, fetchRemote, isCurrent) {
      if (!noteID) return 'missing';
      if (!isCurrent()) return 'stale';
      const localNote = await getLocalNote(noteID);
      if (!isCurrent()) return 'stale';
      if (localNote) {
        const opened = await openNote(noteID, {route: 'none', isCurrent});
        return opened && isCurrent() ? 'loaded' : 'stale';
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
        if (!isCurrent()) return 'stale';
        await putLocalNote({
          ...remote,
          pending: false,
          base_revision: null,
          base_content: null,
          base_title: null,
          base_tags: null,
        });
        const opened = await openNote(noteID, {route: 'none', isCurrent});
        return opened && isCurrent() ? 'loaded' : 'stale';
      } catch (error) {
        return error?.responseStatus === 404 ? 'missing' : 'failed';
      }
    }

    async function restoreRoute({fetchRemote = false} = {}) {
      const generation = ++routeRestoreGeneration;
      const isCurrent = () => generation === routeRestoreGeneration;
      const leavingPreferences =
        !routes.isPreferences() &&
        !document.querySelector('#prefs-modal').classList.contains('hidden');
      const visibleDetail = () =>
        [
          ['setup', '#vault-setup-modal'],
          ['passphrase', '#vault-master-modal'],
          ['recovery', '#vault-recovery-modal'],
        ].find(
          ([, selector]) => !document.querySelector(selector).classList.contains('hidden'),
        )?.[0];
      if (routes.isPreferences()) {
        const returnRoute = window.history.state?.returnRoute;
        const noteID = returnRoute?.screen === 'note' ? returnRoute.noteID : null;
        if (noteID && getCurrentNoteID() === noteID && isDirty()) {
          const saved = await saveCurrentNote(false);
          if (!isCurrent()) return;
          if (!saved) {
            const section =
              document.querySelector('.prefs-nav.active')?.dataset.prefSection || 'appearance';
            const detail = visibleDetail();
            routes.setPreferences({section, detail, replace: true});
            openPreferences({route: 'none', section, detail});
            return;
          }
        }
        if (
          (noteID && getCurrentNoteID() === noteID && isEditorVisible()) ||
          (!noteID && isDashboardVisible())
        ) {
          openPreferences({
            route: 'none',
            section: window.history.state?.section,
            detail: window.history.state?.detail,
          });
          return;
        }
        const result = await restoreNote(noteID, fetchRemote, isCurrent);
        if (!isCurrent() || result === 'stale') return;
        if (result === 'loaded') {
          openPreferences({
            route: 'none',
            section: window.history.state?.section,
            detail: window.history.state?.detail,
          });
          return;
        }
        if (result === 'failed') return;
        if (noteID) routes.setDashboard({replace: true});
        clearCurrentNote();
        await loadDashboard({sync: false});
        if (isCurrent() && !noteID)
          openPreferences({
            route: 'none',
            section: window.history.state?.section,
            detail: window.history.state?.detail,
          });
        return;
      }

      const noteID = routes.noteID();
      if (leavingPreferences && routes.isNote() && getCurrentNoteID() === noteID && isDirty()) {
        const saved = await saveCurrentNote(false);
        if (!isCurrent()) return;
        if (!saved) {
          const section =
            document.querySelector('.prefs-nav.active')?.dataset.prefSection || 'appearance';
          const detail = visibleDetail();
          routes.setPreferences({section, detail, replace: true});
          openPreferences({route: 'none', section, detail});
          return;
        }
      } else if (isEditorVisible() && isDirty()) {
        await saveCurrentNote(false);
      }
      if (!isCurrent()) return;
      if (leavingPreferences) dismissPreferences();
      if (routes.isNote() && getCurrentNoteID() === noteID && isEditorVisible()) return;
      if (!noteID && isDashboardVisible()) return;
      const result = await restoreNote(noteID, fetchRemote, isCurrent);
      if (!isCurrent() || result === 'stale') return;
      if (result === 'loaded' || result === 'failed') return;
      if (noteID) {
        routes.setDashboard({replace: true});
        showToast('That note is no longer available.', 'warning');
      }
      clearCurrentNote();
      await loadDashboard({sync: false});
    }

    async function restoreCachedStartup() {
      const generation = ++routeRestoreGeneration;
      const isCurrent = () => generation === routeRestoreGeneration;
      const noteID = routes.noteID();
      if (noteID) {
        const note = await getLocalNote(noteID);
        if (!isCurrent()) return;
        if (note) {
          await openNote(noteID, {route: 'none', isCurrent});
          return;
        }
      }
      if (!isCurrent()) return;
      setDashboardHydrationState((await getLocalNotes()).length ? 'ready' : 'loading');
      await loadDashboard({sync: false});
      if (!isCurrent()) return;
      const conflicts = await unresolvedConflictIDs();
      for (const conflictID of conflicts) {
        if (!isCurrent()) return;
        if (
          (await getLocalNote(conflictID)) &&
          (await showConflictResolverFor(conflictID, isCurrent))
        )
          break;
      }
    }

    function schedulePendingSync() {
      void pendingOperations()
        .then((operations) => {
          if (operations.length) scheduleSync();
        })
        .catch((error) => console.warn('could not inspect pending sync operations', error));
    }

    document.querySelector('#new-note-btn').addEventListener('click', () => {
      routeRestoreGeneration++;
      startNewNote();
    });
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
