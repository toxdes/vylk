(function (root) {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const kdf = Object.freeze({algorithm: 'argon2id13', memoryKiB: 19 * 1024, iterations: 2});
  const format = 1;
  let bip39Promise;

  function loadBIP39() {
    if (root.VylkBIP39) return Promise.resolve(root.VylkBIP39);
    if (!bip39Promise) {
      bip39Promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/bip39.min.js';
        script.onload = () =>
          root.VylkBIP39
            ? resolve(root.VylkBIP39)
            : reject(new Error('Recovery key tools could not be loaded. Try again.'));
        script.onerror = () =>
          reject(new Error('Recovery key tools could not be loaded. Try again.'));
        document.head.append(script);
      }).catch((error) => {
        bip39Promise = undefined;
        throw error;
      });
    }
    return bip39Promise;
  }

  async function createRecoveryKey(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
      throw new Error('invalid recovery key entropy');
    const bip39 = await loadBIP39();
    return bip39.entropyToMnemonic(bytes, bip39.wordlist);
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  function toBase64(bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32766) {
      chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 32766))));
    }
    return chunks.join('').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function fromBase64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value))
      throw new Error('invalid base64url value');
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
  }

  async function deriveMaster(passphrase, salt, params = kdf) {
    if (
      params.algorithm !== 'argon2id13' ||
      params.memoryKiB < kdf.memoryKiB ||
      params.memoryKiB > 256 * 1024 ||
      params.iterations < kdf.iterations ||
      params.iterations > 10 ||
      fromBase64(salt).length !== 16
    ) {
      throw new Error('unsupported or weak vault KDF parameters');
    }
    const worker = new Worker('/js/core/vault-kdf-worker.js', {type: 'module'});
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({data}) =>
          data.error ? reject(new Error(data.error)) : resolve(new Uint8Array(data.key));
        worker.onerror = (event) =>
          reject(new Error(event.message || 'key derivation worker failed'));
        worker.postMessage({
          id: 1,
          passphrase,
          salt: fromBase64(salt),
          memoryKiB: params.memoryKiB,
          iterations: params.iterations,
        });
      });
    } finally {
      worker.terminate();
    }
  }

  async function importRoot(bytes) {
    if (bytes.length !== 32) throw new Error('invalid vault key length');
    return root.crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
  }

  async function deriveBytes(rootKey, vaultID, label) {
    return new Uint8Array(
      await root.crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: fromBase64(vaultID),
          info: encoder.encode(`vylk/v1/${label}`),
        },
        rootKey,
        256,
      ),
    );
  }

  async function aesKey(rootKey, vaultID, label) {
    return root.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: fromBase64(vaultID),
        info: encoder.encode(`vylk/v1/${label}`),
      },
      rootKey,
      {name: 'AES-GCM', length: 256},
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encrypt(key, plain, context) {
    const nonce = randomBytes(12);
    const ciphertext = await root.crypto.subtle.encrypt(
      {name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(JSON.stringify(context))},
      key,
      plain,
    );
    return {v: format, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext))};
  }

  async function decrypt(key, envelope, context) {
    if (envelope?.v !== format || fromBase64(envelope.nonce).length !== 12)
      throw new Error('unsupported or corrupt encrypted note');
    try {
      return new Uint8Array(
        await root.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64(envelope.nonce),
            additionalData: encoder.encode(JSON.stringify(context)),
          },
          key,
          fromBase64(envelope.ciphertext),
        ),
      );
    } catch (cause) {
      throw new Error('encrypted data failed authentication', {cause});
    }
  }

  function noteContext(vaultID, noteID, field, epoch) {
    return ['vylk', format, vaultID, noteID, field, epoch];
  }

  async function noteKeys(rootKey, vaultID) {
    const [summary, body, local] = await Promise.all(
      ['summary', 'body', 'local'].map((label) => aesKey(rootKey, vaultID, label)),
    );
    return {summary, body, local};
  }

  async function encryptNote(note, keys, vaultID, epoch) {
    const [summary, body] = await Promise.all([
      encrypt(
        keys.summary,
        encoder.encode(JSON.stringify({title: note.title, tags: note.tags})),
        noteContext(vaultID, note.id, 'summary', epoch),
      ),
      encrypt(
        keys.body,
        encoder.encode(note.content),
        noteContext(vaultID, note.id, 'body', epoch),
      ),
    ]);
    return {summary, body};
  }

  async function decryptNote(note, keys, vaultID, epoch) {
    const [summary, content] = await Promise.all([
      decryptSummary(note, keys, vaultID, epoch),
      decryptBody(note, keys, vaultID, epoch),
    ]);
    return {...note, ...summary, content};
  }

  async function decryptSummary(note, keys, vaultID, epoch) {
    const summaryBytes = await decrypt(
      keys.summary,
      note.summary,
      noteContext(vaultID, note.id, 'summary', epoch),
    );
    const summary = JSON.parse(decoder.decode(summaryBytes));
    if (typeof summary.title !== 'string' || typeof summary.tags !== 'string')
      throw new Error('invalid encrypted note summary');
    return summary;
  }

  async function decryptBody(note, keys, vaultID, epoch) {
    const bodyBytes = await decrypt(
      keys.body,
      note.body,
      noteContext(vaultID, note.id, 'body', epoch),
    );
    return decoder.decode(bodyBytes);
  }

  async function credential(passphrase, salt, vaultID, params = kdf) {
    const derived = await deriveMaster(passphrase, salt, params);
    try {
      const rootKey = await importRoot(derived);
      const [loginProof, wrappingKey] = await Promise.all([
        deriveBytes(rootKey, vaultID, 'login'),
        aesKey(rootKey, vaultID, 'wrap'),
      ]);
      return {loginProof: toBase64(loginProof), wrappingKey};
    } finally {
      derived.fill(0);
    }
  }

  async function recoveryCredential(code, vaultID) {
    let bytes;
    if (/^[A-Za-z0-9_-]{43}$/.test(code)) {
      // Accept recovery keys created by earlier pre-release builds.
      bytes = fromBase64(code);
    } else {
      try {
        const bip39 = await loadBIP39();
        bytes = bip39.mnemonicToEntropy(
          code.trim().toLowerCase().replace(/\s+/g, ' '),
          bip39.wordlist,
        );
      } catch (_) {
        throw new Error('Enter the 24 words from your recovery key.');
      }
    }
    if (bytes.length !== 32) throw new Error('Enter the 24 words from your recovery key.');
    const rootKey = await importRoot(bytes);
    return {
      loginProof: toBase64(await deriveBytes(rootKey, vaultID, 'recovery-login')),
      wrappingKey: await aesKey(rootKey, vaultID, 'recovery-wrap'),
    };
  }

  async function wrapVaultKey(rawVaultKey, wrappingKey, vaultID) {
    return encrypt(wrappingKey, rawVaultKey, ['vylk', format, vaultID, 'vault-key']);
  }

  async function unwrapRawVaultKey(envelope, wrappingKey, vaultID) {
    const raw = await decrypt(wrappingKey, envelope, ['vylk', format, vaultID, 'vault-key']);
    if (raw.length !== 32) throw new Error('invalid wrapped vault key');
    return raw;
  }

  async function unwrapVaultKey(envelope, wrappingKey, vaultID) {
    const raw = await unwrapRawVaultKey(envelope, wrappingKey, vaultID);
    try {
      return importRoot(raw);
    } finally {
      raw.fill(0);
    }
  }

  root.VylkVaultCrypto = Object.freeze({
    credential,
    decrypt,
    decryptNote,
    decryptBody,
    decryptSummary,
    deriveBytes,
    encrypt,
    encryptNote,
    fromBase64,
    importRoot,
    kdf,
    noteContext,
    noteKeys,
    randomBytes,
    recoveryCredential,
    createRecoveryKey,
    toBase64,
    unwrapRawVaultKey,
    unwrapVaultKey,
    wrapVaultKey,
  });
})(globalThis);
