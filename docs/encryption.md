# End-to-end encryption

End-to-end encryption (E2EE) is optional and off by default. When it is on, the browser encrypts note titles, tags, note text, and pending offline edits before it sends or stores them. The vylk server stores only ciphertext and wrapped keys. It cannot read your notes, except in the cases that [Security limits](#security-limits) describes.

To turn encryption on, follow [Turn on encryption](how-to.md#turn-on-encryption).

## What is encrypted

| Data                                          | Encrypted |
| --------------------------------------------- | --------- |
| Note titles and tags                          | Yes       |
| Note text                                     | Yes       |
| Notes and pending edits stored in the browser | Yes       |
| Note IDs, revisions, and timestamps           | No        |
| Pin state                                     | No        |
| Preferences                                   | No        |
| Note sizes, sync timing, and traffic patterns | No        |
| Signed-in devices and session records         | No        |

The server cannot search encrypted notes or filter them by tag. Unlocked devices decrypt notes and do this work locally. They also resolve conflicting edits locally.

## Keys and credentials

The vault key is a random 256-bit key that the browser generates during setup. It encrypts every note with AES-256-GCM. The server stores two encrypted copies of the vault key, each called a wrapper:

- The password wrapper is encrypted with a key that the browser derives from your encryption password with Argon2id.
- The recovery wrapper is encrypted with a key that the browser derives from your recovery key.

The recovery key is 24 words generated from 32 random bytes. Either credential unlocks the vault. To sign in, the browser derives a proof from the credential and sends the proof, not the credential. The server stores a hash of each proof.

The encryption password starts as your current vylk password, which is the value of `VYLK_PASSWORD`. The server process knows this value. Until you change your password in **Preferences**, an operator who can read the server configuration can derive the vault key. To remove that ability, [change your password](how-to.md#change-your-password) after setup.

Changing the password or the recovery key replaces the matching wrapper. The vault key stays the same. A wrapper or vault key that someone copied earlier still works after the change.

The [client protocol](api/client-protocol.md#encryption-wire-format) specifies the key derivation parameters, HKDF labels, envelope format, and authenticated data.

## Secure context requirement

Browsers expose the Web Crypto API only in a secure context. vylk can set up, unlock, or use an encrypted vault only on these addresses:

- An `https://` address with a certificate that the device trusts.
- `http://localhost` or another loopback address, on the computer that runs vylk.

A plain `http://` address on a local network, such as `http://192.168.1.10:8080`, is not a secure context. On such an address, the sign-in page of an encrypted instance shows that encryption requires HTTPS, and signed-in pages return to sign-in. A trusted network does not change this rule. vylk does not serve HTTPS itself. Use a reverse proxy, as described in [Set up HTTPS](how-to.md#set-up-https).

## Converting existing notes

Setup converts your existing notes in place. The browser that runs setup does this work:

1. The server verifies the current vylk password.
2. The browser generates the vault key and the recovery key. You confirm all 24 recovery words.
3. The browser encrypts each note, uploads it, downloads the result, and verifies it against the original.
4. After every note is verified, the server switches to encrypted storage. It deletes the plaintext files, the plaintext indexes, and the stored sync operations, which contain note text. It also signs out every device.

During conversion, the server rejects note changes. If setup stops, open **Preferences**, select **Encryption**, and resume it with the same password and recovery key. There is no way to cancel a conversion that has started.

Other devices keep plaintext copies of notes in browser storage until you unlock vylk on them. Each device converts its own copy when you unlock it.

## Devices and remembered keys

After you sign in on a device, the browser keeps a non-extractable key that unlocks the vault on that device. Tabs, refreshes, and later visits use this key, so you do not enter your password each time. Anyone who uses that browser profile can read the notes cached on it.

Signing out of a device deletes its remembered key. Encrypted pending edits stay on the device, and they sync after the next unlock.

Signing out another device revokes its sessions on the server. An offline device learns this when it reconnects. Revocation cannot delete the notes or keys that the device already holds.

## Losing access

If you lose both the encryption password and the recovery key, nobody can decrypt your notes. This includes the server operator, and it includes copies in backups.

The server can create a new, empty vault through `POST /api/vault/reset`. This requires `VYLK_PASSWORD` to be set. The app has no button for this operation. A reset does not decrypt the old notes. The server keeps the old ciphertext in `.vylk-vault-archives` inside the notes folder for 30 days and then deletes it. Opening that archive still requires the old credentials.

## Security limits

Encryption protects your notes from a server that stores them but does not change the app. It does not protect against these threats:

- A server that runs modified code can send the browser a modified app. That app can capture your password or recovery key when you unlock, or use a remembered key on your next visit.
- An operator who knows `VYLK_PASSWORD` can derive the vault key until you change your password.
- The server can replace a note with an older valid ciphertext of the same note. vylk does not detect this rollback.

Copies made before setup stay plaintext. These copies include:

- Old backups and filesystem snapshots.
- The pre-migration database copies that vylk keeps next to the database.
- Browser data on devices that you have not unlocked since setup.
- Disk blocks that the operating system has freed.

After setup, restart vylk. A restart clears plaintext note content that the old server process still holds in memory. Then review where your old backups are stored.

## Server-side encryption from earlier versions

Earlier versions of vylk could encrypt note files on the server. That feature has been removed. If any of the settings `VYLK_ENCRYPTION_PASSWORD`, `VYLK_ENCRYPTION_KEY`, `VYLK_ENCRYPTION_PASSWORD_FILE`, `VYLK_ENCRYPTION_KEY_FILE`, or `VYLK_MIGRATE_ENCRYPTION` is set, vylk refuses to start. It also refuses to start if it recognizes files in the notes folder that this feature encrypted. Removing the settings does not decrypt those files. Before you upgrade, export those notes as plaintext with the earlier version. Then you can turn on end-to-end encryption in the new version.
