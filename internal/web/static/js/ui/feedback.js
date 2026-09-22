(function (root) {
  'use strict';

  const SYNC_STATES = {
    online: {label: 'Saved', title: 'Saved and up to date'},
    local: {label: 'Saved', title: 'Saved on this device; waiting to sync'},
    syncing: {label: 'Syncing', title: 'Synchronizing changes'},
    offline: {label: 'Offline', title: 'Offline — changes are saved on this device'},
  };

  function create({
    document,
    isSyncInFlight,
    localStorage,
    navigator,
    registerServiceWorker,
    requestFrame,
    window,
  }) {
    let appVersion = localStorage.getItem('vylk-version') || null;
    let appRevision = localStorage.getItem('vylk-revision') || null;
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
          const registration = await navigator.serviceWorker?.getRegistration();
          await registration?.update();
        } catch (error) {
          console.warn('service worker update check failed', error);
        }
        window.location.reload();
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
      if (changedVersion || changedRevision) showUpdateAvailable();
      if (response?.version) {
        if (!appVersion) appVersion = response.version;
        localStorage.setItem('vylk-version', response.version);
      }
      if (response?.revision) {
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

  root.VylkFeedback = {create};
})(typeof window !== 'undefined' ? window : globalThis);
