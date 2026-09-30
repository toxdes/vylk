(function (global) {
  'use strict';

  function create({
    acknowledgeCompacted,
    applyPreferencesRevision,
    commitNoteAcknowledgement,
    createConflictResolution,
    getCurrentNoteID,
    getLocalNote,
    isDirty,
    latestLaterOperation,
    loadConflictRemoteNote,
    mergeConflictedNote,
    pendingOperationsForNote,
    putLocalNote,
    queueOperation,
    rebaseOperations,
    refreshDashboard,
    removeLocalNote,
    removePendingOperation,
    resolvePreferenceConflict,
    setCurrentRevision,
    showConflictResolverFor,
    showToast,
    updateOpenNote,
  }) {
    async function apply(operation, acknowledgement) {
      if (acknowledgement.status === 'compacted') {
        await acknowledgeCompacted(operation);
        return;
      }
      if (acknowledgement.status === 'conflict') {
        if (operation.type === 'prefs.save') {
          await resolvePreferenceConflict(operation);
          return;
        }
        if (operation.type === 'note.pin') {
          const remote = await loadConflictRemoteNote(operation.note_id);
          if (!remote) {
            await removeLocalNote(operation.note_id);
            await removePendingOperation(operation.id, operation);
            return;
          }
          const queued = await pendingOperationsForNote(operation.note_id);
          const hasLaterSave = Boolean(latestLaterOperation(queued, operation, 'note.save'));
          const laterPin = latestLaterOperation(queued, operation, 'note.pin');
          const desiredPinned = laterPin ? Boolean(laterPin.pinned) : Boolean(operation.pinned);
          if (!hasLaterSave)
            await rebaseOperations(operation.note_id, operation.id, remote.revision, remote);
          await removePendingOperation(operation.id, operation);
          const local = await getLocalNote(operation.note_id);
          const preserveLocalContent =
            hasLaterSave || (getCurrentNoteID() === operation.note_id && isDirty());
          const next = {
            ...remote,
            ...(preserveLocalContent ? local : {}),
            pinned: desiredPinned,
            pin_order: desiredPinned ? local?.pin_order || 0 : 0,
            revision: remote.revision,
            pending: true,
            base_revision: remote.revision,
          };
          await putLocalNote(next);
          if (!laterPin) {
            await queueOperation({
              type: 'note.pin',
              note_id: operation.note_id,
              base_revision: remote.revision,
              pinned: desiredPinned,
              pin_order: next.pin_order,
            });
          }
          updateOpenNote(next);
          await refreshDashboard();
          return;
        }
        const remote = await loadConflictRemoteNote(operation.note_id);
        if (await mergeConflictedNote(operation, remote)) {
          showToast('Merged your non-overlapping changes.', 'success');
        } else {
          const resolverReady = await createConflictResolution(operation, remote);
          if (resolverReady === 'remote-deleted') await showConflictResolverFor(operation.note_id);
          else if (resolverReady) showToast('Conflicting edits need your review.', 'warning');
          else showToast('A conflict copy was created so your changes are safe.', 'warning');
        }
        return;
      }
      if (acknowledgement.status !== 'applied') throw new Error('unknown sync acknowledgement');
      if (operation.type === 'prefs.save') applyPreferencesRevision(acknowledgement.revision);
      if (operation.type === 'note.save' || operation.type === 'note.pin') {
        const committed = await commitNoteAcknowledgement(operation, acknowledgement);
        if (!committed) return;
        if (getCurrentNoteID() === operation.note_id)
          setCurrentRevision(committed.revision || 0, committed.baseRevision);
        if (operation.type === 'note.pin') await refreshDashboard();
        return;
      }
      await removePendingOperation(operation.id, operation);
    }

    return {apply};
  }

  global.VylkSyncAcknowledgements = {create};
})(typeof window !== 'undefined' ? window : globalThis);
