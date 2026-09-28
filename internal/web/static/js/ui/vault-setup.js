(function (root) {
  'use strict';

  let estimatorPromise;

  function loadEstimator() {
    if (root.zxcvbn) return Promise.resolve(root.zxcvbn);
    if (!estimatorPromise) {
      estimatorPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/zxcvbn.js';
        script.onload = () =>
          root.zxcvbn
            ? resolve(root.zxcvbn)
            : reject(new Error('Passphrase strength could not be checked.'));
        script.onerror = () => reject(new Error('could not load passphrase strength checker'));
        document.head.append(script);
      });
    }
    return estimatorPromise;
  }

  function normalizeRecoveryKey(value) {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function setupErrorMessage(cause, resetMode) {
    if (cause?.vaultResetState === 'created')
      return 'Your new vault was created, but this device could not finish setup. Reload Vylk and sign in with the new passphrase.';
    if (cause?.vaultResetState === 'unknown')
      return 'Vylk lost contact while starting the new vault, so it could not confirm the result. Reload before trying again. If sign-in appears, use the new passphrase you just created.';
    if (
      cause?.code === 'invalid_vault_reset' ||
      /invalid base64url value|invalidcharactererror/i.test(cause?.message || '')
    ) {
      if (!resetMode)
        return 'Vylk could not read the encryption setup information. Reload and try again; your notes are still available.';
      return 'Vylk could not prepare the new vault. Close this window and try again; your current vault has not been changed.';
    }
    return (
      cause?.message ||
      (resetMode
        ? 'Could not finish setting up the new vault. Please try again.'
        : 'Conversion stopped. Your original notes remain available for retry.')
    );
  }

  function bind({
    vaultSession,
    showEncryption,
    document,
    openModal,
    closeModal,
    onDismiss = () => {},
    beforeMigration = async () => {},
    onComplete,
  }) {
    const form = document.querySelector('#vault-setup-form');
    const master = document.querySelector('#vault-master');
    const oldPassword = document.querySelector('#vault-old-password');
    const recoveryDisplay = document.querySelector('#vault-recovery-key');
    const recoveryConfirm = document.querySelector('#vault-recovery-confirm');
    const progress = document.querySelector('#vault-progress');
    const error = document.querySelector('#vault-error');
    const setupModal = document.querySelector('#vault-setup-modal');
    const masterModal = document.querySelector('#vault-master-modal');
    const recoveryModal = document.querySelector('#vault-recovery-modal');
    const resetWarning = document.querySelector('#vault-reset-warning');
    const resetAck = document.querySelector('#vault-reset-ack');
    const weakConfirm = document.querySelector('#vault-weak-confirm');
    const weakConfirmRow = document.querySelector('#vault-weak-confirm-row');
    const newWeakConfirm = document.querySelector('#vault-new-weak-confirm');
    const newWeakConfirmRow = document.querySelector('#vault-new-weak-confirm-row');
    const masterForm = document.querySelector('#vault-master-form');
    const recoveryForm = document.querySelector('#vault-recovery-form');
    const currentSecret = document.querySelector('#vault-master-current-secret');
    const newMaster = document.querySelector('#vault-new-master');
    const masterMethods = document.querySelector('#vault-master-methods');
    const masterFields = document.querySelector('#vault-master-fields');
    const recoveryMethods = document.querySelector('#vault-recovery-methods');
    const recoveryFields = document.querySelector('#vault-recovery-fields');
    const masterSubmit = document.querySelector('#vault-master-submit');
    const newRecoveryDisplay = document.querySelector('#vault-new-recovery-key');
    const newRecoveryStep = document.querySelector('#vault-new-recovery-step');
    const recoveryVerify = document.querySelector('#vault-recovery-verify');
    const recoverySubmit = document.querySelector('#vault-recovery-submit');
    const recoveryCurrent = document.querySelector('#vault-recovery-current-secret');
    const masterError = document.querySelector('#vault-master-error');
    const recoveryError = document.querySelector('#vault-recovery-error');
    let generatedRecoveryKey = '';
    let running = false;
    let generatedNewRecovery = '';
    let masterMethod = null;
    let recoveryMethod = null;
    let credentialRunning = false;
    let setupGeneration = 0;
    let setupInitialized = false;
    let resetMode = false;

    for (const field of [master, newMaster]) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
      });
    }

    function refresh() {
      const mode = vaultSession.config()?.mode || 'legacy';
      const encrypted = mode === 'encrypted';
      document.querySelector('#login-forgot-password').hidden = !encrypted;
      const loginLabel = document.querySelector('label[for="login-password"]');
      const loginSecret = document.querySelector('#login-password');
      loginLabel.textContent = encrypted ? 'Passphrase' : 'Password';
      loginSecret.placeholder = ' ';
      const loginToggle = document.querySelector('[data-password-toggle="login-password"]');
      loginToggle.dataset.secretName = encrypted ? 'passphrase' : 'password';
      loginToggle.setAttribute(
        'aria-label',
        `${loginSecret.type === 'text' ? 'Hide' : 'Show'} ${loginToggle.dataset.secretName}`,
      );
      document.querySelector('#account-signout-copy').textContent = encrypted
        ? 'Sign out and forget this device’s key. Encrypted offline edits stay here.'
        : 'Sign out and remove this device’s local data.';
      document.querySelector('#logout-copy').textContent = encrypted
        ? 'This ends your session and forgets this device’s key. Encrypted offline edits remain for your next sign-in.'
        : 'This ends your session and removes this device’s local note data.';
      document.querySelector('#vault-status-copy').textContent = encrypted
        ? 'End-to-end encryption is on'
        : mode === 'preparing'
          ? 'Setup is paused'
          : 'End-to-end encryption is off';
      document.querySelector('#vault-overview-copy').textContent = encrypted
        ? 'Your notes are protected across devices.'
        : mode === 'preparing'
          ? 'Finish setup to protect your notes.'
          : 'Protect your notes across devices.';
      document.querySelector('#vault-inactive').hidden = encrypted;
      document.querySelector('#vault-active').hidden = !encrypted;
      document.querySelector('#vault-title').textContent =
        mode === 'preparing' ? 'Resume encryption' : 'Set up encryption';
    }

    function configureSetupMode() {
      const title = document.querySelector('#vault-setup-modal-title');
      const action = document.querySelector('#vault-start');
      const passwordLabel = document.querySelector('#vault-old-password-label span');
      title.textContent = resetMode ? 'Start a new empty vault' : 'Set up encryption';
      action.textContent = resetMode ? 'Create empty vault' : 'Encrypt notes';
      passwordLabel.textContent = resetMode ? 'Vylk password' : 'Current Vylk password';
      resetWarning.hidden = !resetMode;
      document.querySelector('#vault-reset-ack-row').hidden = !resetMode;
      resetAck.required = resetMode;
    }

    async function assessStrength() {
      if (!master.value) {
        const element = document.querySelector('#vault-strength');
        element.textContent = '';
        delete element.dataset.score;
        weakConfirmRow.hidden = true;
        weakConfirm.checked = false;
        return 0;
      }
      const element = document.querySelector('#vault-strength');
      let score = 0;
      try {
        const estimator = await loadEstimator();
        const result = estimator(master.value, [oldPassword.value, 'vylk']);
        score = result.score;
        element.textContent =
          score === 4
            ? 'Strong passphrase'
            : result.feedback?.warning || result.feedback?.suggestions?.[0] || 'Easy to guess';
      } catch (_) {
        element.textContent = 'Passphrase strength could not be checked.';
      }
      element.dataset.score = String(score);
      weakConfirmRow.hidden =
        score === 4 || vaultSession.config()?.require_strong_passwords === true;
      if (weakConfirmRow.hidden) weakConfirm.checked = false;
      return score;
    }

    async function open() {
      refresh();
      configureSetupMode();
      if (!resetMode) await showEncryption();
      if (setupInitialized) {
        openModal(setupModal);
        return;
      }
      setupInitialized = true;
      const resuming = !resetMode && vaultSession.config()?.mode === 'preparing';
      error.textContent = '';
      progress.textContent = '';
      form.reset();
      resetAck.checked = false;
      generatedRecoveryKey = '';
      recoveryDisplay.textContent = resuming
        ? 'Enter the 24 words from the recovery key you saved when you started.'
        : 'Preparing your recovery key…';
      openModal(setupModal);
      oldPassword.focus({preventScroll: true});
      const generation = ++setupGeneration;
      try {
        if (!resuming) {
          generatedRecoveryKey = await root.VylkVaultCrypto.createRecoveryKey(
            root.VylkVaultCrypto.randomBytes(32),
          );
          if (setupModal.classList.contains('hidden') || generation !== setupGeneration) return;
          recoveryDisplay.textContent = generatedRecoveryKey;
        }
      } catch (cause) {
        error.textContent = cause.message;
      }
    }

    function close() {
      if (running) return;
      setupInitialized = false;
      ++setupGeneration;
      form.reset();
      generatedRecoveryKey = '';
      resetMode = false;
      configureSetupMode();
      recoveryDisplay.textContent = '';
      error.textContent = '';
      progress.textContent = '';
    }

    async function assessNewMaster() {
      if (!newMaster.value) {
        const element = document.querySelector('#vault-new-master-strength');
        element.textContent = '';
        delete element.dataset.score;
        newWeakConfirmRow.hidden = true;
        newWeakConfirm.checked = false;
        return 0;
      }
      const element = document.querySelector('#vault-new-master-strength');
      let score = 0;
      try {
        const estimator = await loadEstimator();
        const result = estimator(newMaster.value, [currentSecret.value, 'vylk']);
        score = result.score;
        element.textContent =
          score === 4
            ? 'Strong passphrase'
            : result.feedback?.warning || result.feedback?.suggestions?.[0] || 'Easy to guess';
      } catch (_) {
        element.textContent = 'Passphrase strength could not be checked.';
      }
      element.dataset.score = String(score);
      newWeakConfirmRow.hidden =
        score === 4 || vaultSession.config()?.require_strong_passwords === true;
      if (newWeakConfirmRow.hidden) newWeakConfirm.checked = false;
      return score;
    }

    async function openMaster() {
      await showEncryption();
      masterForm.reset();
      resetMasterMethod();
      updateCurrentChoice('master');
      masterError.textContent = '';
      openModal(masterModal);
      masterMethods.querySelector('button').focus({preventScroll: true});
    }

    function resetMasterMethod() {
      masterMethod = null;
      masterMethods.hidden = false;
      masterFields.hidden = true;
      masterSubmit.hidden = true;
      currentSecret.value = '';
      masterError.textContent = '';
    }

    function chooseMasterMethod(method) {
      if (credentialRunning) return;
      masterMethod = method;
      masterMethods.hidden = true;
      masterFields.hidden = false;
      masterSubmit.hidden = false;
      document.querySelector('#vault-master-method-label').textContent =
        method === 'recovery' ? 'Using your recovery key' : 'Using your encryption passphrase';
      updateCurrentChoice('master');
      currentSecret.focus({preventScroll: true});
    }

    async function openRecovery() {
      await showEncryption();
      recoveryForm.reset();
      resetRecoveryMethod();
      updateCurrentChoice('recovery');
      recoveryError.textContent = '';
      hideNewRecovery();
      openModal(recoveryModal);
      recoveryMethods.querySelector('button').focus({preventScroll: true});
    }

    function resetRecoveryMethod() {
      recoveryMethod = null;
      recoveryMethods.hidden = false;
      recoveryFields.hidden = true;
      recoveryVerify.hidden = true;
      recoverySubmit.hidden = true;
      recoveryCurrent.value = '';
      recoveryError.textContent = '';
      hideNewRecovery();
    }

    function chooseRecoveryMethod(method) {
      if (credentialRunning) return;
      recoveryMethod = method;
      recoveryMethods.hidden = true;
      recoveryFields.hidden = false;
      recoveryVerify.hidden = false;
      document.querySelector('#vault-recovery-method-label').textContent =
        method === 'recovery' ? 'Using your recovery key' : 'Using your encryption passphrase';
      updateCurrentChoice('recovery');
      recoveryCurrent.focus({preventScroll: true});
    }

    function hideNewRecovery() {
      generatedNewRecovery = '';
      newRecoveryDisplay.textContent = '';
      document.querySelector('#vault-new-recovery-confirm').value = '';
      newRecoveryStep.hidden = true;
      recoveryVerify.hidden = !recoveryMethod;
      recoverySubmit.hidden = true;
    }

    async function verifyCurrentForRecovery() {
      if (credentialRunning || !recoveryMethod) return;
      recoveryError.textContent = '';
      if (!recoveryCurrent.value) {
        recoveryError.textContent = 'Enter your passphrase or recovery key to continue.';
        recoveryCurrent.focus();
        return;
      }
      credentialRunning = true;
      recoveryVerify.disabled = true;
      const currentValue = recoveryCurrent.value;
      const currentKind = selectedCurrentChoice('recovery');
      try {
        await vaultSession.verifyCredential(currentValue, currentKind === 'recovery');
        const next = await root.VylkVaultCrypto.createRecoveryKey(
          root.VylkVaultCrypto.randomBytes(32),
        );
        if (
          recoveryCurrent.value !== currentValue ||
          selectedCurrentChoice('recovery') !== currentKind
        )
          return;
        generatedNewRecovery = next;
        newRecoveryDisplay.textContent = next;
        newRecoveryStep.hidden = false;
        recoveryVerify.hidden = true;
        recoverySubmit.hidden = false;
        document.querySelector('#vault-new-recovery-confirm').focus({preventScroll: true});
      } catch (cause) {
        recoveryError.textContent =
          cause?.name === 'OperationError' ||
          /invalid recovery key|encrypted data failed authentication/i.test(cause?.message || '')
            ? 'That passphrase or recovery key is incorrect.'
            : cause?.message || 'Could not check your current passphrase or recovery key.';
      } finally {
        credentialRunning = false;
        recoveryVerify.disabled = false;
      }
    }

    function closeCredential(kind) {
      if (kind === 'master') {
        masterForm.reset();
        resetMasterMethod();
        updateCurrentChoice('master');
        masterError.textContent = '';
        document.querySelector('#vault-new-master-strength').textContent = '';
        return;
      }
      recoveryForm.reset();
      resetRecoveryMethod();
      updateCurrentChoice('recovery');
      recoveryError.textContent = '';
      hideNewRecovery();
    }

    function selectedCurrentChoice(kind) {
      if (kind === 'master') return masterMethod;
      return recoveryMethod;
    }

    function updateCurrentChoice(kind) {
      const input = document.querySelector(`#vault-${kind}-current-secret`);
      const recovery = selectedCurrentChoice(kind) === 'recovery';
      document.querySelector(`#vault-${kind}-current-label`).textContent = recovery
        ? 'Recovery key'
        : 'Passphrase';
      input.autocomplete = recovery ? 'off' : 'current-password';
      input.value = '';
      const toggle = document.querySelector(
        `[data-password-toggle="vault-${kind}-current-secret"]`,
      );
      toggle.dataset.secretName = recovery ? 'recovery key' : 'passphrase';
      toggle.setAttribute('aria-label', `Show ${toggle.dataset.secretName}`);
      document.querySelector(`#vault-${kind}-error`).textContent = '';
      if (kind === 'recovery') hideNewRecovery();
    }

    masterMethods.querySelectorAll('[data-vault-master-method]').forEach((button) => {
      button.addEventListener('click', () => chooseMasterMethod(button.dataset.vaultMasterMethod));
    });
    recoveryMethods.querySelectorAll('[data-vault-recovery-method]').forEach((button) => {
      button.addEventListener('click', () =>
        chooseRecoveryMethod(button.dataset.vaultRecoveryMethod),
      );
    });
    document.querySelector('#vault-master-change-method').addEventListener('click', () => {
      if (credentialRunning) return;
      resetMasterMethod();
      masterMethods.querySelector('button').focus({preventScroll: true});
    });
    document.querySelector('#vault-recovery-change-method').addEventListener('click', () => {
      if (credentialRunning) return;
      resetRecoveryMethod();
      recoveryMethods.querySelector('button').focus({preventScroll: true});
    });
    function openDetail(detail) {
      const modal = {
        setup: setupModal,
        passphrase: masterModal,
        recovery: recoveryModal,
      }[detail];
      if (
        !modal ||
        (!modal.classList.contains('hidden') && !modal.classList.contains('is-closing'))
      )
        return;
      if (detail === 'setup') void open();
      else if (detail === 'passphrase') openMaster();
      else void openRecovery();
    }
    function dismiss(modal, {updateRoute = true} = {}) {
      if (running || credentialRunning) return;
      if (modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
      const wasReset = resetMode;
      if (modal === setupModal) close();
      else closeCredential(modal === masterModal ? 'master' : 'recovery');
      closeModal(modal);
      if (updateRoute && !wasReset) onDismiss();
    }
    function closeForRoute() {
      for (const modal of [setupModal, masterModal, recoveryModal])
        dismiss(modal, {updateRoute: false});
    }
    for (const [modal, cancelID] of [
      [setupModal, '#vault-setup-cancel'],
      [masterModal, '#vault-master-cancel'],
      [recoveryModal, '#vault-recovery-cancel'],
    ]) {
      modal.querySelector('.modal-backdrop').addEventListener('click', () => dismiss(modal));
      modal.querySelector('.modal-close').addEventListener('click', () => dismiss(modal));
      document.querySelector(cancelID).addEventListener('click', () => dismiss(modal));
    }
    master.addEventListener('input', () => {
      void assessStrength();
    });
    oldPassword.addEventListener('input', () => void assessStrength());
    document.querySelector('#vault-copy-recovery').addEventListener('click', async () => {
      if (!generatedRecoveryKey) return;
      try {
        await navigator.clipboard.writeText(generatedRecoveryKey);
        progress.textContent = 'Recovery key copied. Keep it somewhere private.';
      } catch (_) {
        error.textContent = 'Copy failed. Select and write down the recovery key.';
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (running) return;
      error.textContent = '';
      const chosen = master.value;
      const recoveryKey = generatedRecoveryKey || normalizeRecoveryKey(recoveryConfirm.value);
      if (!generatedRecoveryKey && vaultSession.config()?.mode !== 'preparing') {
        error.textContent = 'Could not prepare your recovery key. Close this window and try again.';
        return;
      }
      if (chosen !== document.querySelector('#vault-master-confirm').value) {
        error.textContent = 'Passphrases do not match.';
        return;
      }
      const score = await assessStrength();
      if (
        chosen === oldPassword.value ||
        (score !== 4 && vaultSession.config()?.require_strong_passwords === true)
      ) {
        error.textContent = 'Choose a strong passphrase different from your Vylk sign-in password.';
        return;
      }
      if (score < 4 && !weakConfirm.checked) {
        error.textContent = 'Confirm that you understand this passphrase is easy to guess.';
        weakConfirm.focus();
        return;
      }
      if (normalizeRecoveryKey(recoveryConfirm.value) !== normalizeRecoveryKey(recoveryKey)) {
        error.textContent = 'Enter all 24 words to confirm you saved the recovery key.';
        return;
      }
      if (resetMode && !resetAck.checked) {
        error.textContent = 'Confirm that you understand the old notes cannot be recovered.';
        return;
      }
      running = true;
      document.querySelector('#vault-start').disabled = true;
      try {
        if (resetMode) {
          progress.textContent = 'Creating a new empty vault…';
          await vaultSession.reset({
            password: oldPassword.value,
            master: chosen,
            recoveryKey,
            remember: false,
          });
        } else {
          await beforeMigration();
          await vaultSession.migrate({
            oldPassword: oldPassword.value,
            master: chosen,
            recoveryKey,
            remember: false,
            onProgress: (message) => {
              progress.textContent = message;
            },
          });
        }
        form.reset();
        generatedRecoveryKey = '';
        recoveryDisplay.textContent = '';
        resetMode = false;
        configureSetupMode();
        closeModal(setupModal);
        refresh();
        onComplete();
      } catch (cause) {
        error.textContent = setupErrorMessage(cause, resetMode);
      } finally {
        running = false;
        document.querySelector('#vault-start').disabled = false;
      }
    });
    newMaster.addEventListener('input', () => {
      void assessNewMaster();
    });
    currentSecret.addEventListener('input', () => void assessNewMaster());
    recoveryCurrent.addEventListener('input', () => hideNewRecovery());
    recoveryVerify.addEventListener('click', () => void verifyCurrentForRecovery());
    document.querySelector('#vault-new-recovery-copy').addEventListener('click', async () => {
      if (!generatedNewRecovery) return;
      try {
        await navigator.clipboard.writeText(generatedNewRecovery);
      } catch (_) {
        recoveryError.textContent = 'Copy failed. Select and write down the recovery key.';
      }
    });
    async function saveCredential(event, kind) {
      event.preventDefault();
      if (credentialRunning) return;
      if (kind === 'recovery' && !generatedNewRecovery) {
        await verifyCurrentForRecovery();
        return;
      }
      if (kind === 'master' && !masterMethod) return;
      const isMaster = kind === 'master';
      const current = document.querySelector(
        isMaster ? '#vault-master-current-secret' : '#vault-recovery-current-secret',
      );
      const error = isMaster ? masterError : recoveryError;
      const submit = document.querySelector(
        isMaster ? '#vault-master-submit' : '#vault-recovery-submit',
      );
      error.textContent = '';
      let next = generatedNewRecovery;
      if (isMaster) {
        next = newMaster.value;
      } else if (!next) {
        error.textContent = 'Could not prepare your recovery key. Close this window and try again.';
        return;
      }
      if (isMaster) {
        const score = await assessNewMaster();
        if (
          next !== document.querySelector('#vault-new-master-confirm').value ||
          next === current.value ||
          (score !== 4 && vaultSession.config()?.require_strong_passwords === true)
        ) {
          error.textContent = 'Confirm a strong passphrase different from the current one.';
          return;
        }
        if (score < 4 && !newWeakConfirm.checked) {
          error.textContent = 'Confirm that you understand this passphrase is easy to guess.';
          newWeakConfirm.focus();
          return;
        }
      } else if (
        normalizeRecoveryKey(next) !==
        normalizeRecoveryKey(document.querySelector('#vault-new-recovery-confirm').value)
      ) {
        error.textContent = 'Enter all 24 words to confirm you saved the recovery key.';
        return;
      }
      credentialRunning = true;
      submit.disabled = true;
      try {
        await vaultSession.changeCredential({
          kind,
          currentSecret: current.value,
          currentRecovery: selectedCurrentChoice(kind) === 'recovery',
          newSecret: next,
        });
        closeCredential(kind);
        const modal = isMaster ? masterModal : recoveryModal;
        closeModal(modal);
        onComplete();
      } catch (cause) {
        error.textContent = cause.message || 'Could not change the vault credential.';
      } finally {
        credentialRunning = false;
        submit.disabled = false;
      }
    }
    masterForm.addEventListener('submit', (event) => void saveCredential(event, 'master'));
    recoveryForm.addEventListener('submit', (event) => void saveCredential(event, 'recovery'));
    return {
      busy: () => running || credentialRunning,
      closeDialog: dismiss,
      closeForRoute,
      open,
      openDetail,
      openMaster,
      openRecovery,
      refresh,
    };
  }

  root.VylkVaultSetup = {bind, formatError: setupErrorMessage};
})(globalThis);
