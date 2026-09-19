# Code quality

- Preserve observable behavior. Add characterization tests before changing untested behavior.
- Prefer the simplest cohesive design that meets the current requirement (YAGNI).
- Remove meaningful duplication, but do not abstract code merely because it looks similar.
- Keep responsibilities narrow and dependencies explicit. Apply SOLID principles and design patterns only when they improve changeability or testability.
- Write comments for constraints, implicit assumptions, compatibility workarounds, and non-obvious decisions. Do not narrate self-explanatory code.
- Treat performance as behavior: avoid extra I/O, database queries, allocations, DOM work, and unbounded collections in hot paths.

## Go

- Follow idiomatic Go, keep errors contextual, and keep resource ownership clear.
- Run `gofmt`, `go vet`, Staticcheck, and the Go tests after changes.

## Frontend

- Keep browser code grouped by responsibility under `static/js`; keep third-party code in `static/vendor`.
- Keep modules focused and independently testable; inject side effects at test seams.
- Release timers, listeners, observers, workers, controllers, and stale DOM references when their lifecycle ends.
- Prefer `WeakMap` for element metadata. Bound long-lived `Map`, `Set`, cache, queue, and history growth.
- Edit styles in `frontend/styles`; regenerate `static/style.css` with `bun run build:css`.
- Run Prettier, ESLint, Stylelint, HTMLHint, frontend behavior tests, and relevant browser tests after changes.
