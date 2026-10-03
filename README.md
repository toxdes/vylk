# vylk

[Website](https://vylk.toxdes.com) · [Demo](https://demo.vylk.toxdes.com) · [Install](https://vylk.toxdes.com/docs/#install) · [Docs](https://vylk.toxdes.com/docs/)

A lightweight, self-hosted Markdown notes app. One binary, your notes, all your devices.

- Write offline; changes sync when you reconnect.
- Edit with live preview, drag-to-reorder blocks, and task checkboxes.
- Focus in Zen mode, or work in a resizable split view.
- Organize with tags, search, and wiki links.
- Make it yours with themes, fonts, shortcuts, and mobile-friendly controls.
- Optionally encrypt notes end to end, with a 24-word recovery key.

## Run

[Install vylk](https://vylk.toxdes.com/docs/#install), then:

```sh
VYLK_PASSWORD='your-password' vylk
```

Open `http://localhost:8080`. Notes live in `./notes` and metadata in `./vylk.db`.
Use `--no-browser` on a headless server. For Docker, configuration, and backups,
see [self-hosting](docs/self-hosting.md).

Enable encryption in **Preferences → Encryption**. Remote encrypted access requires
HTTPS; keep your recovery key safe. [Encryption guide](https://vylk.toxdes.com/docs/#end-to-end-encryption).

## Develop

```sh
bun ci
go build ./cmd/vylk
go test ./...
bun run test:frontend
bun run test:browser
```

[Development and releases](docs/development.md) · [Backend API reference](docs/api/README.md) · [Client protocol](docs/api/client-protocol.md) · [Engineering standards](AGENTS.md)

## License

[MIT](LICENSE).
