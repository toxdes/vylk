# Command-line reference

## Synopsis

```text
vylk [--no-browser]
vylk --version
```

`vylk` runs the server in the foreground until it receives `SIGINT` or `SIGTERM`. Configuration comes from environment variables. vylk has no configuration file and no subcommands.

## Options

| Option                        | Effect                                                                      |
| ----------------------------- | --------------------------------------------------------------------------- |
| `--no-browser`                | Do not open a browser after startup. Equivalent to `VYLK_NO_BROWSER=1`.     |
| `--version`, `-version`, `-v` | Print the version and exit. vylk reads no configuration and opens no files. |

vylk ignores every other argument.

## Environment variables

| Variable                        | Default     | Description                                                                                                                                                                                                                                                            |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VYLK_PASSWORD`                 | None        | Password for sign-in and for encryption setup. Required until the vault is encrypted. After encryption, it authorizes only `POST /api/vault/reset`.                                                                                                                    |
| `VYLK_PASSWORD_FILE`            | Unset       | Path to a file that contains the password. When set, vylk reads the password from this file and ignores `VYLK_PASSWORD`. One trailing line break is removed.                                                                                                           |
| `PORT`                          | `8080`      | TCP port. vylk listens on all network interfaces.                                                                                                                                                                                                                      |
| `VYLK_DIR`                      | `./notes`   | Notes folder. vylk creates it if it does not exist. A relative path is resolved against the working directory.                                                                                                                                                         |
| `VYLK_DB`                       | `./vylk.db` | SQLite database file. A relative path is resolved against the working directory.                                                                                                                                                                                       |
| `VYLK_APP_NAME`                 | `VYLK`      | Name shown in the app and used for the installed app. At most 64 characters, with no control characters. Changes apply after a restart.                                                                                                                                |
| `VYLK_NO_BROWSER`               | Unset       | Set to `1` to skip opening a browser. Any other value has no effect.                                                                                                                                                                                                   |
| `VYLK_TRUST_PROXY`              | Unset       | Set to `1` when a trusted reverse proxy sends every request. See [Reverse proxy headers](#reverse-proxy-headers). Any other value has no effect.                                                                                                                       |
| `VYLK_REQUIRE_STRONG_PASSWORDS` | `false`     | When true, vylk refuses to start with a weak `VYLK_PASSWORD`, and browsers reject weak encryption passwords.                                                                                                                                                           |
| `VYLK_DISABLE_VAULT_CHANGES`    | `false`     | When true, the API rejects encryption setup, password and recovery key changes, vault reset, and device sign-out. Sign-in, notes, and an existing encrypted vault keep working. vylk refuses to start with this setting while an encryption conversion is in progress. |
| `VYLK_AI_CONCURRENCY`           | `4`         | Maximum AI provider requests that run at the same time on this server, including tests and checks. An integer from 1 to 8. Any other value stops startup.                                                                                                              |
| `VYLK_AI_DEBUG`                 | Unset       | Set to `1` to log AI provider requests and responses to standard error, up to 16 MiB. The log contains note text and prompts. Use it only to debug a provider.                                                                                                         |
| `ARTIFICIAL_RTT_DELAY_MS`       | `0`         | Development only. Delays each request, except the event stream, by this many milliseconds. Values above 60000 are treated as 60000.                                                                                                                                    |

`VYLK_REQUIRE_STRONG_PASSWORDS` and `VYLK_DISABLE_VAULT_CHANGES` accept `true`, `false`, `1`, `0`, and the other values that Go's `strconv.ParseBool` accepts. Any other value stops startup.

A password is strong when the zxcvbn estimator gives it a score of 4.

### Reverse proxy headers

With `VYLK_TRUST_PROXY=1`, vylk uses these request headers:

- `X-Forwarded-For`, then `X-Real-IP`, as the client address for sign-in rate limiting.
- `X-Forwarded-Proto: https` to mark session cookies as `Secure`.

A client that reaches vylk directly can set these headers to any value. Enable this setting only when the port is not reachable except through the proxy.

## Files

| Path                                     | Contents                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `VYLK_DIR/ID.md`                         | Plaintext mode. One Markdown file for each note, named by note ID.                                                         |
| `VYLK_DIR/.vylk-vault/epoch-N/ID.md.enc` | Encrypted mode. One encrypted envelope for each note, grouped by vault epoch.                                              |
| `VYLK_DIR/.vylk-vault-archives/`         | Old ciphertext from a vault reset. Each archive is deleted 30 days after the reset.                                        |
| `VYLK_DB`                                | Note metadata, preferences, sessions, devices, sync history, and encryption key wrappers.                                  |
| `VYLK_DB.pre-migration-vN-TIMESTAMP.db`  | Copy of the database taken before a schema migration, in the same folder as `VYLK_DB`. vylk keeps the three newest copies. |

Back up `VYLK_DIR` and `VYLK_DB` together. For the procedure, see [Back up your notes](how-to.md#back-up-your-notes).

## Startup and shutdown

At startup, vylk:

1. Exits with an error if a removed server-side encryption setting is present.
2. Creates `VYLK_DIR` if necessary and opens `VYLK_DB`.
3. Applies pending database migrations, after it saves a pre-migration copy of the database.
4. Finishes interrupted file operations and encryption cleanup.
5. Listens on `PORT` and prints `vylk running on :PORT (notes: DIR, db: DB)`.
6. Opens `http://127.0.0.1:PORT/` in the default browser, unless `--no-browser` or `VYLK_NO_BROWSER=1` is set. On Linux, vylk runs `xdg-open`. On macOS, it runs `open`. On Windows, it uses `rundll32`.

On `SIGINT` or `SIGTERM`, vylk prints `shutting down...` and waits up to 5 seconds for open requests to finish. Stopping vylk does not close the browser.

## Startup errors

vylk prints the error and exits with status 1.

| Message                                                                               | Cause                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VYLK_PASSWORD environment variable is required until the vault is encrypted`         | No password is set, and the vault is not encrypted.                                                                                                              |
| `password: open PATH: no such file or directory`                                      | `VYLK_PASSWORD_FILE` points to a file that does not exist.                                                                                                       |
| `VYLK_PASSWORD must be strong when VYLK_REQUIRE_STRONG_PASSWORDS is enabled`          | `VYLK_REQUIRE_STRONG_PASSWORDS` is true, and the password scores below 4.                                                                                        |
| `VYLK_DISABLE_VAULT_CHANGES cannot be enabled while a vault migration is in progress` | An encryption conversion is unfinished. Finish it, or start without this setting.                                                                                |
| `NAME is no longer supported: server-side encryption was removed; ...`                | A removed server-side encryption setting is set. See [Server-side encryption from earlier versions](encryption.md#server-side-encryption-from-earlier-versions). |
| `notes storage: server-side encryption metadata found; ...`                           | The notes folder contains files from removed server-side encryption.                                                                                             |
| `app name: VYLK_APP_NAME must be at most 64 characters`                               | `VYLK_APP_NAME` is too long.                                                                                                                                     |
| `server: listen tcp :PORT: bind: address already in use`                              | Another program uses the port. Set `PORT` to a free port.                                                                                                        |

## Docker image

The image `toxdes/vylk` is published for Linux on `amd64` and `arm64`. Each release has a version tag, such as `toxdes/vylk:__VYLK_VERSION__`, and the newest release is also tagged `latest`.

| Setting      | Value           |
| ------------ | --------------- |
| Entry point  | `/vylk`         |
| Exposed port | `8080`          |
| Volume       | `/data`         |
| `PORT`       | `8080`          |
| `VYLK_DIR`   | `/data/notes`   |
| `VYLK_DB`    | `/data/vylk.db` |
| Stop signal  | `SIGTERM`       |

The image has no shell and no browser. Pass `VYLK_PASSWORD` or `VYLK_PASSWORD_FILE` with `-e`. To keep your notes when you replace the container, mount the same volume at `/data`.
