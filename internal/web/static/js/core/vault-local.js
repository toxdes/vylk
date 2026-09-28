(function (root) {
  'use strict';

  let sodiumPromise;
  function loadSodium() {
    if (root.VylkSodium) return root.VylkSodium.ready.then(() => root.VylkSodium);
    if (!sodiumPromise) {
      sodiumPromise = import('/vendor/libsodium-sumo.min.js').then(async () => {
        if (!root.VylkSodium) throw new Error('could not load local encryption');
        await root.VylkSodium.ready;
        return root.VylkSodium;
      });
    }
    return sodiumPromise;
  }

  function create({sodium, key, vaultID, allowPlaintext = false}) {
    const vaultCrypto = root.VylkVaultCrypto;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let active = true;

    function identity(store, record) {
      if (store === 'notes') return [record.id];
      if (store === 'queue') return [record.note_id, record.client_sequence];
      return [record.key];
    }

    function context(store, record) {
      return encoder.encode(
        JSON.stringify(['vylk-local', 1, vaultID, store, ...identity(store, record)]),
      );
    }

    function encryptRecord(store, record) {
      if (!active) throw new Error('local vault is locked');
      if (store === 'state' && record.key === 'vault-local-format') return record;
      const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        encoder.encode(JSON.stringify(record)),
        context(store, record),
        null,
        nonce,
        key,
      );
      const routing =
        store === 'notes'
          ? {id: record.id}
          : store === 'queue'
            ? {
                ...(record.id === undefined ? {} : {id: record.id}),
                note_id: record.note_id,
                client_sequence: record.client_sequence,
              }
            : {key: record.key};
      return {
        ...routing,
        vault_ciphertext: {
          v: 1,
          nonce: vaultCrypto.toBase64(nonce),
          data: vaultCrypto.toBase64(cipher),
        },
      };
    }

    function decryptRecord(store, record) {
      if (!record) return record;
      if (!active) throw new Error('local vault is locked');
      if (!record.vault_ciphertext) {
        if (allowPlaintext || (store === 'state' && record.key === 'vault-local-format'))
          return record;
        throw new Error('unencrypted local vault data was found');
      }
      const {v, nonce, data} = record.vault_ciphertext;
      if (v !== 1) throw new Error('unsupported local vault format');
      let plain;
      try {
        plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          vaultCrypto.fromBase64(data),
          context(store, record),
          vaultCrypto.fromBase64(nonce),
          key,
        );
      } catch (cause) {
        throw new Error('local vault data failed authentication', {cause});
      }
      const decoded = JSON.parse(decoder.decode(plain));
      if (JSON.stringify(identity(store, decoded)) !== JSON.stringify(identity(store, record)))
        throw new Error('local vault routing data is corrupt');
      return store === 'queue' ? {...decoded, id: record.id} : decoded;
    }

    function setAllowPlaintext(value) {
      allowPlaintext = Boolean(value);
    }

    function close() {
      active = false;
      sodium.memzero(key);
    }

    return {close, decryptRecord, encryptRecord, setAllowPlaintext};
  }

  async function fromRoot(rootKey, vaultID, {allowPlaintext = false} = {}) {
    const sodium = await loadSodium();
    const key = await root.VylkVaultCrypto.deriveBytes(rootKey, vaultID, 'local-xchacha20');
    return create({sodium, key, vaultID, allowPlaintext});
  }

  root.VylkVaultLocal = {create, fromRoot, loadSodium};
})(globalThis);
