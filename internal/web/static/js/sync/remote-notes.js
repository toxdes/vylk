(function (global) {
  'use strict';

  function create({
    api,
    getAllLocalNotes,
    getCurrentNoteID,
    getLocalNote,
    getOfflineState,
    handleServerIdentity,
    handleActiveDeletion,
    isDirty,
    putLocalNote,
    rejectedSyncKey,
    requestValue,
    unresolvedConflictKey,
    updateOpenNote,
    withOfflineStore,
  }) {
    const downloadBatchSize = 25;

    function isCurrentDirty(noteID) {
      return getCurrentNoteID() === noteID && isDirty();
    }

    function collectGuards(operations, records) {
      const guarded = new Set(operations.map((operation) => operation.note_id).filter(Boolean));
      records.forEach((record) => {
        if (
          record.key.startsWith('unresolvedConflict:') ||
          record.key.startsWith('rejectedSync:')
        ) {
          const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
          if (noteID) guarded.add(noteID);
        }
      });
      return guarded;
    }

    async function cache(note) {
      const local = await getLocalNote(note.id);
      if (local?.pending || isCurrentDirty(note.id)) return;
      const next = {
        ...local,
        ...note,
        pending: false,
        base_revision: null,
        base_content: null,
        base_title: null,
        base_tags: null,
      };
      await putLocalNote(next);
      if (getCurrentNoteID() === note.id && !isDirty()) updateOpenNote(next);
    }

    async function applyDeletion(noteID) {
      const removed = await withOfflineStore(
        ['notes', 'queue', 'state'],
        'readwrite',
        async (stores) => {
          const pending = await requestValue(stores.queue.index('note_id').getAll(noteID));
          const conflict = await requestValue(stores.state.get(unresolvedConflictKey(noteID)));
          const rejected = await requestValue(stores.state.get(rejectedSyncKey(noteID)));
          if (pending.length || conflict || rejected) return false;
          await requestValue(stores.notes.delete(noteID));
          return true;
        },
      );
      if (removed && getCurrentNoteID() === noteID && !isDirty()) await handleActiveDeletion();
      return removed;
    }

    async function download(noteIDs) {
      if (!noteIDs.length) return new Map();
      const notes = new Map();
      for (let index = 0; index < noteIDs.length; index += downloadBatchSize) {
        const batch = noteIDs.slice(index, index + downloadBatchSize);
        const response = await api(`/api/sync/notes?ids=${encodeURIComponent(batch.join(','))}`, {
          syncRequest: true,
        });
        if (!response || !Array.isArray(response.notes) || !Array.isArray(response.missing))
          throw new Error('could not download changed notes');
        response.notes.forEach((note) => notes.set(note.id, note));
        response.missing.forEach((id) => notes.set(id, null));
      }
      return notes;
    }

    async function loadGuards() {
      return withOfflineStore(['queue', 'state'], 'readonly', async (stores) => {
        const [operations, records] = await Promise.all([
          requestValue(stores.queue.getAll()),
          requestValue(stores.state.getAll()),
        ]);
        return collectGuards(operations, records);
      });
    }

    async function applyChangePage(changes, downloaded, nextSequence) {
      let activeNote = null;
      let activeDeleted = false;
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        const [operations, records] = await Promise.all([
          requestValue(stores.queue.getAll()),
          requestValue(stores.state.getAll()),
        ]);
        const guarded = collectGuards(operations, records);
        for (const change of changes) {
          if (guarded.has(change.note_id)) continue;
          const remote = change.deleted ? null : downloaded.get(change.note_id);
          const local = await requestValue(stores.notes.get(change.note_id));
          if (local?.pending || isCurrentDirty(change.note_id)) continue;
          if (!remote) {
            await requestValue(stores.notes.delete(change.note_id));
            if (getCurrentNoteID() === change.note_id) activeDeleted = true;
            continue;
          }
          const next = {
            ...local,
            ...remote,
            pending: false,
            base_revision: null,
            base_content: null,
            base_title: null,
            base_tags: null,
          };
          await requestValue(stores.notes.put(next));
          if (getCurrentNoteID() === change.note_id && !isDirty()) activeNote = next;
        }
        await requestValue(stores.state.put({key: 'syncSequence', value: nextSequence}));
      });
      if (activeNote) updateOpenNote(activeNote);
      if (activeDeleted && getCurrentNoteID() && !isDirty()) await handleActiveDeletion();
    }

    async function applySnapshot(remoteNotes, remoteIDs, sequence = null) {
      let activeNote = null;
      let activeDeleted = false;
      await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async (stores) => {
        const [operations, records, locals] = await Promise.all([
          requestValue(stores.queue.getAll()),
          requestValue(stores.state.getAll()),
          requestValue(stores.notes.getAll()),
        ]);
        const localByID = new Map(locals.map((note) => [note.id, note]));
        const guarded = collectGuards(operations, records);
        for (const [id, remote] of remoteNotes) {
          if (guarded.has(id)) continue;
          const local = localByID.get(id);
          if (local?.pending || isCurrentDirty(id)) continue;
          const next = {
            ...local,
            ...remote,
            pending: false,
            base_revision: null,
            base_content: null,
            base_title: null,
            base_tags: null,
          };
          await requestValue(stores.notes.put(next));
          if (getCurrentNoteID() === id && !isDirty()) activeNote = next;
        }
        for (const local of locals) {
          if (remoteIDs.has(local.id) || guarded.has(local.id)) continue;
          await requestValue(stores.notes.delete(local.id));
          if (getCurrentNoteID() === local.id) activeDeleted = true;
        }
        if (sequence !== null)
          await requestValue(stores.state.put({key: 'syncSequence', value: sequence}));
      });
      if (activeNote) updateOpenNote(activeNote);
      if (activeDeleted && getCurrentNoteID() && !isDirty()) await handleActiveDeletion();
    }

    async function reset(sequence) {
      const summaries = await api('/api/notes', {syncRequest: true});
      if (!Array.isArray(summaries))
        throw new Error('could not refresh notes after sync compaction');
      const remoteIDs = new Set(summaries.map((note) => note.id));
      const guards = await loadGuards();
      const downloadIDs = summaries.filter((note) => !guards.has(note.id)).map((note) => note.id);
      const remoteNotes = new Map();
      for (let index = 0; index < downloadIDs.length; index += 100) {
        const page = await download(downloadIDs.slice(index, index + 100));
        page.forEach((remote, id) => remoteNotes.set(id, remote));
      }
      for (const id of downloadIDs)
        if (!remoteNotes.get(id)) throw new Error('could not download refreshed note');
      await applySnapshot(remoteNotes, remoteIDs, sequence);
    }

    async function pull() {
      let since = Number((await getOfflineState('syncSequence')) || 0);
      const fetchedNotes = new Map();
      const guards = await loadGuards();
      for (;;) {
        const page = await api(`/api/sync?since=${since}&limit=100`, {syncRequest: true});
        if (!page) throw new Error('could not fetch sync changes');
        if (await handleServerIdentity(page.instance_id)) {
          await reset(0);
          return;
        }
        if (page.resetRequired) {
          await reset(Number(page.nextSequence || 0));
          return;
        }
        const downloadIDs = page.changes
          .filter(
            (change) =>
              !change.deleted && !fetchedNotes.has(change.note_id) && !guards.has(change.note_id),
          )
          .map((change) => change.note_id);
        const downloaded = await download([...new Set(downloadIDs)]);
        downloaded.forEach((remote, id) => fetchedNotes.set(id, remote));
        const nextSince = Number(page.nextSequence || since);
        if (page.hasMore && nextSince <= since)
          throw new Error(`sync cursor did not advance (since ${since}, next ${nextSince})`);
        await applyChangePage(page.changes, fetchedNotes, nextSince);
        since = nextSince;
        if (!page.hasMore) return;
      }
    }

    async function reconcile() {
      const summaries = await api('/api/notes', {syncRequest: true});
      if (!Array.isArray(summaries)) throw new Error('could not reconcile local notes');
      const remoteIDs = new Set(summaries.map((note) => note.id));
      const guards = await loadGuards();
      const locals = await getAllLocalNotes();
      const localByID = new Map(locals.map((note) => [note.id, note]));
      const downloadIDs = summaries
        .filter((summary) => {
          if (guards.has(summary.id)) return false;
          const local = localByID.get(summary.id);
          return !local || local.revision !== summary.revision;
        })
        .map((summary) => summary.id);
      const remoteNotes = new Map();
      for (let index = 0; index < downloadIDs.length; index += 100) {
        const page = await download(downloadIDs.slice(index, index + 100));
        page.forEach((remote, id) => remoteNotes.set(id, remote));
      }
      for (const id of downloadIDs)
        if (!remoteNotes.get(id)) throw new Error('could not download reconciled note');
      await applySnapshot(remoteNotes, remoteIDs);
    }

    return {applyChangePage, applyDeletion, applySnapshot, cache, pull, reconcile, reset};
  }

  global.VylkRemoteNotes = {create};
})(typeof window !== 'undefined' ? window : globalThis);
