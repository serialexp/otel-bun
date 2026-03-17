# otel-bun

OpenTelemetry instrumentation for Bun's native APIs.

Bun doesn't use Node's `http` module, so standard OTel auto-instrumentations can't patch `Bun.serve()` or `fetch()`. This package fills that gap.

## Installation

```bash
bun add otel-bun
```

## Quick Start

```typescript
import { ensureContextManager, instrumentServe, instrumentFetch } from "otel-bun";

// IMPORTANT: call this before starting your OTel SDK
// Bun needs an explicit context manager for trace context propagation
ensureContextManager();

// Instrument outgoing fetch() calls
instrumentFetch();

// Wrap your Bun.serve handler
const server = Bun.serve({
  fetch: instrumentServe(async (req) => {
    // Your handler — spans are created automatically
    const data = await fetch("https://api.example.com/data"); // also traced
    return new Response("ok");
  }),
});
```

## Why `ensureContextManager()`?

Bun supports `AsyncLocalStorage` but the OpenTelemetry SDK doesn't auto-detect it in Bun (it only does for Node.js). Without a context manager, `context.with()` is a no-op — meaning:

- Parent/child span relationships won't work
- Trace context won't propagate across async boundaries
- `trace.getActiveSpan()` always returns undefined

Call `ensureContextManager()` once before setting up your OTel SDK and everything works.

## API

### `ensureContextManager()`

Registers the `AsyncLocalStorageContextManager` with the OpenTelemetry API. Safe to call multiple times.

### `instrumentServe(handler)`

Wraps a `Bun.serve` fetch handler to create server spans for each incoming request.

- Extracts trace context from incoming headers (W3C traceparent)
- Creates a `SERVER` span with HTTP semantic convention attributes
- Sets error status for 5xx responses
- Records exceptions when the handler throws

```typescript
Bun.serve({
  fetch: instrumentServe((req, server) => {
    return new Response("ok");
  }),
});
```

### `setHttpRoute(route)`

Sets the `http.route` attribute on the current active span. Call this from within a route handler when you know the matched route pattern.

```typescript
instrumentServe((req) => {
  setHttpRoute("/api/users/:id");
  return new Response("ok");
});
```

### `instrumentFetch()`

Replaces `globalThis.fetch` with an instrumented version that creates client spans.

- Injects trace context into outgoing headers for distributed tracing
- Creates a `CLIENT` span with HTTP semantic convention attributes
- Sets error status for 5xx responses and network errors

### `uninstrumentFetch()`

Restores the original `fetch`.

### `getOriginalFetch()`

Returns the original, non-instrumented `fetch` function.

## Span Attributes

Server spans (`instrumentServe`):
- `http.request.method`
- `url.path`
- `url.scheme`
- `url.query`
- `server.address`
- `server.port`
- `http.response.status_code`
- `http.route` (when set via `setHttpRoute`)

Client spans (`instrumentFetch`):
- `http.request.method`
- `url.full`
- `server.address`
- `server.port`
- `http.response.status_code`

## Requirements

- Bun >= 1.0
- `@opentelemetry/api` >= 1.0 (peer dependency via your OTel SDK)

## License

ISC
