(function (root) {
  'use strict';

  let estimatorPromise;

  function loadEstimator() {
    if (root.zxcvbn) return Promise.resolve(root.zxcvbn);
    if (!estimatorPromise) {
      const script = document.createElement('script');
      estimatorPromise = new Promise((resolve, reject) => {
        script.src = '/vendor/zxcvbn.js';
        script.onload = () =>
          root.zxcvbn
            ? resolve(root.zxcvbn)
            : reject(new Error('Passphrase strength could not be checked.'));
        script.onerror = () => reject(new Error('could not load passphrase strength checker'));
        document.head.append(script);
      })
        .catch((error) => {
          // A failed resource fetch must not poison later checks after reconnect.
          estimatorPromise = null;
          throw error;
        })
        .finally(() => {
          script.onload = null;
          script.onerror = null;
          script.remove();
        });
    }
    return estimatorPromise;
  }

  function showRecoveryWords(document, list, key) {
    list.replaceChildren();
    if (!key) return;
    for (const [index, word] of key.split(' ').entries()) {
      const item = document.createElement('li');
      const number = document.createElement('span');
      number.className = 'vault-recovery-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const value = document.createElement('span');
      value.className = 'vault-recovery-word';
      value.textContent = word;
      item.append(number, value);
      list.append(item);
    }
  }

  function formatRecoveryKey(key) {
    const numbered = key.split(' ').map((word, index) => `${index + 1}. ${word}`);
    return [
      'Vylk recovery key',
      'Keep this file private. Anyone with these words can unlock your notes.',
      '',
      ...numbered,
      '',
    ].join('\n');
  }

  function downloadRecoveryKey(document, key) {
    const content = formatRecoveryKey(key);
    const url = root.URL.createObjectURL(
      new root.Blob([content], {type: 'text/plain;charset=utf-8'}),
    );
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
    ].join('');
    link.download = `vylk-recovery-key-${timestamp}.txt`;
    link.click();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
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
    beforeCredentialChange = async () => {},
    afterCredentialChange = () => {},
    onCredentialChanged = onComplete,
  }) {
    const form = document.querySelector('#vault-setup-form');
    const master = document.querySelector('#vault-master');
    const oldPassword = document.querySelector('#vault-old-password');
    const recoveryDisplay = document.querySelector('#vault-recovery-key');
    const recoveryDisplayStep = document.querySelector('#vault-recovery-display');
    const recoveryEntryStep = document.querySelector('#vault-recovery-entry-step');
    const recoveryDownload = document.querySelector('#vault-download-recovery');
    const recoveryBegin = document.querySelector('#vault-recovery-begin');
    const progress = document.querySelector('#vault-progress');
    const error = document.querySelector('#vault-error');
    const setupModal = document.querySelector('#vault-setup-modal');
    const finalConfirmModal = document.querySelector('#vault-final-confirm-modal');
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
    const masterCurrentField = document.querySelector('#vault-master-current-field');
    const masterCurrentRecovery = document.querySelector('#vault-master-current-recovery');
    const masterMethodSummary = document.querySelector('#vault-master-method-summary');
    const masterNewFields = document.querySelector('#vault-master-new-fields');
    const masterVerify = document.querySelector('#vault-master-verify');
    const masterMethods = document.querySelector('#vault-master-methods');
    const masterFields = document.querySelector('#vault-master-fields');
    const recoveryMethods = document.querySelector('#vault-recovery-methods');
    const recoveryFields = document.querySelector('#vault-recovery-fields');
    const masterSubmit = document.querySelector('#vault-master-submit');
    const newRecoveryDisplay = document.querySelector('#vault-new-recovery-key');
    const newRecoveryStep = document.querySelector('#vault-new-recovery-step');
    const newRecoveryDisplayStep = document.querySelector('#vault-new-recovery-display');
    const newRecoveryEntryStep = document.querySelector('#vault-new-recovery-entry-step');
    const recoveryVerify = document.querySelector('#vault-recovery-verify');
    const recoverySubmit = document.querySelector('#vault-recovery-submit');
    const recoveryCurrent = document.querySelector('#vault-recovery-current-secret');
    const recoveryCurrentField = document.querySelector('#vault-recovery-current-field');
    const recoveryCurrentRecovery = document.querySelector('#vault-recovery-current-recovery');
    const recoveryMethodSummary = document.querySelector('#vault-recovery-method-summary');
    const recoveryFormActions = document.querySelector('#vault-recovery-form-actions');
    const masterError = document.querySelector('#vault-master-error');
    const recoveryError = document.querySelector('#vault-recovery-error');
    let generatedRecoveryKey = '';
    let running = false;
    let generatedNewRecovery = '';
    let masterMethod = null;
    let verifiedMasterSecret = '';
    let recoveryMethod = null;
    let credentialRunning = false;
    let setupGeneration = 0;
    let setupInitialized = false;
    let resetMode = false;
    const recoveryEntry = root.VylkRecoveryEntry.create({
      document,
      input: document.querySelector('#vault-recovery-confirm'),
      label: document.querySelector('#vault-recovery-confirm-label'),
      list: document.querySelector('#vault-recovery-entered'),
      count: document.querySelector('#vault-recovery-count'),
      confirmation: true,
      onError: (message) => {
        error.textContent = message;
      },
    });
    const masterRecoveryEntry = root.VylkRecoveryEntry.create({
      document,
      input: document.querySelector('#vault-master-recovery-word'),
      label: document.querySelector('#vault-master-recovery-word-label'),
      list: document.querySelector('#vault-master-recovery-words'),
      count: document.querySelector('#vault-master-recovery-count'),
      onError: (message) => {
        masterError.textContent = message;
      },
    });
    const recoveryCurrentEntry = root.VylkRecoveryEntry.create({
      document,
      input: document.querySelector('#vault-recovery-current-word'),
      label: document.querySelector('#vault-recovery-current-word-label'),
      list: document.querySelector('#vault-recovery-current-words'),
      count: document.querySelector('#vault-recovery-current-count'),
      onError: (message) => {
        recoveryError.textContent = message;
      },
    });
    const newRecoveryEntry = root.VylkRecoveryEntry.create({
      document,
      input: document.querySelector('#vault-new-recovery-confirm'),
      label: document.querySelector('#vault-new-recovery-confirm-label'),
      list: document.querySelector('#vault-new-recovery-entered'),
      count: document.querySelector('#vault-new-recovery-count'),
      confirmation: true,
      onError: (message) => {
        recoveryError.textContent = message;
      },
      onChange: (ready) => {
        if (!newRecoveryEntryStep.hidden) recoveryFormActions.hidden = !ready;
      },
    });

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
      const insecure = root.isSecureContext === false;
      document.querySelector('#vault-open-setup').disabled = insecure;
      document.querySelector('.vault-secure-context-note').hidden = !insecure;
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
      if (root.isSecureContext === false) return;
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
      recoveryDownload.disabled = true;
      recoveryBegin.disabled = true;
      recoveryEntry.setConfirmation(!resuming);
      recoveryEntry.clear();
      showRecoveryWords(document, recoveryDisplay, '');
      recoveryDisplayStep.hidden = resuming;
      recoveryEntryStep.hidden = !resuming;
      document.querySelector('#vault-recovery-heading').textContent = resuming
        ? 'Enter your saved recovery key'
        : 'Write down your recovery key';
      openModal(setupModal);
      oldPassword.focus({preventScroll: true});
      const generation = ++setupGeneration;
      try {
        if (!resuming) {
          const key = await root.VylkVaultCrypto.createRecoveryKey(
            root.VylkVaultCrypto.randomBytes(32),
          );
          if (setupModal.classList.contains('hidden') || generation !== setupGeneration) return;
          generatedRecoveryKey = key;
          showRecoveryWords(document, recoveryDisplay, generatedRecoveryKey);
          recoveryDownload.disabled = false;
          recoveryBegin.disabled = false;
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
      recoveryDownload.disabled = true;
      recoveryBegin.disabled = true;
      recoveryEntry.clear();
      resetMode = false;
      configureSetupMode();
      showRecoveryWords(document, recoveryDisplay, '');
      recoveryDisplayStep.hidden = false;
      recoveryEntryStep.hidden = true;
      document.querySelector('#vault-recovery-heading').textContent =
        'Write down your recovery key';
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
        const result = estimator(newMaster.value, [verifiedMasterSecret, 'vylk']);
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
      verifiedMasterSecret = '';
      masterMethods.hidden = false;
      masterFields.hidden = true;
      masterCurrentField.hidden = false;
      masterCurrentRecovery.hidden = true;
      masterMethodSummary.hidden = false;
      masterNewFields.hidden = true;
      masterVerify.hidden = true;
      masterSubmit.hidden = true;
      currentSecret.value = '';
      masterRecoveryEntry.clear();
      newMaster.value = '';
      newMaster.required = false;
      document.querySelector('#vault-new-master-confirm').value = '';
      document.querySelector('#vault-new-master-confirm').required = false;
      newWeakConfirm.checked = false;
      newWeakConfirmRow.hidden = true;
      document.querySelector('#vault-new-master-strength').textContent = '';
      masterError.textContent = '';
    }

    function chooseMasterMethod(method) {
      if (credentialRunning) return;
      masterMethod = method;
      masterMethods.hidden = true;
      masterFields.hidden = false;
      masterCurrentField.hidden = method === 'recovery';
      masterCurrentRecovery.hidden = method !== 'recovery';
      masterVerify.hidden = false;
      document.querySelector('#vault-master-method-label').textContent =
        method === 'recovery' ? 'Using your recovery key' : 'Using your encryption passphrase';
      updateCurrentChoice('master');
      (method === 'recovery'
        ? document.querySelector('#vault-master-recovery-word')
        : currentSecret
      ).focus({preventScroll: true});
    }

    async function verifyCurrentForMaster() {
      if (credentialRunning || !masterMethod) return;
      const usingRecovery = masterMethod === 'recovery';
      const secret = usingRecovery ? masterRecoveryEntry.value() : currentSecret.value;
      masterError.textContent = '';
      if (!secret || (usingRecovery && !masterRecoveryEntry.ready())) {
        masterError.textContent = usingRecovery
          ? 'Enter all 24 recovery words to continue.'
          : 'Enter your current passphrase to continue.';
        (usingRecovery
          ? document.querySelector('#vault-master-recovery-word')
          : currentSecret
        ).focus();
        return;
      }
      credentialRunning = true;
      masterVerify.disabled = true;
      try {
        await vaultSession.verifyCredential(secret, usingRecovery);
        if (
          masterMethod !== (usingRecovery ? 'recovery' : 'password') ||
          secret !== (usingRecovery ? masterRecoveryEntry.value() : currentSecret.value)
        )
          return;
        verifiedMasterSecret = secret;
        masterCurrentField.hidden = true;
        masterCurrentRecovery.hidden = true;
        masterMethodSummary.hidden = true;
        masterNewFields.hidden = false;
        newMaster.required = true;
        document.querySelector('#vault-new-master-confirm').required = true;
        masterVerify.hidden = true;
        masterSubmit.hidden = false;
        newMaster.focus({preventScroll: true});
      } catch (cause) {
        masterError.textContent =
          cause?.name === 'OperationError' ||
          /invalid recovery key|encrypted data failed authentication/i.test(cause?.message || '')
            ? 'That passphrase or recovery key is incorrect.'
            : cause?.message || 'Could not check your passphrase or recovery key.';
      } finally {
        credentialRunning = false;
        masterVerify.disabled = false;
      }
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
      recoveryCurrentEntry.clear();
      recoveryError.textContent = '';
      hideNewRecovery();
    }

    function chooseRecoveryMethod(method) {
      if (credentialRunning) return;
      recoveryMethod = method;
      recoveryMethods.hidden = true;
      recoveryFields.hidden = false;
      recoveryVerify.hidden = false;
      recoveryCurrentField.hidden = method === 'recovery';
      recoveryCurrentRecovery.hidden = method !== 'recovery';
      recoveryCurrent.required = method === 'password';
      document.querySelector('#vault-recovery-method-label').textContent =
        method === 'recovery' ? 'Using your recovery key' : 'Using your encryption passphrase';
      updateCurrentChoice('recovery');
      (method === 'recovery'
        ? document.querySelector('#vault-recovery-current-word')
        : recoveryCurrent
      ).focus({preventScroll: true});
    }

    function hideNewRecovery() {
      generatedNewRecovery = '';
      showRecoveryWords(document, newRecoveryDisplay, '');
      newRecoveryEntry.clear();
      recoveryCurrentField.hidden = recoveryMethod === 'recovery';
      recoveryCurrentRecovery.hidden = recoveryMethod !== 'recovery';
      recoveryCurrent.required = recoveryMethod === 'password';
      recoveryMethodSummary.hidden = false;
      recoveryFormActions.hidden = false;
      newRecoveryDisplayStep.hidden = false;
      newRecoveryEntryStep.hidden = true;
      document.querySelector('#vault-new-recovery-heading').textContent =
        'Write down your new recovery key';
      newRecoveryStep.hidden = true;
      recoveryVerify.hidden = !recoveryMethod;
      recoverySubmit.hidden = true;
    }

    async function verifyCurrentForRecovery() {
      if (credentialRunning || !recoveryMethod) return;
      const usingRecovery = recoveryMethod === 'recovery';
      const currentValue = usingRecovery ? recoveryCurrentEntry.value() : recoveryCurrent.value;
      recoveryError.textContent = '';
      if (!currentValue || (usingRecovery && !recoveryCurrentEntry.ready())) {
        recoveryError.textContent = usingRecovery
          ? 'Enter all 24 recovery words to continue.'
          : 'Enter your passphrase to continue.';
        (usingRecovery
          ? document.querySelector('#vault-recovery-current-word')
          : recoveryCurrent
        ).focus();
        return;
      }
      credentialRunning = true;
      recoveryVerify.disabled = true;
      const currentKind = selectedCurrentChoice('recovery');
      try {
        await vaultSession.verifyCredential(currentValue, usingRecovery);
        const next = await root.VylkVaultCrypto.createRecoveryKey(
          root.VylkVaultCrypto.randomBytes(32),
        );
        if (
          (usingRecovery ? recoveryCurrentEntry.value() : recoveryCurrent.value) !== currentValue ||
          selectedCurrentChoice('recovery') !== currentKind
        )
          return;
        generatedNewRecovery = next;
        showRecoveryWords(document, newRecoveryDisplay, next);
        newRecoveryStep.hidden = false;
        recoveryVerify.hidden = true;
        recoveryCurrentField.hidden = true;
        recoveryCurrentRecovery.hidden = true;
        recoveryCurrent.required = false;
        recoveryMethodSummary.hidden = true;
        recoveryFormActions.hidden = true;
        document.querySelector('#vault-new-recovery-download').focus({preventScroll: true});
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
      input.value = '';
      if (kind === 'master') masterRecoveryEntry.clear();
      else recoveryCurrentEntry.clear();
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
    document.querySelector('#vault-master-recovery-add').addEventListener('click', () => {
      masterRecoveryEntry.addCurrent();
    });
    document.querySelector('#vault-recovery-current-add').addEventListener('click', () => {
      recoveryCurrentEntry.addCurrent();
    });
    masterVerify.addEventListener('click', () => void verifyCurrentForMaster());
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
      closeModal(finalConfirmModal);
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
    recoveryDownload.addEventListener('click', () => {
      if (generatedRecoveryKey) downloadRecoveryKey(document, generatedRecoveryKey);
    });
    recoveryBegin.addEventListener('click', () => {
      if (!generatedRecoveryKey) return;
      recoveryEntry.clear();
      recoveryDisplayStep.hidden = true;
      recoveryEntryStep.hidden = false;
      document.querySelector('#vault-recovery-heading').textContent = 'Confirm your recovery key';
      document.querySelector('#vault-recovery-confirm').focus();
    });
    document.querySelector('#vault-recovery-show').addEventListener('click', () => {
      recoveryEntry.clear();
      recoveryEntryStep.hidden = true;
      recoveryDisplayStep.hidden = false;
      document.querySelector('#vault-recovery-heading').textContent =
        'Write down your recovery key';
    });
    document.querySelector('#vault-recovery-add').addEventListener('click', () => {
      recoveryEntry.addCurrent();
    });
    for (const id of ['vault-final-confirm-close', 'vault-final-confirm-back']) {
      document
        .querySelector(`#${id}`)
        .addEventListener('click', () => closeModal(finalConfirmModal));
    }
    finalConfirmModal.querySelector('.modal-backdrop').addEventListener('click', () => {
      closeModal(finalConfirmModal);
    });

    async function runSetup() {
      if (running) return;
      closeModal(finalConfirmModal);
      const chosen = master.value;
      const recoveryKey = generatedRecoveryKey || recoveryEntry.value();
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
        recoveryEntry.clear();
        showRecoveryWords(document, recoveryDisplay, '');
        recoveryDisplayStep.hidden = false;
        recoveryEntryStep.hidden = true;
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
    }
    document.querySelector('#vault-final-confirm-start').addEventListener('click', () => {
      void runSetup();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (running) return;
      error.textContent = '';
      const chosen = master.value;
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
      if (
        !recoveryEntry.ready() ||
        (generatedRecoveryKey && recoveryEntry.value() !== generatedRecoveryKey)
      ) {
        error.textContent = 'Enter all 24 words to confirm you saved the recovery key.';
        return;
      }
      if (resetMode && !resetAck.checked) {
        error.textContent = 'Confirm that you understand the old notes cannot be recovered.';
        return;
      }
      if (resetMode) void runSetup();
      else openModal(finalConfirmModal);
    });
    newMaster.addEventListener('input', () => {
      void assessNewMaster();
    });
    recoveryCurrent.addEventListener('input', () => hideNewRecovery());
    recoveryVerify.addEventListener('click', () => void verifyCurrentForRecovery());
    document.querySelector('#vault-new-recovery-download').addEventListener('click', () => {
      if (generatedNewRecovery) downloadRecoveryKey(document, generatedNewRecovery);
    });
    document.querySelector('#vault-new-recovery-begin').addEventListener('click', () => {
      if (!generatedNewRecovery) return;
      newRecoveryEntry.clear();
      newRecoveryDisplayStep.hidden = true;
      newRecoveryEntryStep.hidden = false;
      recoverySubmit.hidden = false;
      document.querySelector('#vault-new-recovery-heading').textContent =
        'Confirm your new recovery key';
      document.querySelector('#vault-new-recovery-confirm').focus();
    });
    document.querySelector('#vault-new-recovery-show').addEventListener('click', () => {
      newRecoveryEntry.clear();
      newRecoveryEntryStep.hidden = true;
      newRecoveryDisplayStep.hidden = false;
      document.querySelector('#vault-new-recovery-heading').textContent =
        'Write down your new recovery key';
    });
    document.querySelector('#vault-new-recovery-add').addEventListener('click', () => {
      newRecoveryEntry.addCurrent();
    });
    async function saveCredential(event, kind) {
      event.preventDefault();
      if (credentialRunning) return;
      if (kind === 'recovery' && !generatedNewRecovery) {
        await verifyCurrentForRecovery();
        return;
      }
      if (kind === 'master' && !masterMethod) return;
      if (kind === 'master' && !verifiedMasterSecret) {
        await verifyCurrentForMaster();
        return;
      }
      const isMaster = kind === 'master';
      const currentValue = isMaster
        ? verifiedMasterSecret
        : recoveryMethod === 'recovery'
          ? recoveryCurrentEntry.value()
          : recoveryCurrent.value;
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
          !next ||
          next !== document.querySelector('#vault-new-master-confirm').value ||
          next === currentValue ||
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
      } else if (!newRecoveryEntry.ready() || newRecoveryEntry.value() !== next) {
        error.textContent = 'Enter all 24 words to confirm you saved the recovery key.';
        return;
      }
      credentialRunning = true;
      submit.disabled = true;
      try {
        await beforeCredentialChange();
        await vaultSession.changeCredential({
          kind,
          currentSecret: currentValue,
          currentRecovery: selectedCurrentChoice(kind) === 'recovery',
          newSecret: next,
          signOutOthers:
            !isMaster || document.querySelector('#vault-master-signout-others').checked,
        });
        closeCredential(kind);
        const modal = isMaster ? masterModal : recoveryModal;
        closeModal(modal);
        onCredentialChanged();
      } catch (cause) {
        error.textContent = cause.message || 'Could not change the vault credential.';
      } finally {
        credentialRunning = false;
        submit.disabled = false;
        afterCredentialChange();
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

  root.VylkVaultSetup = {bind, formatError: setupErrorMessage, formatRecoveryKey};
})(globalThis);
