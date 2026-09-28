import {describe, expect, test} from 'vitest';
import {entropyToMnemonic, mnemonicToEntropy} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';

globalThis.VylkBIP39 = {entropyToMnemonic, mnemonicToEntropy, wordlist};
await import('../internal/web/static/js/core/vault-crypto.js');

const vault = globalThis.VylkVaultCrypto;

describe('vault note encryption', () => {
  test('authenticates the note ID, field, epoch and ciphertext', async () => {
    const vaultID = vault.toBase64(vault.randomBytes(16));
    const key = await vault.importRoot(vault.randomBytes(32));
    const keys = await vault.noteKeys(key, vaultID);
    const note = {id: 'note-a', title: 'Private title', tags: 'private', content: '# Private body'};
    const envelopes = await vault.encryptNote(note, keys, vaultID, 1);
    const wire = {...note, ...envelopes};
    expect(await vault.decryptNote(wire, keys, vaultID, 1)).toMatchObject(note);
    await expect(vault.decryptNote({...wire, id: 'note-b'}, keys, vaultID, 1)).rejects.toThrow(
      'authentication',
    );
    await expect(vault.decryptNote(wire, keys, vaultID, 2)).rejects.toThrow('authentication');
    await expect(
      vault.decrypt(keys.body, envelopes.summary, vault.noteContext(vaultID, note.id, 'body', 1)),
    ).rejects.toThrow('authentication');
    const ciphertext = vault.fromBase64(envelopes.body.ciphertext);
    ciphertext[0] ^= 1;
    await expect(
      vault.decryptBody(
        {...wire, body: {...envelopes.body, ciphertext: vault.toBase64(ciphertext)}},
        keys,
        vaultID,
        1,
      ),
    ).rejects.toThrow('authentication');
  });

  test('wraps the random vault key with an independent recovery secret', async () => {
    const vaultID = vault.toBase64(vault.randomBytes(16));
    const raw = vault.randomBytes(32);
    const recovery = vault.toBase64(vault.randomBytes(32));
    const credential = await vault.recoveryCredential(recovery, vaultID);
    const envelope = await vault.wrapVaultKey(raw, credential.wrappingKey, vaultID);
    const restored = await vault.unwrapVaultKey(envelope, credential.wrappingKey, vaultID);
    expect(await vault.deriveBytes(restored, vaultID, 'check')).toEqual(
      await vault.deriveBytes(await vault.importRoot(raw), vaultID, 'check'),
    );
    const wrong = await vault.recoveryCredential(vault.toBase64(vault.randomBytes(32)), vaultID);
    await expect(vault.unwrapVaultKey(envelope, wrong.wrappingKey, vaultID)).rejects.toThrow(
      'authentication',
    );
  });

  test('encodes 256 random bits as a standard 24-word recovery key', async () => {
    const entropy = Uint8Array.from({length: 32}, (_, index) => index);
    const recoveryKey = await vault.createRecoveryKey(entropy);
    expect(recoveryKey.split(' ')).toHaveLength(24);
    expect(mnemonicToEntropy(recoveryKey, wordlist)).toEqual(entropy);
    const legacy = vault.toBase64(entropy);
    expect(await vault.recoveryCredential(recoveryKey, 'vault-id')).toHaveProperty('wrappingKey');
    expect(await vault.recoveryCredential(legacy, 'vault-id')).toHaveProperty('wrappingKey');
  });
});
