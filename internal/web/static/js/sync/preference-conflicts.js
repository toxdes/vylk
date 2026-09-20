(function (global) {
  'use strict';

  function create({
    api,
    applyPreferences,
    mergeNestedPatch,
    normalize,
    queueOperationInStores,
    queueOperationPayload,
    requestValue,
    scheduleSync,
    showToast,
    valuesEqual,
    withOfflineStore,
  }) {
    return async function resolve(operation) {
      const remote = await api('/api/prefs', {syncRequest: true});
      const payload = operation.prefs || {};
      const patch = payload._sync_patch || {};
      const base = payload._sync_base || {};
      const safePatch = {};
      const conflicts = [];
      Object.entries(patch).forEach(([key, desired]) => {
        const current = remote[key];
        if (key === 'keyboardShortcuts' || key === 'shortcutConfirmationSkips') {
          const merged = mergeNestedPatch(current, base[key], desired);
          if (!merged) conflicts.push(key);
          else {
            if (merged.conflict) conflicts.push(key);
            if (merged.changed) safePatch[key] = merged.value;
          }
          return;
        }
        if (!(key in base) || (!valuesEqual(current, base[key]) && !valuesEqual(current, desired)))
          conflicts.push(key);
        else if (!valuesEqual(current, desired)) safePatch[key] = desired;
      });
      const next = normalize({...remote, ...safePatch});
      await withOfflineStore(['queue', 'state'], 'readwrite', async (stores) => {
        const queued = await requestValue(stores.queue.get(operation.id));
        if (
          !queued ||
          queued.op_id !== operation.op_id ||
          queued.client_sequence !== operation.client_sequence ||
          queueOperationPayload(queued) !== queueOperationPayload(operation)
        ) {
          throw new Error('preference operation changed before conflict resolution');
        }
        await requestValue(stores.queue.delete(operation.id));
        if (Object.keys(safePatch).length) {
          const safeBase = Object.fromEntries(
            Object.keys(safePatch).map((key) => [key, remote[key]]),
          );
          await queueOperationInStores(stores, {
            type: 'prefs.save',
            note_id: '__prefs__',
            base_revision: remote.revision,
            prefs: {...next, _sync_patch: safePatch, _sync_base: safeBase},
          });
        }
      });
      applyPreferences(next);
      if (conflicts.length)
        showToast(
          'Some preferences changed on another device. Those settings were kept.',
          'warning',
        );
      scheduleSync();
    };
  }

  global.VylkPreferenceConflicts = {create};
})(typeof window !== 'undefined' ? window : globalThis);
