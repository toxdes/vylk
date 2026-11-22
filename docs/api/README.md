# Backend API documentation

- [openapi.json](openapi.json) is the HTTP API reference. It is the only source for routes, parameters, bodies, responses, error codes, and examples.
- [client-protocol.md](client-protocol.md) describes what single routes cannot: sign-in order, sync, conflict handling, encryption setup, the encryption wire format, and AI assist.

The lander renders `openapi.json` as one page with these parts for each route: request headers, path and query parameters, the request body, a table of responses with one row for each error code, response headers, the response body, an example `curl` request, and an example response.

## Change an endpoint

Update `openapi.json` in the same change as the handler.

- Give each operation a `summary` that names the task, such as "Save a note", and a `description` in full sentences.
- Give each request body an `example`, and each success response an `example`.
- List each error code as one entry under the response's `examples`. The entry key is the code. Its `summary` says when the server returns the code.
- Give path parameters an `example`. Give query and header parameters an `example` when the example request uses them.
- Take example values from a real server. Do not invent response fields.

## Checks

Run the reference tests before you submit a change:

```sh
go test ./internal/server -run TestAPIReference
```

The tests fail when:

- A route in `router.go` has no operation, or an operation has no route.
- A schema field differs from its Go wire type.
- A request body or success response has no example.
- An error example key differs from its `code`, or the code does not occur in the server source.
- A request example does not decode into the Go type that the handler decodes.

To validate the OpenAPI syntax, run:

```sh
uvx --from openapi-spec-validator==0.9.0 openapi-spec-validator docs/api/openapi.json
```

The tests do not prove that each description is true. Check behavior against a running server.

## Publishing

The lander fetches these files from the release tag that it builds and generates the `/docs/api/` pages. To preview unreleased changes, use the lander's local source build.
