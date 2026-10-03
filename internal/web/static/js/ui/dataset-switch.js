(function (root) {
  'use strict';

  function create({
    document,
    offlineStore,
    fetchBootstrap,
    endSession,
    prepareSwitch = async () => {},
    openModal,
    closeModal,
    pause,
    resume,
    broadcast,
    switched,
  }) {
    const modal = document.querySelector('#dataset-switch-modal');
    const keep = document.querySelector('#dataset-switch-keep');
    const confirm = document.querySelector('#dataset-switch-confirm');
    const error = document.querySelector('#dataset-switch-error');
    let target = null;
    let busy = false;

    function mismatchError() {
      return new root.VylkHTTP.APIError(
        'The notes database changed. Sync is paused to protect your local changes.',
        {status: 409, code: 'server_instance_changed', retryable: false},
      );
    }

    async function inspect(config, {notify = true} = {}) {
      const result = await offlineStore.inspectDataset(config);
      if (!result.changed) {
        if (target) {
          target = null;
          closeModal(modal);
          resume();
        }
        return;
      }
      const newlyDetected = target?.instance_id !== config.instance_id;
      target = config;
      pause();
      if (newlyDetected) {
        error.textContent = '';
        openModal(modal);
        if (notify) broadcast({type: 'dataset-changed', config});
      }
      throw mismatchError();
    }

    function keepChanges() {
      if (!busy) closeModal(modal);
    }

    async function switchDataset() {
      if (busy || !target) return;
      busy = true;
      keep.disabled = true;
      confirm.disabled = true;
      error.textContent = '';
      try {
        const config = await fetchBootstrap();
        if (config.instance_id !== target.instance_id) {
          await inspect(config);
          throw new Error(
            'The server changed again. Review the current database before switching.',
          );
        }
        // Install the current app before discarding anything. A plain reload
        // can otherwise load the old worker's cached shell after a server change.
        await prepareSwitch(config);
        // Atomic clearing plus the identity fence stops writes from stale tabs.
        await endSession();
        const verified = await fetchBootstrap();
        if (verified.instance_id !== config.instance_id) {
          await inspect(verified);
          throw new Error(
            'The server changed again. Review the current database before switching.',
          );
        }
        if (verified.revision && verified.revision !== config.revision)
          throw new Error('The app updated again. Try Switch again to load the latest version.');
        const cleared = await offlineStore.switchDataset(verified);
        broadcast({type: 'dataset-switched', instanceID: config.instance_id});
        await switched(config, cleared);
      } catch (cause) {
        error.textContent =
          cause.code === 'server_instance_changed'
            ? 'The server changed again. Review the current database before switching.'
            : cause.message || 'Could not switch databases. Your local data is kept.';
      } finally {
        busy = false;
        keep.disabled = false;
        confirm.disabled = false;
      }
    }

    keep.addEventListener('click', keepChanges);
    confirm.addEventListener('click', () => void switchDataset());
    modal.querySelector('.modal-backdrop').addEventListener('click', keepChanges);

    return {inspect, keepChanges, paused: () => Boolean(target)};
  }

  root.VylkDatasetSwitch = {create};
})(typeof window !== 'undefined' ? window : globalThis);
