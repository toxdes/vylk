(function (global) {
  'use strict';

  function create({
    apiClient,
    authenticationRequired,
    beforeCompletion,
    clearDiagnostic,
    connectEvents,
    document,
    feedback,
    finishStatus,
    flush,
    getCursor,
    getHydrationState,
    getPendingOperations,
    hideOfflineNotice,
    isDashboardVisible,
    isEditorDirty,
    isEditorVisible,
    leadership,
    localStorage,
    notifyCompleted,
    onAuthenticationRequired,
    onOffline,
    pull,
    reconcileLocal,
    refreshDashboard,
    saveCurrentNote,
    serverEventsConnected,
    serverWorkRemains,
    setDiagnostic,
    setHydrationState,
    showToast,
    startStatus,
    window,
  }) {
    const retryDelays = [1000, 5000, 15000, 60000, 300000];
    let inFlight = false;
    let scheduleTimer = null;
    let scheduleOptions = {};
    let pendingWhileInFlight = false;
    let retryDelay = 0;
    let lastSuccessfulAt = 0;
    let lastProblem = '';
    let failed = false;
    let lifecyclePromise = null;

    function mergeOptions(options = {}) {
      scheduleOptions = {
        ...scheduleOptions,
        ...options,
        reconcile: Boolean(scheduleOptions.reconcile || options.reconcile),
      };
    }

    function takePendingIntent() {
      const options = {...scheduleOptions};
      pendingWhileInFlight = false;
      scheduleOptions = {};
      return options;
    }

    function schedule(options = {}, delayMs = 75) {
      mergeOptions(options);
      if (inFlight) {
        pendingWhileInFlight = true;
        return;
      }
      if (document.visibilityState === 'hidden' || scheduleTimer) return;
      const delay = Math.max(delayMs, retryDelay);
      scheduleTimer = window.setTimeout(async () => {
        scheduleTimer = null;
        if (document.visibilityState === 'hidden') return;
        const requested = scheduleOptions;
        scheduleOptions = {};
        if (inFlight) {
          scheduleOptions = {...scheduleOptions, ...requested};
          pendingWhileInFlight = true;
          return;
        }
        const synced = await now(requested);
        if (synced) {
          retryDelay = 0;
          return;
        }
        if (failed) {
          const index = retryDelays.indexOf(retryDelay);
          retryDelay = retryDelays[index + 1] || retryDelays.at(-1);
          schedule(requested, retryDelay);
        }
      }, delay);
    }

    async function workRemains(options = {}) {
      if (options.reconcile || (await getPendingOperations()).length) return true;
      const cursor = Number((await getCursor()) || 0);
      return serverWorkRemains(cursor);
    }

    function markOffline() {
      const firstFailure = !failed;
      failed = true;
      onOffline(firstFailure);
    }

    async function perform(options = {}) {
      const preserveSnackbar = Boolean(options.preserveSnackbar);
      let reconcile = Boolean(options.reconcile);
      if (scheduleTimer) {
        window.clearTimeout(scheduleTimer);
        scheduleTimer = null;
        reconcile = Boolean(reconcile || scheduleOptions.reconcile);
      }
      if (inFlight) return false;
      inFlight = true;
      pendingWhileInFlight = false;
      scheduleOptions = {};
      startStatus();
      const wasOffline = failed;
      try {
        for (;;) {
          if (isEditorVisible() && isEditorDirty()) await saveCurrentNote(false);
          await pull();
          if (reconcile) await reconcileLocal();
          const pushed = await flush();
          if (pushed) await pull();
          const pendingOptions = takePendingIntent();
          if (!(await workRemains(pendingOptions))) break;
          reconcile = Boolean(pendingOptions.reconcile);
        }
        await beforeCompletion();
        localStorage.setItem('vylk-offline-ready', '1');
        clearDiagnostic();
        failed = false;
        lastSuccessfulAt = Date.now();
        retryDelay = 0;
        setHydrationState('ready');
        if (isDashboardVisible()) await refreshDashboard();
        finishStatus('online');
        if (!serverEventsConnected()) connectEvents();
        notifyCompleted();
        if (!preserveSnackbar) hideOfflineNotice();
        if (wasOffline && !preserveSnackbar) showToast('Back online. Changes synced.');
        return true;
      } catch (error) {
        console.warn('sync failed', error);
        if (getHydrationState() === 'loading') {
          setHydrationState('offline-empty');
          if (isDashboardVisible()) await refreshDashboard();
        }
        if (apiClient.consumeCancellation(error)) return false;
        let diagnostic = feedback.getDiagnostic();
        if (!diagnostic.detail) {
          setDiagnostic(error?.message || 'unknown sync error', error?.responseStatus);
          diagnostic = feedback.getDiagnostic();
        }
        if (authenticationRequired()) {
          failed = false;
          finishStatus('online');
          hideOfflineNotice();
          onAuthenticationRequired();
          return false;
        }
        const responseStatus = error?.responseStatus || diagnostic.responseStatus;
        if (responseStatus >= 400 && responseStatus < 500) {
          failed = false;
          finishStatus('online');
          hideOfflineNotice();
          const message = `Sync needs attention: ${error.message}`;
          if (lastProblem !== message) {
            lastProblem = message;
            showToast(message, 'warning');
          }
          return false;
        }
        lastProblem = '';
        markOffline();
        finishStatus('offline');
        return false;
      } finally {
        inFlight = false;
        feedback.cancelStatusPresentation();
        if (pendingWhileInFlight) schedule(takePendingIntent(), 0);
      }
    }

    async function now(options = {}) {
      if (inFlight) {
        mergeOptions(options);
        pendingWhileInFlight = true;
        return false;
      }
      const lifecycle = leadership(() => perform(options));
      lifecyclePromise = lifecycle;
      try {
        return await lifecycle;
      } finally {
        if (lifecyclePromise === lifecycle) lifecyclePromise = null;
      }
    }

    function cancelScheduled() {
      if (scheduleTimer) window.clearTimeout(scheduleTimer);
      scheduleTimer = null;
      scheduleOptions = {};
      pendingWhileInFlight = false;
    }

    async function waitForIdle() {
      for (;;) {
        const lifecycle = lifecyclePromise;
        if (!lifecycle) return;
        await lifecycle.catch(() => {});
        if (lifecyclePromise === lifecycle) return;
      }
    }

    return {
      cancelScheduled,
      failed: () => failed,
      inFlight: () => inFlight,
      lastSuccessfulAt: () => lastSuccessfulAt,
      markOffline,
      now,
      schedule,
      scheduleState: () => ({scheduled: Boolean(scheduleTimer), options: {...scheduleOptions}}),
      waitForIdle,
    };
  }

  global.VylkSyncCoordinator = {create};
})(typeof window !== 'undefined' ? window : globalThis);
