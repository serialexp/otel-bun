# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`otel-bun` is an OpenTelemetry instrumentation library for Bun's native APIs. Standard OTel auto-instrumentations can't patch these because Bun doesn't use Node's `http` module or standard DB drivers.

Published to npm as `otel-bun`. Uses `@opentelemetry/api` as a runtime dependency and follows OTel HTTP semantic conventions.

## Commands

```bash
bun install          # install dependencies
bun run build        # build with tsup (ESM + .d.ts → dist/)
bun test             # run all tests
bun test test/serve.test.ts   # run a single test file
```

There is no linter configured.

## Architecture

Source files in `src/`, single entry point at `src/index.ts`:

- **`context.ts`** — `ensureContextManager()`: registers `AsyncLocalStorageContextManager` with the OTel API. Required because Bun doesn't auto-detect it like Node does.
- **`serve.ts`** — `instrumentServe(handler)`: wraps a `Bun.serve` fetch handler to create SERVER spans with context extraction from incoming headers. Also exports `setHttpRoute()`.
- **`fetch.ts`** — `instrumentFetch()`: monkey-patches `globalThis.fetch` to create CLIENT spans and inject trace context into outgoing headers.
- **`redis.ts`** — `instrumentRedis(client)`: wraps RedisClient command methods to create CLIENT spans with DB semantic conventions. Instance-level instrumentation.
- **`sqlite.ts`** — `instrumentSQLite(db)`: wraps `bun:sqlite` Database methods (`query`, `prepare`, `run`, `transaction`). Cached statements from `query()` are tracked to avoid double-wrapping.
- **`spawn.ts`** — `instrumentSpawn()`: monkey-patches `Bun.spawn`/`Bun.spawnSync` globally. Async spans end on process exit via `.exited` promise.
- **`websocket.ts`** — `instrumentWebSocket(handlers)`: wraps the websocket handler config passed to `Bun.serve`. Returns a new config object (no mutation).
- **`sql.ts`** — `instrumentSQL(client)`: returns a Proxy around a `Bun.SQL` client that intercepts tagged template calls, `.unsafe()`, `.begin()` transactions, and `.reserve()`. Does not mutate the original.

## Testing

Tests use `bun:test` with an in-memory OTel setup. `test/setup.ts` is preloaded via `bunfig.toml` and configures a `BasicTracerProvider` with `InMemorySpanExporter` + `SimpleSpanProcessor`. Tests spin up real `Bun.serve` instances on ephemeral ports (`:0`) and make actual HTTP requests.

The shared `exporter` is imported from `test/setup.ts` and reset in `afterEach`. Use `getOriginalFetch()` in tests when you need uninstrumented fetch (e.g., to send a specific `traceparent` header without it being overwritten).

## Release Process

Handled by `just-release` via two GitHub Actions workflows:
1. **Release** (non-release commits on main): runs `just-release` to create a release PR with version bump
2. **Publish** (release commits on main): builds, then runs `just-release` which handles npm publish

Commits should follow conventional commits (`feat:`, `fix:`, etc.) for automated versioning.
