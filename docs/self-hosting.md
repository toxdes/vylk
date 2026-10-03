# Self-hosting

[Installation](https://vylk.toxdes.com/docs/#install) · [User documentation](https://vylk.toxdes.com/docs/) · [Backend API](api/README.md)

## Configuration

Start with `VYLK_PASSWORD='your-password' vylk`. Vylk listens on port 8080 and
opens your default browser if available. Use `--no-browser` on headless servers.

| Variable                        | Default                    | Purpose                                                                                                                    |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                          | `8080`                     | HTTP listen port                                                                                                           |
| `VYLK_DIR`                      | `./notes`                  | Note files                                                                                                                 |
| `VYLK_DB`                       | `./vylk.db`                | SQLite database                                                                                                            |
| `VYLK_PASSWORD`                 | Required before encryption | Initial sign-in password; also authorizes a destructive vault reset if retained after encryption                           |
| `VYLK_PASSWORD_FILE`            | Unset                      | Read the password from a Docker/Kubernetes secret file                                                                     |
| `VYLK_APP_NAME`                 | `VYLK`                     | App and PWA name; restart to apply                                                                                         |
| `VYLK_NO_BROWSER`               | Unset                      | Set to `1` to suppress browser opening                                                                                     |
| `VYLK_TRUST_PROXY`              | Unset                      | Set to `1` only behind a trusted proxy supplying client-IP headers                                                         |
| `VYLK_REQUIRE_STRONG_PASSWORDS` | `false`                    | Require strong configured passwords and device-side passphrases                                                            |
| `VYLK_DISABLE_VAULT_CHANGES`    | `false`                    | Reject encryption setup, credential changes, vault resets, and device revocation; sign-in and note access remain available |
| `ARTIFICIAL_RTT_DELAY_MS`       | `0`                        | Development-only request delay; excludes event streams                                                                     |

The two boolean policy settings accept `true`, `false`, `1`, or `0`.
Stopping Vylk does not close your browser.

## Docker

The published image supports Linux amd64 and arm64. Replace `<version>` with a
release version; `latest` is also available.

```sh
docker run -d --name vylk -p 8080:8080 \
  -e VYLK_PASSWORD='your-password' \
  -v vylk-data:/data \
  docker.io/toxdes/vylk:<version>
```

`/data` contains both `/data/notes` and `/data/vylk.db`. Reuse the same volume
when replacing the container with a newer image.

## Storage and recovery

Back up **both** `VYLK_DB` and `VYLK_DIR` together. Plaintext mode stores Markdown
files; encrypted mode stores ciphertext files and database-held key wrappers.
An encrypted backup also needs its passphrase or recovery key to unlock.

Restarting with the same database and directory preserves the sync identity.
Replacing the database prompts browsers to **Keep changes** or **Switch**.
Keep changes pauses sync without deleting local edits; restore the previous
database and directory, then reload. Switch discards this browser's cached notes
and pending edits before connecting to the replacement database. Restoring an
older backup of the same database is not detected as a new identity.

## Encryption and HTTPS

Enable E2EE in **Preferences → Encryption**. Conversion encrypts notes on the
device and can resume after an interruption. Save the recovery key before
starting. Losing both the passphrase and recovery key makes notes irrecoverable.
See the [encryption guide](https://vylk.toxdes.com/docs/#end-to-end-encryption).

Encrypted browser access requires HTTPS remotely, or HTTP on localhost/loopback.
A plain HTTP LAN address cannot unlock the vault. Terminate HTTPS at a trusted
reverse proxy; Vylk does not issue certificates itself.

After conversion, the vault passphrase or recovery key replaces the initial
password for sign-in. Keeping `VYLK_PASSWORD` enables the destructive “Forgot
both?” reset; it cannot decrypt or recover the old notes. The reset archives the
old ciphertext for 30 days before deletion. Remove the variable and restart if
you do not want that reset available.

Browsers remember their unlock key across tabs and refreshes. Sign-out forgets
that key while retaining encrypted pending edits. **Account → Devices** can
revoke other browser profiles; offline devices lock when they reconnect.
Revocation cannot erase another device's cached notes or keys it already holds.
Changing credentials rewraps the vault key; it does not rotate that key.

Trust the deployment serving the app: a compromised server can replace its
JavaScript and capture secrets. E2EE does not hide note IDs, revisions,
timestamps, pin state, or preferences, and does not detect ciphertext rollback.
Old backups and browser/filesystem snapshots may still contain plaintext from
before conversion. Restart after conversion to release plaintext held in the
old server process, and review your backup retention policy.
