(function (global) {
  'use strict';

  function bind({
    api,
    cacheVersion,
    cancelRequests,
    closeModal,
    clearDiagnostic,
    clearOfflineData,
    beforeSignOut,
    connectEvents,
    disconnectEvents,
    document,
    handleServerIdentity,
    loadPreferences,
    localStorage,
    openModal,
    openPassphrasePreferences,
    restoreRoute,
    scheduleSync,
    setAuthenticationRequired,
    showLogin,
    showToast,
    vaultSetup,
    vaultSession,
  }) {
    const recoveryModal = document.querySelector('#login-recovery-modal');
    const recoveryEntryModal = document.querySelector('#login-recovery-entry-modal');
    const recoveryLostModal = document.querySelector('#login-recovery-lost-modal');
    const recoveryForm = document.querySelector('#login-recovery-form');
    const recoveryError = document.querySelector('#login-recovery-error');
    const recoverySubmit = document.querySelector('#login-recovery-submit');
    const recoveryNotice = document.querySelector('#recovery-signin-notice');
    const recoveryEntry = window.VylkRecoveryEntry.create({
      document,
      input: document.querySelector('#login-recovery-word'),
      label: document.querySelector('#login-recovery-word-label'),
      list: document.querySelector('#login-recovery-words'),
      count: document.querySelector('#login-recovery-count'),
      submit: recoverySubmit,
      onError: (message) => {
        recoveryError.textContent = message;
      },
    });

    async function completeSignIn(result, usedRecovery = false) {
      document.querySelector('#login-password').value = '';
      document.querySelector('#login-error').textContent = '';
      cacheVersion(result);
      if (!result.offline) await handleServerIdentity(result.instance_id);
      if (vaultSession.config()?.mode === 'preparing') {
        await vaultSetup.open();
        return;
      }
      if (!result.offline) await loadPreferences();
      await restoreRoute({fetchRemote: !result.offline});
      if (!result.offline) {
        connectEvents();
        scheduleSync({reconcile: true});
      }
      if (usedRecovery) recoveryNotice.hidden = false;
    }

    function closeRecovery() {
      if (recoverySubmit.disabled && recoverySubmit.textContent === 'Signing in…') return;
      closeModal(recoveryModal);
      recoveryEntry.clear();
    }

    function closeRecoveryEntry() {
      if (recoverySubmit.disabled && recoverySubmit.textContent === 'Signing in…') return;
      closeModal(recoveryEntryModal);
      recoveryEntry.clear();
    }

    function closeRecoveryLost() {
      closeModal(recoveryLostModal);
    }

    document.querySelector('#login-forgot-password').addEventListener('click', () => {
      recoveryEntry.clear();
      openModal(recoveryModal);
    });
    document.querySelector('#login-recovery-close').addEventListener('click', closeRecovery);
    recoveryModal.querySelector('.modal-backdrop').addEventListener('click', closeRecovery);
    document.querySelector('#login-have-recovery').addEventListener('click', () => {
      openModal(recoveryEntryModal);
      document.querySelector('#login-recovery-word').focus({preventScroll: true});
    });
    document
      .querySelector('#login-no-recovery')
      .addEventListener('click', () => openModal(recoveryLostModal));
    document
      .querySelector('#login-recovery-entry-close')
      .addEventListener('click', closeRecoveryEntry);
    recoveryEntryModal
      .querySelector('.modal-backdrop')
      .addEventListener('click', closeRecoveryEntry);
    document.querySelector('#login-recovery-back').addEventListener('click', closeRecoveryEntry);
    document
      .querySelector('#login-recovery-lost-close')
      .addEventListener('click', closeRecoveryLost);
    recoveryLostModal.querySelector('.modal-backdrop').addEventListener('click', closeRecoveryLost);
    document
      .querySelector('#login-recovery-lost-back')
      .addEventListener('click', closeRecoveryLost);
    document
      .querySelector('#login-recovery-add')
      .addEventListener('click', recoveryEntry.addCurrent);
    recoveryForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!recoveryEntry.ready()) return;
      recoverySubmit.disabled = true;
      recoverySubmit.textContent = 'Signing in…';
      recoveryError.textContent = '';
      try {
        setAuthenticationRequired(false);
        clearDiagnostic();
        if (!vaultSession.config()) await vaultSession.bootstrap();
        if (vaultSession.requiresSecureContext()) {
          showLogin();
          return;
        }
        const result = await vaultSession.unlock(recoveryEntry.value(), {
          recovery: true,
          remember: false,
        });
        await completeSignIn(result, true);
        closeModal(recoveryEntryModal);
        closeModal(recoveryModal);
        recoveryEntry.clear();
      } catch (error) {
        recoveryError.textContent =
          error.code === 'invalid_credentials' || error.name === 'OperationError'
            ? 'That recovery key did not unlock your notes. Check the words and their order.'
            : error.code === 'login_rate_limited'
              ? 'Too many attempts. Please try again later.'
              : error.kind === 'network' || error.kind === 'timeout'
                ? 'Could not reach Vylk. Reconnect and try again.'
                : /24 words/i.test(error.message || '')
                  ? 'Check that your recovery key has the correct 24 words in order.'
                  : 'Could not sign in. Please try again.';
      } finally {
        recoverySubmit.textContent = 'Sign in';
        recoverySubmit.disabled = !recoveryEntry.ready();
      }
    });

    document.querySelector('#recovery-dismiss-notice').addEventListener('click', () => {
      recoveryNotice.hidden = true;
    });
    document.querySelector('#recovery-change-passphrase').addEventListener('click', () => {
      recoveryNotice.hidden = true;
      void openPassphrasePreferences();
    });

    document.querySelector('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthenticationRequired(false);
      clearDiagnostic();
      try {
        if (!vaultSession.config()) await vaultSession.bootstrap();
        if (vaultSession.requiresSecureContext()) {
          showLogin();
          return;
        }
        const result = vaultSession.encrypted()
          ? await vaultSession.unlock(event.target.password.value, {
              remember: false,
            })
          : await api('/api/login', {
              method: 'POST',
              body: JSON.stringify({password: event.target.password.value}),
            });
        await completeSignIn(result);
      } catch (error) {
        document.querySelector('#login-error').textContent =
          error.code === 'invalid_credentials'
            ? 'Wrong passphrase'
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
        await beforeSignOut();
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
        } finally {
          vaultSession.lock();
        }
        localStorage.removeItem('vylk-offline-ready');
        localStorage.removeItem('vylk-prefs');
        recoveryNotice.hidden = true;
        closeLogout();
        showLogin();
      } catch (error) {
        showToast(error.message || 'Could not sign out. Please try again.', 'warning');
      } finally {
        this.disabled = false;
      }
    });
  }

  global.VylkAuth = {bind};
})(typeof window !== 'undefined' ? window : globalThis);
