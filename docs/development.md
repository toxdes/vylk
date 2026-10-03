# Development and releases

## Build and verify

Use Go as specified in `go.mod` and Bun as specified in `package.json`.

```sh
bun ci
go build ./cmd/vylk
go test ./...
go vet ./...
go tool staticcheck ./...
bun run format:check
bun run lint
bun run check:css-build
bun run test:frontend
bun run test:browser
```

Browser tests use an installed Chrome binary and temporary servers/data.
Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`.
For local upgrade testing, `VYLK_BROWSER_UPGRADE_SOURCE` can point to a previous
source checkout when running `test/browser/demo-reset.spec.js`.

Edit SCSS in `frontend/styles`, then run `bun run build:css`. Browser crypto
bundles are regenerated with `bun run build:crypto`. Read [AGENTS.md](../AGENTS.md)
for module ownership and engineering standards, and update the
[API reference](api/README.md) when changing endpoints.

`python3 build.py` cross-compiles release binaries. [Yesb](https://github.com/toxdes/yesb)
owns distribution: Debian/RPM packages, AUR, archives, and Docker images. Use
`./yesb/build_all.py` for package builds. To build a local runtime image:

```sh
docker build --target runtime -t vylk:local -f Dockerfile.runtime .
```

After reviewing a dry run, `./yesb/release_docker.py --env <release-env-file>`
publishes the configured version and `latest` Docker tags.

## CI and releases

CI checks Go formatting, modules, tests, vet, Staticcheck, and builds, plus
frontend formatting, generated CSS, linting, unit/browser tests, and release
workflow tests. Protect `main` with pull requests and the latest commit's
successful `CI / checks` status; disable direct and force pushes.

For a stable release:

1. Create `release/vX.Y.Z` from `main`, update `VERSION`, and open a PR.
2. Squash-merge it, then tag and push `vX.Y.Z` on the resulting `main` commit.
3. The [release workflow](../.github/workflows/release.yml) validates the version,
   creates a GitHub Release with generated notes, and calls deployment hooks.
   It does not run Yesb or attach artifacts.

Older versions are rejected. Deliberate redeployment uses the manual workflow's
rollback tag and exact `ROLLBACK <tag>` confirmation.

Store hooks as repository **Actions secrets** named
`VYLK_DEPLOY_HOOK_<DESTINATION>_URL`, and map each secret to the same environment
variable in `release.yml`. Hooks must use HTTPS, accept a JSON `POST`, and return
`2xx`. Failed hooks retry five times at five-minute intervals. Receivers must
deduplicate the stable `Idempotency-Key` header / `idempotency_key` field because
timeouts and workflow reruns can resend a successful request.

The [nightly workflow](../.github/workflows/nightly.yml) runs at 02:17
Asia/Kolkata, publishing a moving `Nightly` pre-release with Linux archives and
checksums. Set repository variable `NIGHTLY_ENABLED=false` to disable its
scheduled runs; manual runs remain available.

## Landing page

`vylk-lander` is a separate static site. Cloudflare Pages runs `./build.sh` and
publishes `dist`. Its build fetches the version and matching release-tag API
specification/guides, generating HTML in the lander's existing styles. Generated
HTML is not committed and adds no Vylk server runtime cost. See the lander
repository's build instructions for version overrides and local previews.
