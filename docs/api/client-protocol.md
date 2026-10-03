# Implementing a VYLK client

The [OpenAPI specification](openapi.json) describes every backend API route.
This guide explains the stateful protocols that individual route schemas cannot
express. Serve requests from your instance's base URL, not the documentation site.
The API is currently unversioned; pin your client to a tested VYLK release and
ignore additional response fields. Do not send unknown request fields.

## Transport and authentication

Use HTTPS for remote access. Plain HTTP exposes passwords, proofs, cookies, and
plaintext notes. Browsers need a secure context for E2EE: HTTPS remotely or HTTP
on localhost/loopback. Native cryptographic libraries do not have that browser
restriction, but HTTP still exposes reusable authentication secrets.

Read `GET /api/vault/bootstrap` without HTTP caching and compare its `instance_id`
before accessing cached notes or remembered keys. Keep the cache identity readable
even when its note data is encrypted. A different identity requires an explicit
choice: retain local data while restoring the previous database and notes directory,
or discard it and switch. A network failure is not a changed identity. Coordinate
the choice across tabs and fence stale writes during an atomic local reset. Keep
the switching page's callbacks bound to the old identity until it reloads; clearing
the cache must not authorize old editor saves against the replacement database.
Retain the application/service-worker cache; it contains no account or note data.

Then log in using the configured password for
`legacy`/`preparing`, or a derived proof for `encrypted`/`cleaning`. Retain the
`session` and `vylk-device` cookies. There is no Bearer token, API key, CORS API,
or per-user account identifier. This is one person's instance, not a shared
multi-user notes service. A native client's cookie jar represents its device.
The sync queue's `device_id` is a separate identifier, not an authentication token.

JSON responses use `application/json; charset=utf-8`. Send JSON request bodies
with `Content-Type: application/json`. Errors normally contain `error` and
`code`; inspect the code rather than English text. Router-generated 404/405
and SSE setup failures can be plain text. Session renewal can add `Set-Cookie`
to authenticated responses, not just login. Preserve each cookie header.

VYLK also sends `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, and its app-oriented `Content-Security-Policy`
on all responses. Its own gzip middleware excludes `/api/` routes; a reverse
proxy can still compress them or add headers. Do not require transport headers
to match a hardcoded set. SSE additionally sends `Cache-Control: no-cache` and
`X-Accel-Buffering: no`. Bootstrap sends `Cache-Control: no-store`; other JSON API
responses do not set an application cache TTL.

On 401, stop background sync and request sign-in without deleting pending edits.
Respect `Retry-After` on 429 and use bounded backoff for transient network/5xx
failures. A timeout does not prove that a write failed. Never log credentials,
proofs, session cookies, recovery words, keys, or decrypted note payloads.

## Notes, revisions, and preferences

Saves carry complete Markdown and metadata, not textual deltas. Updating a note
requires its known `base_revision`; new client-generated IDs use 0. Direct saves
return metadata without the body. Tags are a comma-separated string, not an
array. Revisions and sequences are signed 64-bit integers; languages with
limited numeric precision must handle them without silently rounding.

Direct `PATCH /api/prefs` is full replacement despite the HTTP method. Read the
complete object, merge desired changes locally, and use its revision in
`If-Match`. Missing fields can reset settings. For queued field-level changes,
use `prefs.save` with `_sync_patch` (desired fields), `_sync_base` (previous field
values), and `base_revision`. A stale patch conflicts when another device changed
one of those fields to a value different from both the base and desired value.
Preferences are not encrypted and are not in the note change feed; refresh them
on preference hints and reconnect.

## Durable synchronization

Persist server `instance_id`, vault identity/epoch, pull cursor, queue identifier,
next client sequence, pending full-note operations, and acknowledgements together
with the local cache. Coordinate a single queue owner when multiple app windows
share that store; an active/focused window is not a reliable ownership lock.

For initial state, obtain a feed baseline before listing all note-summary pages,
fetch complete notes in batches of up to 25, then replay changes after that
baseline. There is no atomic multi-request snapshot. A fetched note can already
contain a newer revision than its feed entry. Use revisions, deduplicate IDs,
apply deletion tombstones, and never replace an unresolved local edit with a
remote snapshot silently. Commit cache changes before advancing the cursor.

Pull with `since` exclusive and follow `hasMore`. Stop the loop when `hasMore`
is false; a nonzero cursor is not a reason to fetch forever. SSE is only a hint:
events can be coalesced or lost and have no replay IDs. Pull after reconnect
even if no change event arrived. When `resetRequired` is true, the retained
feed cannot cover your cursor. Use the returned newest cursor as a baseline,
rebuild the remote snapshot, and replay changes after it; retain pending edits
separately throughout this process.

Push at most 100 ordered operations. `client_sequence` starts at 1 and advances
contiguously per queue `device_id`. `op_id` identifies an operation across
retries. Persist both before sending; retries must keep the same payload and
identifiers. An empty push returns `expected_sequence`. A previously used ID
is not a fresh queue: inspect the server counter before scheduling operations.

Inspect every acknowledgement, even on HTTP 200. `conflict` consumes its sequence
and needs explicit client-side reconciliation followed by a new operation.
`compacted` acknowledges a consumed sequence whose detailed result was pruned;
it does not prove the desired note content is still on the server. A sequence
gap returns 409 and can still acknowledge an applied prefix. Timeouts and 5xx
can follow partial commits too. Retain and retry identical unresolved operations;
the batch is not an all-or-nothing transaction. Use `noop` for a deliberately
canceled queue slot, not to conceal an unresolved conflict.

Include `X-Vylk-Instance-ID` on every push and compare identity on every check
and pull. With a replacement database, pause before uploading or clearing
anything. If there are pending edits, offer to retain them while restoring the
original database and notes directory, or explicitly discard them. Never silently
renumber and replay them into a different server. A cursor beyond the new feed's
head does not necessarily produce `resetRequired`; identity is essential.
Matching identity does not detect restoration of an older snapshot of the same
database; the protocol does not guarantee server rollback detection.

## Encryption wire format

All binary values use strict, unpadded base64url. The vault ID and Argon2 salt
decode to 16 bytes; login and recovery proofs decode to 32 bytes. JSON envelopes
are objects: `{"v":1,"nonce":"...","ciphertext":"..."}`. AES-256-GCM uses
a fresh random 12-byte nonce for every encryption, a 128-bit authentication tag,
and ciphertext with that 16-byte tag appended. Never reuse a nonce under a key.

Derive a 32-byte root from the exact UTF-8 passphrase using libsodium-compatible
`crypto_pwhash`, algorithm `ARGON2ID13`. Use bootstrap `iterations` as opslimit
and `memoryKiB * 1024` as memlimit; do not normalize passphrase Unicode or
substitute a generic library's default Argon2 parameters. New setup uses 19,456
KiB and 2 iterations; the server accepts 19,456–262,144 KiB and 2–10 iterations.
For compatibility with the browser client, limit passphrases to 1,024 UTF-16
code units; its KDF worker rejects longer strings.

Derive subkeys with HKDF-SHA-256: input key material is the root, salt is the
decoded 16-byte vault ID, info is the UTF-8 label below, output is 32 bytes.
From the passphrase root, labels are `vylk/v1/login` (proof) and `vylk/v1/wrap`
(AES wrapping key). Send the original proof bytes encoded in base64url, not
their SHA-256 hash; the server stores that hash itself.

Recovery uses 32 random entropy bytes encoded as a 24-word BIP39 English
mnemonic. Decode words back to the entropy, NOT the BIP39 PBKDF-derived seed.
Use that entropy as the HKDF root with labels `vylk/v1/recovery-login` and
`vylk/v1/recovery-wrap`. Earlier clients also accepted the 43-character base64url
entropy representation; new clients should present the numbered mnemonic.

Generate a separate random 32-byte vault key. Both wrappers encrypt that same
key. Their AES additional authenticated data (AAD) is compact UTF-8 JSON:
`["vylk",1,"<vault-id>","vault-key"]`. Use the original base64url ID string.
The recovery wrapper uses the recovery wrapping key, not the passphrase key.

Derive note AES keys from the vault-key root using HKDF labels `vylk/v1/summary`
and `vylk/v1/body`. Summary plaintext is UTF-8 JSON with string `title` and
comma-separated string `tags`; body plaintext is UTF-8 Markdown. AAD is compact
JSON `["vylk",1,"<vault-id>","<note-id>","summary",<epoch>]` or the same
array with `"body"`. There must be no whitespace in the encoded AAD,
and epoch is a JSON integer, not a string.
The browser additionally uses `vylk/v1/local` for its encrypted offline cache;
native clients can use a separately designed protected local storage format.

Send `X-Vylk-Vault-Protocol: 1` on note/search/tag/sync routes in encrypted mode.
Auth, keys, preferences, migration, and SSE do not require that header.
Encrypted saves contain `summary`, `body`, and `epoch`, never plaintext fields.
Search and tag filtering happen locally after decryption. On stale epoch, stop
and refresh bootstrap/keys; never relabel old ciphertext with a new epoch.

## Enabling encryption and resuming migration

Drain or explicitly reconcile pending plaintext edits first. Start migration
with the server password, generated vault ID, KDF parameters, both proofs, and
both wrappers. Preserve those generated secrets across retries. `preparing`
keeps plaintext readable but blocks note writes. A repeated start with the same
ID resumes existing setup rather than changing its stored credentials.

Read migration `next` pages, fetch each source note, encrypt at its source
revision, and `stage` it. Download `staged/{id}`, decrypt summary/body, and
compare against the original before `verify`. Use the returned `body_hash`:
it hashes exact stored envelope JSON bytes, not reserialized JSON or plaintext.
Restaging clears verification. Commit only after all notes are verified.

Commit revokes sessions and removes plaintext storage/indexes/old sync payloads.
Log in with the new proof. Queue counters survive this migration; do not reset
an existing queue's sequence to 1. A `vault_cleanup_pending` 500 means cutover
already committed and server restart resumes cleanup. Do not restart setup or
resume plaintext writes in that state. There is no migration abort endpoint.

## Credentials, reset, and security limits

Changing passphrase or recovery key rewraps the existing vault key. It does not
rotate that key or prevent an already-unlocked offline device from reading its
cache. `sign_out_other_devices` defaults to true; current session is always
revoked. The next login must derive against fresh bootstrap settings.

The reset API creates a NEW EMPTY vault using `VYLK_PASSWORD`, when configured.
It cannot decrypt the old notes. Old ciphertext and database are quarantined
for 30 days, but still require the old key. Confirm irreversible access-loss
consequences; do not automatically retry an ambiguous reset. Vault ID changes,
epoch increments, server instance ID stays the same, and queue counters reset.

`VYLK_DISABLE_VAULT_CHANGES=true` rejects setup, credential changes, migration
mutations, reset, and device revocation at the API. It does not disable normal
notes, existing vault reads/writes, preferences, or the client's own logout.

E2EE hides titles, tags, bodies, and properly encrypted local pending edits, not
IDs, timestamps, pins, preferences, sizes, or traffic patterns. It does not
prevent a compromised server from distributing a modified browser app that
steals keys. The protocol does not provide general ciphertext rollback
detection. Back up the database and notes directory together.
