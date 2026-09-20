(function (global) {
  'use strict';

  function bind({
    api,
    cacheVersion,
    cancelRequests,
    clearDiagnostic,
    clearOfflineData,
    connectEvents,
    disconnectEvents,
    document,
    loadPreferences,
    localStorage,
    restoreRoute,
    scheduleSync,
    setAuthenticationRequired,
    showLogin,
    showToast,
  }) {
    document.querySelector('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthenticationRequired(false);
      clearDiagnostic();
      try {
        const result = await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({password: event.target.password.value}),
        });
        document.querySelector('#login-error').textContent = '';
        cacheVersion(result);
        await loadPreferences();
        await restoreRoute();
        connectEvents();
        scheduleSync({reconcile: true});
      } catch (error) {
        document.querySelector('#login-error').textContent =
          error.code === 'invalid_credentials'
            ? 'Wrong password'
            : error.code === 'login_rate_limited'
              ? 'Too many attempts. Please try again later.'
              : 'Could not sign in. Please try again.';
      }
    });

    document.querySelector('#logout-btn').addEventListener('click', async () => {
      cancelRequests();
      disconnectEvents();
      try {
        await api('/api/logout', {method: 'POST'});
      } catch (error) {
        console.warn('server logout failed; clearing local session data', error);
      }
      try {
        await clearOfflineData();
      } catch (error) {
        console.error('could not clear local data during logout', error);
        showToast('Close other app tabs, then try signing out again.', 'warning');
        return;
      }
      localStorage.removeItem('vylk-offline-ready');
      localStorage.removeItem('vylk-prefs');
      showLogin();
    });
  }

  global.VylkAuth = {bind};
})(typeof window !== 'undefined' ? window : globalThis);
