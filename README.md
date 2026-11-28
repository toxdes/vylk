# vylk

[Website](https://vylk.app) · [Demo](https://demo.vylk.app) · [Documentation](https://vylk.app/docs/)

A lightweight, self-hosted Markdown notes app. One binary, your notes, all your devices.

- Write offline. Changes sync when you reconnect.
- Edit with live preview, drag-to-reorder blocks, and task checkboxes.
- Focus in Zen mode, or work in a resizable split view.
- Organize with tags, pins, and wiki links.
- Make it yours with themes, fonts, shortcuts, and mobile-friendly controls.
- Optionally encrypt notes end to end, with a 24-word recovery key.
- Optionally use your own AI provider for answers and reviewed edits in Editor mode.

## Run

[Install vylk](docs/getting-started.md#install-vylk), then:

```sh
VYLK_PASSWORD='your-password' vylk
```

Open `http://localhost:8080`. Notes live in `./notes` and metadata in `./vylk.db`.

## Documentation

- [Getting started](docs/getting-started.md): install vylk and write your first note.
- [How-to guides](docs/how-to.md): other devices, HTTPS, encryption, backups, and updates.
- [How vylk works](docs/concepts.md): storage, devices, sync, and conflicts.
- [End-to-end encryption](docs/encryption.md): design, keys, and security limits.
- [Command-line reference](docs/cli-reference.md): options, environment variables, files, and startup errors.
- [Backend API reference](docs/api/README.md) and [client protocol](docs/api/client-protocol.md).

The website publishes these pages from each release tag.

## Arch Linux

Build the latest tagged release with `yay -S vylk`. Use `vylk-bin` for the
prebuilt release or `vylk-git` for the latest development source.

## Develop

```sh
bun ci
go build ./cmd/vylk
go test ./...
bun run test:frontend
bun run test:browser
```

[Development and releases](docs/development.md) · [Engineering standards](AGENTS.md)

## License

[MIT](LICENSE).
