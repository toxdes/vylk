(function (global) {
  'use strict';

  function create({
    acknowledgeCompacted,
    applyPreferencesRevision,
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
      if (operation.type === 'note.save') {
        const acknowledgedNote = operation.note;
        const queued = await pendingOperationsForNote(operation.note_id);
        const laterPin = latestLaterOperation(queued, operation, 'note.pin');
        const hasLater = await rebaseOperations(
          operation.note_id,
          operation.id,
          acknowledgement.revision,
          acknowledgedNote,
        );
        const local = await getLocalNote(operation.note_id);
        if (local) {
          const pinOrder = laterPin
            ? local.pin_order
            : acknowledgedNote.pinned
              ? acknowledgement.pin_order || local.pin_order || 0
              : 0;
          await putLocalNote({
            ...local,
            revision: acknowledgement.revision,
            pin_order: pinOrder,
            pending: hasLater,
            base_revision: hasLater ? acknowledgement.revision : null,
            base_content: hasLater ? acknowledgedNote.content : null,
            base_title: hasLater ? acknowledgedNote.title : null,
            base_tags: hasLater ? acknowledgedNote.tags : null,
          });
        }
        if (getCurrentNoteID() === operation.note_id)
          setCurrentRevision(
            acknowledgement.revision || 0,
            hasLater ? acknowledgement.revision : null,
          );
      }
      if (operation.type === 'note.pin') {
        const local = await getLocalNote(operation.note_id);
        if (local) {
          const queued = await pendingOperationsForNote(operation.note_id);
          const laterPin = latestLaterOperation(queued, operation, 'note.pin');
          const hasLater = await rebaseOperations(
            operation.note_id,
            operation.id,
            acknowledgement.revision,
            local,
          );
          const pinned = laterPin ? Boolean(local.pinned) : Boolean(operation.pinned);
          const pinOrder = laterPin
            ? local.pin_order
            : pinned
              ? acknowledgement.pin_order || local.pin_order || 0
              : 0;
          const remainsPending = hasLater || Boolean(laterPin);
          await putLocalNote({
            ...local,
            revision: acknowledgement.revision,
            pinned,
            pin_order: pinOrder,
            pending: remainsPending,
            base_revision: remainsPending ? acknowledgement.revision : null,
          });
          await refreshDashboard();
        }
      }
      await removePendingOperation(operation.id, operation);
    }

    return {apply};
  }

  global.VylkSyncAcknowledgements = {create};
})(typeof window !== 'undefined' ? window : globalThis);
