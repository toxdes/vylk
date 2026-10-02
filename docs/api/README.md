# Backend API documentation

- [openapi.json](openapi.json): canonical OpenAPI 3.1 HTTP reference for every
  `/api/` route, including plaintext and encrypted variants.
- [client-protocol.md](client-protocol.md): authentication, revisions, offline
  synchronization, reset handling, migration, and interoperable E2EE primitives.

When adding or modifying an endpoint, update its operation, shared schemas, and
protocol guidance in the same change. Keep descriptions concise and document
conditional requirements and compatibility quirks explicitly. Do not change
runtime behavior to make it match a nicer-looking specification.

Go tests compare the router's API methods/paths and wire-model fields with the
specification, check local references, and require documented success responses.
Run `go test ./internal/server -run TestAPIReference` before submitting changes.
For full OpenAPI syntax validation with an isolated build-time tool, run
`uvx --from openapi-spec-validator==0.9.0 openapi-spec-validator docs/api/openapi.json`.
These checks catch omissions, not every semantic difference: HTTP behavior and
crypto interoperability still need their implementation tests.

The separate lander fetches these files from the release tag selected at build
time, generating static `/docs/api/` HTML using its existing visual system.
Generated HTML is not committed. Preview an unreleased worktree with the
lander's documented local-source build option. Do not publish branch docs as
release docs or fall back to a different ref after a failed download.
