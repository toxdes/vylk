(function (global) {
  'use strict';

  function create({
    cacheVersion,
    getOfflineState,
    getPreferenceRevision,
    isSyncInFlight,
    loadPreferences,
    onHeartbeat,
    scheduleSync,
    syncNow,
    window,
  }) {
    const staleAfterMs = 70_000;
    let events = null;
    let heartbeatAt = 0;
    let watchdog = null;
    let changeTimer = null;
    let changePending = false;
    let pendingSequence = 0;

    function healthy() {
      return Boolean(events && heartbeatAt > 0 && Date.now() - heartbeatAt <= staleAfterMs);
    }

    function heartbeat() {
      heartbeatAt = Date.now();
      onHeartbeat();
    }

    function scheduleChangeSync() {
      changePending = true;
      if (changeTimer || isSyncInFlight()) return;
      changeTimer = window.setTimeout(() => {
        changeTimer = null;
        if (isSyncInFlight()) return;
        changePending = false;
        scheduleSync();
        if (changePending) scheduleChangeSync();
      }, 75);
    }

    async function handleChange(change = {}) {
      const type = change?.type || 'notes';
      if (type === 'preferences') {
        const revision = Number(change.revision || 0);
        if (revision > 0 && revision <= Number(getPreferenceRevision() || 0)) return false;
        void loadPreferences();
        return true;
      }
      if (type !== 'notes') {
        scheduleChangeSync();
        return true;
      }
      const sequence = Number(change.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        scheduleChangeSync();
        return true;
      }
      pendingSequence = Math.max(pendingSequence, sequence);
      let cursor = 0;
      try {
        cursor = Number((await getOfflineState('syncSequence')) || 0);
      } catch (_) {
        scheduleChangeSync();
        return true;
      }
      if (sequence <= cursor) {
        if (pendingSequence <= cursor) pendingSequence = 0;
        return false;
      }
      if (isSyncInFlight()) scheduleSync();
      else scheduleChangeSync();
      return true;
    }

    function connect() {
      if (typeof window.EventSource !== 'function' || events) return;
      heartbeatAt = Date.now();
      const connection = new window.EventSource('/api/events');
      events = connection;
      connection.addEventListener('server', (event) => {
        try {
          cacheVersion(JSON.parse(event.data));
        } catch (_) {}
      });
      connection.addEventListener('change', (event) => {
        heartbeatAt = Date.now();
        try {
          void handleChange(JSON.parse(event.data)).catch(scheduleChangeSync);
        } catch (_) {
          scheduleChangeSync();
        }
      });
      connection.addEventListener('heartbeat', heartbeat);
      connection.onopen = heartbeat;
      connection.onerror = () => {
        if (events === connection) heartbeatAt = 0;
      };
      if (!watchdog) {
        watchdog = window.setInterval(() => {
          if (!events || Date.now() - heartbeatAt <= staleAfterMs) return;
          events.close();
          events = null;
          void syncNow({reconcile: true}).then((synced) => {
            if (synced) connect();
          });
        }, 5000);
      }
    }

    function disconnect() {
      events?.close();
      events = null;
      heartbeatAt = 0;
      if (watchdog) window.clearInterval(watchdog);
      watchdog = null;
      if (changeTimer) window.clearTimeout(changeTimer);
      changeTimer = null;
      changePending = false;
      pendingSequence = 0;
    }

    function workRemains(cursor) {
      if (pendingSequence && pendingSequence <= cursor) pendingSequence = 0;
      return pendingSequence > cursor;
    }

    return {
      connect,
      connected: () => Boolean(events),
      disconnect,
      handleChange,
      healthy,
      workRemains,
    };
  }

  global.VylkServerEvents = {create};
})(typeof window !== 'undefined' ? window : globalThis);
