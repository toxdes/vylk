(function (root) {
  'use strict';

  function create({apiClient, offlineStore}) {
    const cryptography = root.VylkVaultCrypto;
    let config = null;
    let rootKey = null;
    let keys = null;

    function encrypted() {
      return config && ['encrypted', 'cleaning'].includes(config.mode);
    }

    function requiresSecureContext() {
      return config && config.mode !== 'legacy' && root.isSecureContext === false;
    }

    function unlocked() {
      return Boolean(rootKey && keys);
    }

    async function bootstrap() {
      try {
        config = await apiClient.request('/api/vault/bootstrap');
        if (config.mode !== 'legacy') await offlineStore.cacheVaultBootstrap(config);
      } catch (error) {
        if (!['network', 'timeout'].includes(error.kind)) throw error;
        config = await offlineStore.cachedVaultBootstrap();
        if (!config) throw error;
      }
      return config;
    }

    async function setRoot(key, remember = false) {
      const noteKeys = await cryptography.noteKeys(key, config.vault_id);
      await offlineStore.unlockVaultLocal(key, config.vault_id, remember, config.epoch);
      rootKey = key;
      keys = noteKeys;
    }

    async function unlock(passphrase, {remember = false, recovery = false} = {}) {
      if (!encrypted()) throw new Error('vault encryption is not active');
      const credential = recovery
        ? await cryptography.recoveryCredential(passphrase, config.vault_id)
        : await cryptography.credential(passphrase, config.kdf.salt, config.vault_id, config.kdf);
      let login;
      let wrappers;
      try {
        login = await apiClient.request('/api/login', {
          method: 'POST',
          body: JSON.stringify(
            recovery ? {recovery_proof: credential.loginProof} : {proof: credential.loginProof},
          ),
        });
        wrappers = await apiClient.request('/api/vault/keys');
        await offlineStore.cacheVaultWrappers(wrappers);
      } catch (error) {
        if (!['network', 'timeout'].includes(error.kind)) throw error;
        wrappers = await offlineStore.cachedVaultWrappers();
        if (!wrappers) throw error;
        login = {ok: true, offline: true};
      }
      if (wrappers.vault_id !== config.vault_id || wrappers.epoch !== config.epoch)
        throw new Error('vault keys changed during sign-in');
      const key = await cryptography.unwrapVaultKey(
        recovery ? wrappers.wrapped_recovery_key : wrappers.wrapped_key,
        credential.wrappingKey,
        config.vault_id,
      );
      await setRoot(key, remember);
      return login;
    }

    async function unwrapVerifiedCurrentCredential(currentSecret, currentRecovery) {
      if (!encrypted() || !unlocked() || config.mode !== 'encrypted')
        throw new Error('unlock the encrypted vault before changing credentials');
      const vaultID = config.vault_id;
      const currentCredential = currentRecovery
        ? await cryptography.recoveryCredential(currentSecret, vaultID)
        : await cryptography.credential(currentSecret, config.kdf.salt, vaultID, config.kdf);
      const wrappers = await apiClient.request('/api/vault/keys');
      if (wrappers.vault_id !== vaultID || wrappers.epoch !== config.epoch)
        throw new Error('vault keys changed while updating credentials');
      const raw = await cryptography.unwrapRawVaultKey(
        currentRecovery ? wrappers.wrapped_recovery_key : wrappers.wrapped_key,
        currentCredential.wrappingKey,
        vaultID,
      );
      try {
        const label = 'credential-change-check';
        const candidateRoot = await cryptography.importRoot(raw);
        const [candidate, active] = await Promise.all([
          cryptography.deriveBytes(candidateRoot, vaultID, label),
          cryptography.deriveBytes(rootKey, vaultID, label),
        ]);
        if (candidate.some((byte, index) => byte !== active[index]))
          throw new Error('vault key changed while updating credentials');
        return {currentCredential, raw, vaultID};
      } catch (error) {
        raw.fill(0);
        throw error;
      }
    }

    async function verifyCredential(currentSecret, currentRecovery = false) {
      const {raw} = await unwrapVerifiedCurrentCredential(currentSecret, currentRecovery);
      raw.fill(0);
    }

    async function changeCredential({
      kind,
      currentSecret,
      currentRecovery = false,
      newSecret,
      signOutOthers = true,
    }) {
      if (kind !== 'master' && kind !== 'recovery') throw new Error('invalid credential type');
      const {currentCredential, raw, vaultID} = await unwrapVerifiedCurrentCredential(
        currentSecret,
        currentRecovery,
      );
      try {
        const salt = kind === 'master' ? cryptography.toBase64(cryptography.randomBytes(16)) : '';
        const nextCredential =
          kind === 'master'
            ? await cryptography.credential(newSecret, salt, vaultID)
            : await cryptography.recoveryCredential(newSecret, vaultID);
        const wrapped = await cryptography.wrapVaultKey(raw, nextCredential.wrappingKey, vaultID);
        const roundTrip = await cryptography.unwrapRawVaultKey(
          wrapped,
          nextCredential.wrappingKey,
          vaultID,
        );
        try {
          if (roundTrip.some((byte, index) => byte !== raw[index]))
            throw new Error('new vault credential did not verify');
        } finally {
          roundTrip.fill(0);
        }
        const changeRequest = {
          kind,
          current_proof: currentCredential.loginProof,
          current_recovery: currentRecovery,
          new_proof: nextCredential.loginProof,
          wrapped_key: wrapped,
          sign_out_other_devices: signOutOthers,
          ...(kind === 'master'
            ? {
                kdf_salt: salt,
                kdf_memory_kib: cryptography.kdf.memoryKiB,
                kdf_iterations: cryptography.kdf.iterations,
              }
            : {}),
        };
        try {
          await apiClient.request('/api/vault/credentials', {
            method: 'POST',
            body: JSON.stringify(changeRequest),
          });
        } catch (error) {
          if (!['network', 'timeout'].includes(error.kind)) throw error;
          throw new Error(
            'The server may have saved the new credential. Reconnect, then try signing in with it before repeating this change.',
          );
        }
        const loginProof =
          kind === 'master'
            ? nextCredential.loginProof
            : currentRecovery
              ? nextCredential.loginProof
              : currentCredential.loginProof;
        try {
          const login = await apiClient.request('/api/login', {
            method: 'POST',
            body: JSON.stringify(
              kind === 'recovery' && currentRecovery
                ? {recovery_proof: loginProof}
                : {proof: loginProof},
            ),
          });
          await bootstrap();
          await offlineStore.cacheVaultWrappers(await apiClient.request('/api/vault/keys'));
          return login;
        } catch (_) {
          throw new Error(
            'Credential saved, but sign-in did not finish. Reload and use the new credential.',
          );
        }
      } finally {
        raw.fill(0);
      }
    }

    function lock() {
      rootKey = null;
      keys = null;
      offlineStore.lockVaultLocal();
    }

    async function decryptWire(note) {
      if (!unlocked()) throw new Error('vault is locked');
      if (note.epoch !== config.epoch) throw new Error('note uses an unavailable vault key epoch');
      const {summary, body, ...routing} = note;
      const metadata = await cryptography.decryptSummary(note, keys, config.vault_id, note.epoch);
      if (body === undefined) return {...routing, ...metadata};
      const content = await cryptography.decryptBody(note, keys, config.vault_id, note.epoch);
      return {...routing, ...metadata, content};
    }

    async function request(path, options = {}) {
      if (!encrypted() || !path.startsWith('/api/') || path.startsWith('/api/vault/'))
        return apiClient.request(path, options);
      const routed = {...options, headers: {...options.headers, 'X-Vylk-Vault-Protocol': '1'}};
      if (path === '/api/notes' && (options.method || 'GET') === 'POST') {
        if (!unlocked()) throw new Error('vault is locked');
        const note = JSON.parse(options.body);
        const envelopes = await cryptography.encryptNote(note, keys, config.vault_id, config.epoch);
        routed.body = JSON.stringify({
          id: note.id,
          base_revision: note.base_revision,
          epoch: config.epoch,
          ...envelopes,
        });
      }
      const result = await apiClient.request(path, routed);
      if (path.startsWith('/api/sync/notes?')) {
        return {...result, notes: await Promise.all(result.notes.map(decryptWire))};
      }
      if (path === '/api/notes' && Array.isArray(result))
        return Promise.all(result.map(decryptWire));
      if (path.startsWith('/api/notes?') && Array.isArray(result.notes))
        return {...result, notes: await Promise.all(result.notes.map(decryptWire))};
      if (path.startsWith('/api/notes/') && result?.summary) return decryptWire(result);
      return result;
    }

    async function syncFetch(path, options = {}) {
      if (!encrypted() || path !== '/api/sync/push') return apiClient.syncFetch(path, options);
      if (!unlocked()) throw new Error('vault is locked');
      const outgoing = JSON.parse(options.body);
      outgoing.operations = await Promise.all(
        outgoing.operations.map(async (operation) => {
          const {title, tags, content, ...routing} = operation;
          if (operation.type === 'note.save') {
            const envelopes = await cryptography.encryptNote(
              {id: operation.note_id, title, tags, content},
              keys,
              config.vault_id,
              config.epoch,
            );
            return {...routing, ...envelopes, epoch: config.epoch};
          }
          if (operation.type === 'note.delete' || operation.type === 'note.pin')
            return {...routing, epoch: config.epoch};
          return routing;
        }),
      );
      return apiClient.syncFetch(path, {
        ...options,
        headers: {...options.headers, 'X-Vylk-Vault-Protocol': '1'},
        body: JSON.stringify(outgoing),
      });
    }

    async function longRequest(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) {
        const error = new Error(value.error || 'vault migration request failed');
        error.status = response.status;
        error.code = value.code;
        throw error;
      }
      return value;
    }

    async function migrate({
      oldPassword,
      master,
      recoveryKey,
      remember = false,
      onProgress = () => {},
    }) {
      const existing = config?.mode === 'preparing';
      let vaultID;
      let salt;
      let credential;
      let key;
      if (existing) {
        vaultID = config.vault_id;
        salt = config.kdf.salt;
        credential = await cryptography.credential(master, salt, vaultID, config.kdf);
        const wrappers = await apiClient.request('/api/vault/keys');
        key = await cryptography.unwrapVaultKey(
          wrappers.wrapped_key,
          credential.wrappingKey,
          vaultID,
        );
        const recovery = await cryptography.recoveryCredential(recoveryKey, vaultID);
        await cryptography.unwrapVaultKey(
          wrappers.wrapped_recovery_key,
          recovery.wrappingKey,
          vaultID,
        );
        await longRequest('/api/vault/migration/start', {
          old_password: oldPassword,
          vault_id: vaultID,
          kdf_salt: salt,
          kdf_memory_kib: config.kdf.memoryKiB,
          kdf_iterations: config.kdf.iterations,
          auth_proof: credential.loginProof,
          recovery_proof: recovery.loginProof,
          wrapped_key: wrappers.wrapped_key,
          wrapped_recovery_key: wrappers.wrapped_recovery_key,
        });
      } else {
        vaultID = cryptography.toBase64(cryptography.randomBytes(16));
        salt = cryptography.toBase64(cryptography.randomBytes(16));
        credential = await cryptography.credential(master, salt, vaultID);
        const rawKey = cryptography.randomBytes(32);
        key = await cryptography.importRoot(rawKey);
        const recovery = await cryptography.recoveryCredential(recoveryKey, vaultID);
        const [wrappedKey, wrappedRecoveryKey] = await Promise.all([
          cryptography.wrapVaultKey(rawKey, credential.wrappingKey, vaultID),
          cryptography.wrapVaultKey(rawKey, recovery.wrappingKey, vaultID),
        ]);
        rawKey.fill(0);
        onProgress('Making a temporary local copy of the vault…');
        await longRequest('/api/vault/migration/start', {
          old_password: oldPassword,
          vault_id: vaultID,
          kdf_salt: salt,
          kdf_memory_kib: cryptography.kdf.memoryKiB,
          kdf_iterations: cryptography.kdf.iterations,
          auth_proof: credential.loginProof,
          recovery_proof: recovery.loginProof,
          wrapped_key: wrappedKey,
          wrapped_recovery_key: wrappedRecoveryKey,
        });
        await bootstrap();
      }
      const noteKeys = await cryptography.noteKeys(key, vaultID);
      onProgress('Encrypting notes…');
      for (;;) {
        const remaining = await apiClient.request('/api/vault/migration/next');
        if (!remaining.length) break;
        for (const item of remaining) {
          const source = await apiClient.request(`/api/notes/${encodeURIComponent(item.id)}`);
          if (source.revision !== item.revision) throw new Error('note changed during migration');
          const envelopes = await cryptography.encryptNote(source, noteKeys, vaultID, 1);
          await apiClient.request('/api/vault/migration/stage', {
            method: 'POST',
            body: JSON.stringify({id: item.id, revision: item.revision, ...envelopes}),
          });
          const staged = await apiClient.request(
            `/api/vault/migration/staged/${encodeURIComponent(item.id)}`,
          );
          const decrypted = await cryptography.decryptNote(staged, noteKeys, vaultID, 1);
          if (
            decrypted.title !== source.title ||
            decrypted.tags !== source.tags ||
            decrypted.content !== source.content
          )
            throw new Error('encrypted note did not round-trip');
          await apiClient.request('/api/vault/migration/verify', {
            method: 'POST',
            body: JSON.stringify({id: item.id, body_hash: staged.body_hash}),
          });
          onProgress(`Encrypted and verified ${item.id}`);
        }
      }
      onProgress('Encrypting local offline edits…');
      await offlineStore.unlockVaultLocal(key, vaultID, remember, 1);
      onProgress('Removing active plaintext copies…');
      await longRequest('/api/vault/migration/commit', {});
      await bootstrap();
      const login = await apiClient.request('/api/login', {
        method: 'POST',
        body: JSON.stringify({proof: credential.loginProof}),
      });
      await offlineStore.cacheVaultWrappers(await apiClient.request('/api/vault/keys'));
      rootKey = key;
      keys = noteKeys;
      return login;
    }

    async function reset({password, master, recoveryKey, remember = false}) {
      if (!encrypted() || !config.reset_available)
        throw new Error('Starting a new vault is not available on this server.');

      const vaultID = cryptography.toBase64(cryptography.randomBytes(16));
      const salt = cryptography.toBase64(cryptography.randomBytes(16));
      const credential = await cryptography.credential(master, salt, vaultID);
      const recovery = await cryptography.recoveryCredential(recoveryKey, vaultID);
      const rawKey = cryptography.randomBytes(32);
      let requestStarted = false;
      let resetCommitted = false;
      try {
        const [wrappedKey, wrappedRecoveryKey] = await Promise.all([
          cryptography.wrapVaultKey(rawKey, credential.wrappingKey, vaultID),
          cryptography.wrapVaultKey(rawKey, recovery.wrappingKey, vaultID),
        ]);
        requestStarted = true;
        const result = await longRequest('/api/vault/reset', {
          password,
          vault_id: vaultID,
          kdf_salt: salt,
          kdf_memory_kib: cryptography.kdf.memoryKiB,
          kdf_iterations: cryptography.kdf.iterations,
          auth_proof: credential.loginProof,
          recovery_proof: recovery.loginProof,
          wrapped_key: wrappedKey,
          wrapped_recovery_key: wrappedRecoveryKey,
        });
        resetCommitted = true;

        await offlineStore.discardVaultLocalData();
        await bootstrap();
        const wrappers = await apiClient.request('/api/vault/keys');
        if (
          wrappers.vault_id !== vaultID ||
          wrappers.epoch !== result.epoch ||
          config.vault_id !== vaultID ||
          config.epoch !== result.epoch
        ) {
          throw new Error('The new vault could not be verified. Reload and sign in again.');
        }
        await offlineStore.cacheVaultWrappers(wrappers);
        await setRoot(await cryptography.importRoot(rawKey), remember);
        return result;
      } catch (cause) {
        if (resetCommitted) {
          const error = new Error(
            'The new vault was created, but this device could not finish setup.',
          );
          error.vaultResetState = 'created';
          throw error;
        }
        if (requestStarted && !cause.status) {
          const error = new Error('Vylk could not confirm whether the new vault was created.');
          error.vaultResetState = 'unknown';
          throw error;
        }
        throw cause;
      } finally {
        rawKey.fill(0);
      }
    }

    return {
      bootstrap,
      changeCredential,
      config: () => config,
      encrypted,
      lock,
      migrate,
      request,
      requiresSecureContext,
      reset,
      syncFetch,
      unlock,
      unlocked,
      verifyCredential,
    };
  }

  root.VylkVaultSession = {create};
})(globalThis);
