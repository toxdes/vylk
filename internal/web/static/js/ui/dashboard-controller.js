(function (global) {
  'use strict';

  function create({
    getConflictIDs,
    getCurrentNoteID,
    getLocalNote,
    getLocalNotes,
    isDashboardVisible,
    isDirty,
    isEditorVisible,
    scheduleSync,
    setIdleStatus,
    showDashboard,
    updateOpenNote,
    view,
  }) {
    let renderGeneration = 0;

    async function refresh() {
      const generation = ++renderGeneration;
      const [notes, conflicts] = await Promise.all([getLocalNotes(), getConflictIDs()]);
      if (generation === renderGeneration) view.render(notes, conflicts);
    }

    async function refreshFromStorage() {
      if (isDashboardVisible()) await refresh();
      const noteID = getCurrentNoteID();
      if (isEditorVisible() && noteID && !isDirty()) {
        const note = await getLocalNote(noteID);
        if (note) updateOpenNote(note);
      }
      void setIdleStatus();
    }

    async function load({sync = true} = {}) {
      showDashboard();
      await refresh();
      if (sync) scheduleSync();
    }

    return {load, refresh, refreshFromStorage, view};
  }

  global.VylkDashboardController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
