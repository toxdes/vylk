# vylk

Lightweight, low-resource single-binary Markdown editor with local-first sync and optional end-to-end encryption.

## Features

- Live markdown preview via marked.js with cursor-position block highlighting
- Formatting toolbar: bold, italic, strike, code, code blocks, headings (h1-h5), links, images, lists, blockquotes, horizontal rules, tables
- Resizable split view, single-panel editor and preview views, and Zen mode with smooth caret-following and reduced-motion support
- Interactive preview with task checkboxes, block editing, and drag-to-reorder controls
- Tags support with filtering
- Mobile-friendly responsive layout with light/dark and custom themes, fonts, and font sizes
- Configurable autosave with manual save
- Optional end-to-end encryption for note titles, tags, bodies, and offline edits, with a 24-word recovery key
- Session-based authentication with remembered browser unlocks and device management
- PWA-ready (manifest, service worker, installable app)
- Offline-first notes: the installed app caches its shell, saves edits in IndexedDB, and synchronizes them after reconnection

## Usage

Native-client implementers: see the [backend API reference](docs/api/README.md),
[OpenAPI specification](docs/api/openapi.json), and
[authentication, sync, and encryption protocol guide](docs/api/client-protocol.md).

```
VYLK_PASSWORD=<password> ./vylk
```

vylk opens the local server in the default browser after the listener is ready.
This is best-effort; a missing desktop browser does not prevent the server from
starting. Use `--no-browser` or `VYLK_NO_BROWSER=1` in CI, containers, and
other headless environments.

Set `VYLK_APP_NAME` to change the server-wide PWA and app-shell branding. The
default is `VYLK`; restart the server after changing it.

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| PORT | 8080 | HTTP listen port |
| VYLK_DIR | ./notes | Directory for plaintext Markdown files or E2EE vault note files |
| VYLK_DB | ./vylk.db | SQLite database path |
| VYLK_APP_NAME | VYLK | Server-wide PWA and app-shell display name |
| VYLK_TRUST_PROXY | (unset) | Set to `1` only when a trusted reverse proxy supplies client-IP headers |
| VYLK_REQUIRE_STRONG_PASSWORDS | false | Set to `true` or `1` to require strong configured passwords and device-side passphrases |
| VYLK_DISABLE_VAULT_CHANGES | false | Set to `true` or `1` on a shared demo to reject vault setup, passphrase/recovery-key changes, vault reset, and device revocation; sign-in, notes, and vault reads still work |
| VYLK_NO_BROWSER | (unset) | Set to `1` to suppress the default browser opening (equivalent to `--no-browser`) |
| ARTIFICIAL_RTT_DELAY_MS | 0 | Development-only delay added once before each request, in milliseconds; `/api/events` is excluded |

The sign-in password also accepts a `_FILE` form: `VYLK_PASSWORD_FILE=/run/secrets/vylk_password`. This is preferred for Docker or Kubernetes secrets.

## End-to-end encryption

E2EE is optional and enabled in **Preferences → Encryption**, not through a server-side encryption key. It requires a browser secure context: HTTPS for remote devices, or HTTP on `localhost`/a loopback address on the server's own machine. Plain HTTP on a LAN IP cannot unlock an encrypted vault. The app blocks encrypted sign-in in that context and directs you to the [E2EE setup guide](https://vylk.toxdes.com/docs/#end-to-end-encryption). Vylk does not provide TLS certificates or HTTPS termination itself.

An existing installation remains in its legacy mode after upgrade. Sign in, open **Preferences → Encryption**, choose a passphrase, and write down the 24-word recovery key before starting conversion. The words are generated from 256 random bits on the device using the public BIP39 English wordlist. The current Vylk password is needed once to authorize conversion. The app makes a private temporary backup, encrypts and checks every note on the device, encrypts existing offline edits, switches the active database to ciphertext, and removes the temporary backup. Conversion can be resumed with the current password, passphrase, and recovery key after an interruption. Note writes are paused while conversion is in progress. Update and unlock each other device to convert its existing local cache; an unopened device may still hold its old plaintext cache until then.

The recovery key is shown as numbered words and can be downloaded as `vylk-recovery-key-YYYYMMDDHHMM.txt`. Store it somewhere safe, separate from the server. Setup hides the words while you confirm them one at a time and asks you to acknowledge the risk of losing access before enabling encryption. Recovery entry also supports removing and rearranging words; bulk pasting is intentionally unavailable.

Once conversion finishes, each device unlocks with the passphrase or recovery key. The passphrase derives a wrapping key with Argon2id; a random vault key encrypts notes with AES-256-GCM. The server stores a wrapped copy of that key and an authentication verifier. It never receives the passphrase or recovery key. The browser encrypts local notes and pending operations before storing them in IndexedDB. Signing in remembers a non-extractable browser key for refreshes, other tabs, and later visits. Sign-out forgets that key but keeps encrypted offline edits for the next unlock. Remembering the device lets same-origin code use that key without another passphrase prompt; sign out on shared devices.

Restart Vylk after conversion to discard any plaintext note content still held in the old server process's memory. Keep `VYLK_PASSWORD` configured if you want the “Forgot both?” option: it is the shared instance password required to authorize starting a new empty vault. It does not recover the old vault and is not an individual user identity. If removed, the option is unavailable until it is configured again and Vylk restarts.

Starting a new vault after losing both secrets creates a new vault ID, key, and epoch. The old encrypted database and ciphertext files are kept in a private server-side archive for 30 days, then deleted. Devices holding the old vault can no longer sync to the new epoch; when they unlock with the new passphrase, their old local offline copies are cleared. This reset cannot recover the old notes; it is an explicit permanent loss of access to them. An attacker who controls the live server or knows the shared `VYLK_PASSWORD` can also authorize the reset.

The server sees note IDs, revisions, timestamps, pin state, sync timing, and preferences. Search and tag filtering must run on an unlocked device. Sync relays encrypted note envelopes; conflict resolution runs on devices. A server that controls the live web app can replace its JavaScript and capture secrets at the next unlock, or on the next visit if the device is remembered. Use a trusted deployment and HTTPS. A malicious server can also withhold updates or replay older valid ciphertext; the vault does not provide rollback detection.

Existing SQLite pre-migration snapshots, external backups, browser caches, filesystem snapshots, and freed storage blocks may still contain plaintext from before conversion. Conversion cannot guarantee physical erasure of old copies. Inspect and retire them under your backup policy. Back up both `VYLK_DB` and `VYLK_DIR`: the database holds key wrappers and metadata, while the directory holds encrypted note bodies. The passphrase or recovery key is also required to decrypt a restored vault. Losing both means the notes cannot be recovered.

Restarting with the same database and notes directory preserves the server's sync identity. Replacing the database creates a different identity. If the browser has unsynced or unresolved edits, sync pauses without uploading or discarding them; restore the previous database and directory, then choose **Retry**. If there are no pending edits, the browser refreshes its local notes from the replacement database. This identity check is not detection of an older backup of the same database.

Encryption preferences can replace the passphrase or recovery key. Replacing a recovery key first requires the current passphrase or recovery key; the new words appear only after verification. This rewraps the same vault key. Passphrase changes offer **Sign out other devices**, enabled by default; replacing the recovery key always revokes the other sessions. The requesting browser signs in again automatically. It does not rotate the vault key. An attacker with an old credential and a copy of the corresponding old wrapped key can still decrypt that copy. Vault-key rotation is not yet available, so replacing a credential alone does not recover a vault whose key material has been copied.

### Devices and session revocation

**Preferences → Account → Devices** lists signed-in browser profiles, not individual tabs. Each entry shows its browser/platform, approximate last server activity (updated at most once every five minutes), and whether it is this device. **Sign out** revokes every session for that profile. Server access is rejected on subsequent authenticated requests; an existing event stream checks validity at its next change or heartbeat. Offline devices lock when they reconnect, not while disconnected. Encrypted pending changes remain in the browser for the next sign-in to the same vault.

Session expiry and revocation are recorded in the database's `session_events` table, without session tokens, encryption keys, or note content. Audit entries and revoked session records are pruned periodically after 90 days. Revocation cannot erase another device's cached notes or prevent use of keys it already possesses.

## Password policy and HTTPS

`VYLK_REQUIRE_STRONG_PASSWORDS=true` (also accepts `1`) checks configured server passwords at startup and tells browsers to reject weak passphrases. With the default `false`, weak passphrases are allowed after the user confirms the warning. The server cannot verify a passphrase's strength because it never receives the passphrase; a compromised live server can replace browser code and bypass this browser-side check.

HTTPS termination is intentionally left to your deployment (for example Certbot or Cloudflare). Set `VYLK_TRUST_PROXY=1` only when a trusted TLS-terminating proxy supplies the forwarding headers.

Server-side file encryption is no longer supported. Deployments that used it must export their notes as plaintext with the previous version before upgrading, then use client-side E2EE if desired. Removed encryption settings and recognized server-encrypted files cause startup to fail without changing those note files. The oldest ciphertext format had no identifying header; do not treat deleting its configuration as decrypting its data.

### Migration backups

Before applying pending database migrations, vylk creates a consistent SQLite snapshot beside `VYLK_DB` using SQLite's backup mechanism. The three newest `*.pre-migration-*.db` snapshots are retained for rollback; ordinary restarts with no pending migration create no snapshot. Ensure the database volume has roughly one extra database-sized block of free space before an upgrade; startup stops safely if the snapshot cannot be made.

## Offline use

After signing in online once, vylk caches its application shell and notes on the device. You can then reopen the installed PWA without a connection, edit or delete notes, and continue working normally. Changes are stored in the browser's IndexedDB and automatically synchronize whenever connectivity returns, while the app is visible.

Open notes use their note ID as the route (`/<note-id>`), so browser navigation and bookmarks return to the same note. The server serves the application shell for valid note routes; access still requires the usual session.

The preview recognizes `[[Wiki Links]]`: clicking a matching note title opens that note, while an unmatched title creates and opens a new note with that title.

Markdown preview treats raw HTML as text rather than rendering it. Links are limited to HTTP, HTTPS, and mailto URLs, and images are limited to HTTP and HTTPS URLs. Remote images load lazily and asynchronously.

While the signed-in app is open, it keeps an authenticated SSE stream to the server. A 25-second heartbeat tracks connectivity, and content-free change hints trigger normal HTTP sync promptly on other open devices. A missing heartbeat for 70 seconds is treated as offline, and reconnection runs a full cache reconciliation before replaying local work. The status badge reports Offline, Saving, or Saved; Saved means the pending changes have reached the server, not merely local storage.

Sync history is bounded for small deployments: the server retains up to 100,000 change records and acknowledgements, and caps stored full operation payloads at 32 MiB. A device older than the retained change feed performs a full server refresh before replaying any local work; old acknowledged retries receive a safe compacted acknowledgement and rebase from the server state.

If the same note changed on another device while you were offline, vylk first performs a three-way merge using the shared base version, your local version, and the server version. Non-overlapping line edits and one-sided title/tag changes are merged and synchronized automatically. For ambiguous overlapping edits, vylk preserves both versions and opens a conflict resolver with the common original, highlighted device versions, and an editable result; you can also explicitly keep your version as a separately titled `conflict copy`. In legacy mode, signing out removes locally cached plaintext notes and queued changes. In encrypted vault mode, sign-out forgets the local unlock key and retains ciphertext so pending edits can be resumed later.

## Build

```
go build -trimpath -ldflags="-s -w -X vylk/internal/server.version=$(cat VERSION)" -o vylk ./cmd/vylk
```

Cross-compile all targets (Linux binaries compressed with UPX):

```
./build.py
```

### Project layout

- `cmd/vylk` contains the executable entry point.
- `internal/server` composes HTTP handlers and application workflows.
- Focused `internal` packages own authentication, notes, sync, preferences, persistence, events, and embedded web assets. E2EE cryptography runs in browser modules; the server stores and relays ciphertext.
- `frontend/styles` contains authored SCSS; `internal/web/static` contains the browser application and generated CSS served by the binary.
- `test` contains frontend behavior and browser tests; package-local tests stay beside their implementation.

### Linux packages

Release builds use [yesb](https://github.com/toxdes/yesb) and produce amd64 and arm64 Debian packages, RPMs, and release archives:

```
./yesb/build_all.py
```

The published package repositories are available at:

- Debian/Ubuntu: `https://packages.toxdes.com/apt`
- RPM-based distributions: `https://packages.toxdes.com/rpm`
- Arch Linux: `vylk-bin` or `vylk-git` from the AUR

## Tests

Install frontend dependencies with `bun ci`, run linting with `bun run lint`, and run the default frontend behavior suite with `bun run test:frontend`. The browser reliability suite uses the installed Chrome binary and a temporary Go server; run it with `bun run test:browser`. It covers offline cached startup, unchanged navigation request counts, a warm dashboard performance budget, keyboard navigation, and serious accessibility violations.

## Continuous integration

GitHub Actions runs Go formatting, module verification, vet, Staticcheck, tests, and builds, plus frontend formatting, generated-CSS verification, linting, unit tests, browser tests, and release-workflow tests for pull requests. There is no manual deployment-approval gate.

Protect `main` by requiring pull requests, requiring the `CI / checks` status check, requiring the check to pass for the latest commit, and disabling force pushes and deletions. Direct pushes should remain disabled so changes arrive through pull requests.

The nightly workflow runs at 02:17 Asia/Kolkata and can also be started manually. It updates one moving `Nightly` pre-release containing Linux amd64 and arm64 tarballs plus `SHA256SUMS`. Set the repository variable `NIGHTLY_ENABLED` to `false` to disable scheduled publication; manual runs remain available. The release assets are deliberately separate from normal Yesb releases.

### Stable releases and deployment hooks

Create a `release/vX.Y.Z` branch from the current `main`, update `VERSION`, and
open a pull request. After the pull request is squash-merged, create and push
`vX.Y.Z` on the resulting `main` commit. The release workflow verifies that the
tag is a strict `vX.Y.Z` tag, that its `VERSION` matches, and that the commit is
reachable from `main` before doing anything else. It also rejects versions
older than the highest stable tag on `main`. To deliberately redeploy an older
version, run the workflow manually from `main`, enter its stable tag, and type
`ROLLBACK <tag>` in the confirmation field.

The workflow creates the GitHub Release without build artifacts. It uses the
latest earlier stable `vX.Y.Z` tag as the previous-tag boundary for GitHub's
generated release notes and prepends:

```markdown
## Installation
Check [install instructions](https://vylk.toxdes.com/docs/#install).
```

Deployment hooks are HTTPS `POST` endpoints configured as GitHub Actions
repository secrets named `VYLK_DEPLOY_HOOK_<DESTINATION>_URL`, for example
`VYLK_DEPLOY_HOOK_LANDER_URL`. Each configured secret must also be mapped to
the same environment variable in `.github/workflows/release.yml`. Hook values
are secret URLs and are validated as HTTPS before any request; they are not
printed in workflow logs. A hook receives release metadata as JSON and
succeeds on any `2xx` response. Failed hooks retry five times at five-minute
intervals, independently of the other hooks, and the workflow fails if any
hook remains unsuccessful. Every delivery includes the same `Idempotency-Key`
header and `idempotency_key` JSON field for a given tag and commit, including
retries and workflow reruns. Hook receivers must deduplicate on this key to
avoid repeating side effects when a request succeeds but its response is lost.

The release workflow does not invoke Yesb. Yesb remains responsible for
building and publishing release artifacts separately.

## Docker

The published image supports Linux amd64 and arm64. Use a versioned tag for
stable deployments:

```
docker run -d --name vylk -p 8080:8080 \
  -e VYLK_PASSWORD=<password> \
  -v vylk-data:/data \
  docker.io/toxdes/vylk:<version>
```

`/data` persists notes and the SQLite database across container replacements.
The published image is a small Distroless Linux runtime image for amd64 and
arm64. It starts VYLK directly and uses `/data/notes` and `/data/vylk.db` by
default. For a quick start, `docker.io/toxdes/vylk:latest` is also published.

To update a versioned deployment, pull the new tag and recreate the container
with the same volume and environment settings:

```
docker pull docker.io/toxdes/vylk:<new-version>
docker rm -f vylk
docker run -d --name vylk -p 8080:8080 \
  -e VYLK_PASSWORD=<password> \
  -v vylk-data:/data \
  docker.io/toxdes/vylk:<new-version>
```

Build the runtime image locally from source with:

```
docker build --target runtime -t "vylk:$(cat VERSION)" -f Dockerfile.runtime .
```

After logging in to Docker Hub, Yesb publishes both tags for the configured
version with:

```
./yesb/release_docker.py --env <release-env-file>
```

Use `./yesb/release_docker.py --dry-run` to inspect the command without
publishing.

## Landing page

The landing page lives in the separate `vylk-lander` repository so it can be
deployed independently from the application. It is a static HTML, CSS, and
JavaScript site with no runtime dependency on the VYLK server.

Cloudflare Pages should use these settings:

- Build command: `./build.sh`
- Build output directory: `dist`
- Production branch: the lander repository's deployment branch

During the Pages build, `build.sh` fetches the public `VERSION` file from
`https://raw.githubusercontent.com/toxdes/vylk/main/VERSION` and writes the
value into `dist/version.js`. The generated lander uses that value for its
release links and Docker examples. Visitors do not query the VYLK repository
or package host for version information.

Set `VYLK_VERSION_URL` to a different public version endpoint when the source
repository moves. Set `VYLK_VERSION` only when producing a reproducible local
build without a network request.

The Pages deploy hook can be called by the release system after a successful
VYLK release if the lander should be rebuilt for every release. Because the
version is read during the build, no version file needs to be published to
R2.
