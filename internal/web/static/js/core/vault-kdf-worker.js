import '/vendor/libsodium-sumo.min.js';

(function (root) {
  'use strict';

  root.onmessage = async ({data}) => {
    try {
      await root.VylkSodium.ready;
      const {id, passphrase, salt, memoryKiB, iterations} = data;
      if (typeof passphrase !== 'string' || passphrase.length > 1024)
        throw new Error('invalid passphrase');
      const key = root.VylkSodium.crypto_pwhash(
        32,
        passphrase,
        new Uint8Array(salt),
        iterations,
        memoryKiB * 1024,
        root.VylkSodium.crypto_pwhash_ALG_ARGON2ID13,
      );
      root.postMessage({id, key}, [key.buffer]);
    } catch (error) {
      root.postMessage({id: data.id, error: error?.message || 'key derivation failed'});
    }
  };
})(self);
