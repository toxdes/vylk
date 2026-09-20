# Engineering standards

- Preserve observable behavior. Characterize untested behavior before refactoring it.
- Treat performance as a first-class requirement: aim for above-average latency, throughput, and memory efficiency, and accept extra implementation care when it produces a material gain. Measure hot paths and avoid speculative micro-optimization that harms clarity or maintainability.
- Prefer the simplest cohesive solution that meets the current need (YAGNI). Remove meaningful duplication, but do not abstract coincidentally similar code.
- Give each module one clear owner and lifecycle. Keep dependencies explicit and directed from orchestration toward capabilities.
- Apply SOLID principles and design patterns only when they make ownership, testing, or future changes simpler.
- Aim for files near 1,000 lines. Split at responsibility boundaries, never solely to satisfy a line count.
- Comment constraints, implicit assumptions, compatibility workarounds, and non-obvious tradeoffs—not self-explanatory mechanics.
- Remove dead paths and stale references. Avoid unnecessary I/O, queries, allocations, DOM work, and unbounded collections, especially in hot paths.

## Backend

- Write idiomatic Go with contextual errors and explicit resource ownership.
- Keep executable wiring in `cmd/vylk`, application/HTTP orchestration in `internal/server`, and reusable capabilities in focused `internal` packages.
- Capability packages must not import `internal/server`. Define interfaces only at demonstrated test or integration seams.

## Frontend

- Group browser modules by responsibility under `internal/web/static/js/{core,editor,sync,ui}`; keep `app.js` as composition and event wiring.
- Inject side effects at module boundaries. Prefer small pure helpers for policy and transformation logic.
- Release owned timers, listeners, observers, workers, and DOM references. Use `WeakMap` for element metadata and bound long-lived caches, queues, sets, maps, and histories.
- Edit SCSS in `frontend/styles`; regenerate `internal/web/static/style.css` rather than editing it directly.

## Verification

- Add focused unit tests for isolated policy and characterization tests for cross-module behavior.
- Before handoff, run formatting, linting, generated-CSS verification, Go tests/vet/Staticcheck, frontend tests, and relevant browser tests.
