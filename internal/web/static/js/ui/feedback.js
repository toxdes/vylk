(function (root) {
  'use strict';

  const SYNC_STATES = {
    online: {label: 'Saved', title: 'Saved and up to date'},
    local: {label: 'Saving', title: 'Saved on this device; waiting to sync'},
    saving: {label: 'Saving', title: 'Saving on this device'},
    syncing: {label: 'Syncing', title: 'Synchronizing changes'},
    offline: {label: 'Offline', title: 'Offline — changes are saved on this device'},
    unsaved: {label: 'Not saved', title: 'Changes could not be saved on this device'},
  };

  function waitForRevisionController(serviceWorker, revision, timeoutMs = 15000) {
    const matches = () => {
      if (!serviceWorker.controller) return false;
      return new URL(serviceWorker.controller.scriptURL).searchParams.get('revision') === revision;
    };
    if (matches()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        serviceWorker.removeEventListener('controllerchange', changed);
        if (error) reject(error);
        else resolve();
      };
      const changed = () => {
        if (matches()) finish();
      };
      const timer = setTimeout(
        () => finish(new Error('The update is not ready yet. Try Reload again.')),
        timeoutMs,
      );
      serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  }

  function create({
    document,
    isSyncInFlight,
    localStorage,
    navigator,
    registerServiceWorker,
    beforeReload = async () => {},
    requestFrame,
    window,
  }) {
    let appVersion = localStorage.getItem('vylk-version') || null;
    const shellRevision = document.querySelector('meta[name="vylk-revision"]')?.content;
    let appRevision =
      shellRevision && !shellRevision.startsWith('__')
        ? shellRevision
        : localStorage.getItem('vylk-revision') || null;
    let latestRevision = appRevision;
    let updateToast = null;
    let statusRevealTimer = null;
    let statusGeneration = 0;
    let diagnostic = {detail: '', responseStatus: 0};

    function select(selector) {
      return document.querySelector(selector);
    }

    function selectAll(selector) {
      return document.querySelectorAll(selector);
    }

    function setStatus(state) {
      statusGeneration++;
      const config = SYNC_STATES[state] || SYNC_STATES.offline;
      ['#sync-status', '#editor-status'].forEach((selector) => {
        const element = select(selector);
        if (!element) return;
        element.dataset.state = state;
        element.title = config.title;
        element.setAttribute('aria-label', config.title);
        element.querySelector('.sync-indicator-label').textContent = config.label;
      });
    }

    function showToast(message, kind = '') {
      const toast = document.createElement('div');
      toast.className = `toast ${kind}`;
      toast.textContent = message;
      select('#toast-region').append(toast);
      requestFrame(() => toast.classList.add('visible'));
      window.setTimeout(() => {
        toast.classList.remove('visible');
        window.setTimeout(() => toast.remove(), 180);
      }, 3200);
    }

    function showUpdateAvailable() {
      if (updateToast) return;
      const toast = document.createElement('div');
      toast.className = 'toast update';
      const message = document.createElement('span');
      message.textContent = 'New version available.';
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = 'toast-action';
      reload.textContent = 'Reload';
      reload.addEventListener('click', async () => {
        reload.disabled = true;
        reload.textContent = 'Updating…';
        try {
          await beforeReload();
          if (navigator.serviceWorker) {
            const target = latestRevision;
            const registration = await registerServiceWorker(target);
            if (!registration)
              throw new Error('Could not download the update. Try again when connected.');
            await registration.update();
            await waitForRevisionController(navigator.serviceWorker, target);
            if (target !== latestRevision)
              throw new Error('Another update arrived. Try Reload again.');
          }
          window.location.reload();
        } catch (error) {
          console.warn('app update failed', error);
          message.textContent = error.message || 'Could not update. Try again.';
          reload.disabled = false;
          reload.textContent = 'Reload';
        }
      });
      toast.append(message, reload);
      select('#toast-region').append(toast);
      requestFrame(() => toast.classList.add('visible'));
      updateToast = toast;
    }

    function setDiagnostic(detail, responseStatus = 0) {
      diagnostic = {
        detail: String(detail || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 280),
        responseStatus: Number.isInteger(responseStatus) ? responseStatus : 0,
      };
    }

    function clearDiagnostic() {
      diagnostic = {detail: '', responseStatus: 0};
    }

    function getDiagnostic() {
      return diagnostic;
    }

    function showOfflineNotice(checking = false) {
      selectAll('.offline-notice').forEach((notice) => {
        notice.classList.remove('hidden');
        notice.querySelector('.offline-notice-message').textContent = checking
          ? 'Checking…'
          : "You're offline. Changes are saved on this device.";
        const retry = notice.querySelector('.offline-retry');
        retry.classList.toggle('hidden', checking);
        retry.disabled = checking;
      });
    }

    function hideOfflineNotice() {
      selectAll('.offline-notice').forEach((notice) => notice.classList.add('hidden'));
    }

    function showSyncComplete() {
      hideOfflineNotice();
      showToast('Changes synced.', 'success');
    }

    function cacheVersion(response) {
      const changedVersion = response?.version && appVersion && response.version !== appVersion;
      const changedRevision =
        response?.revision && appRevision && response.revision !== appRevision;
      // A server version label is shared across tabs and is not evidence that
      // this page's assets are old. Prefer the loaded shell fingerprint.
      if (response?.revision && appRevision ? changedRevision : changedVersion)
        showUpdateAvailable();
      if (response?.version) {
        if (!appVersion) appVersion = response.version;
        localStorage.setItem('vylk-version', response.version);
      }
      if (response?.revision) {
        latestRevision = response.revision;
        if (!appRevision) appRevision = response.revision;
        localStorage.setItem('vylk-revision', response.revision);
        registerServiceWorker(response.revision);
      }
      const version = response?.version || localStorage.getItem('vylk-version') || 'dev';
      select('#app-version').textContent = `v${version}`;
    }

    function beginStatusCheck() {
      return ++statusGeneration;
    }

    function statusCheckIsCurrent(generation) {
      return generation === statusGeneration;
    }

    function beginStatusPresentation() {
      if (statusRevealTimer || select('#sync-status')?.dataset.state === 'syncing') return;
      statusRevealTimer = window.setTimeout(() => {
        statusRevealTimer = null;
        if (isSyncInFlight()) setStatus('syncing');
      }, 150);
    }

    function cancelStatusPresentation() {
      if (!statusRevealTimer) return;
      window.clearTimeout(statusRevealTimer);
      statusRevealTimer = null;
    }

    function finishStatusPresentation(state) {
      cancelStatusPresentation();
      setStatus(state);
    }

    return {
      beginStatusCheck,
      beginStatusPresentation,
      cacheVersion,
      cancelStatusPresentation,
      clearDiagnostic,
      currentRevision: () => appRevision,
      finishStatusPresentation,
      getDiagnostic,
      hideOfflineNotice,
      setDiagnostic,
      setStatus,
      showOfflineNotice,
      showSyncComplete,
      showToast,
      statusCheckIsCurrent,
    };
  }

  root.VylkFeedback = {create, waitForRevisionController};
})(typeof window !== 'undefined' ? window : globalThis);
