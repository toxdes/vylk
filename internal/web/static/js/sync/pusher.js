(function (global) {
  'use strict';

  function create({
    APIError,
    apiErrorFromPayload,
    applyAcknowledgement,
    byteLimit,
    claimBatch,
    getDeviceID,
    initialBatchLimit,
    quarantine,
    repairSequenceGap,
    requireAuthentication,
    serialize,
    showToast,
    syncFetch,
  }) {
    return async function flush() {
      let pushed = false;
      let maxOperations = initialBatchLimit;
      for (;;) {
        const deviceID = await getDeviceID();
        const operations = await claimBatch(deviceID, maxOperations, byteLimit);
        if (!operations.length) return pushed;
        const result = await syncFetch('/api/sync/push', {
          method: 'POST',
          body: JSON.stringify({
            device_id: deviceID,
            operations: operations.map(serialize),
          }),
        });
        pushed = true;
        if (result.response.status === 401) {
          requireAuthentication();
          throw apiErrorFromPayload(result.data, 401, 'Unauthorized');
        }
        if (result.response.status === 409) {
          const expected = Number(result.data?.expected_sequence);
          if (await repairSequenceGap(expected)) {
            showToast('Recovered a local sync gap. Retrying your changes.', 'warning');
            continue;
          }
          throw new APIError(
            expected ? `sync sequence gap; expected ${expected}` : 'sync sequence conflict',
            {status: 409, code: 'sync_sequence_conflict', retryable: false},
          );
        }
        if (!result.response.ok) {
          const permanent =
            result.response.status === 400 ||
            result.response.status === 413 ||
            result.data?.permanent === true;
          if (permanent) {
            if (operations.length > 1) {
              maxOperations =
                result.response.status === 413 ? Math.max(1, Math.floor(maxOperations / 2)) : 1;
              continue;
            }
            if (
              await quarantine(
                operations[0],
                typeof result.data === 'string' ? result.data : result.data?.error,
              )
            ) {
              showToast('A local change needs attention before it can sync.', 'warning');
              continue;
            }
          }
          throw apiErrorFromPayload(
            result.data,
            result.response.status,
            result.response.statusText,
          );
        }
        for (const operation of operations) {
          const acknowledgement = result.data?.acknowledged?.find(
            (item) => item.op_id === operation.op_id,
          );
          if (!acknowledgement) throw new Error('sync acknowledgement missing');
          await applyAcknowledgement(operation, acknowledgement);
        }
      }
    };
  }

  global.VylkSyncPusher = {create};
})(typeof window !== 'undefined' ? window : globalThis);
