(function (global) {
  'use strict';

  function bind({
    api,
    cacheVersion,
    cancelRequests,
    closeModal,
    clearDiagnostic,
    clearOfflineData,
    connectEvents,
    disconnectEvents,
    document,
    loadPreferences,
    localStorage,
    openModal,
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

    const logoutModal = document.querySelector('#logout-modal');
    const closeLogout = () => closeModal(logoutModal);

    document.querySelector('#logout-btn').addEventListener('click', () => openModal(logoutModal));
    document.querySelector('#logout-close').addEventListener('click', closeLogout);
    document.querySelector('#logout-cancel').addEventListener('click', closeLogout);
    logoutModal.querySelector('.modal-backdrop').addEventListener('click', closeLogout);
    document.querySelector('#logout-confirm').addEventListener('click', async function () {
      this.disabled = true;
      try {
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
          showToast('You are signed out. Close other app tabs to remove local data.', 'warning');
        }
        localStorage.removeItem('vylk-offline-ready');
        localStorage.removeItem('vylk-prefs');
        closeLogout();
        showLogin();
      } finally {
        this.disabled = false;
      }
    });
  }

  global.VylkAuth = {bind};
})(typeof window !== 'undefined' ? window : globalThis);
