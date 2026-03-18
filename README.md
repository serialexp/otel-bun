# otel-bun

OpenTelemetry instrumentation for Bun's native APIs.

Bun doesn't use Node's `http` module, so standard OTel auto-instrumentations can't patch `Bun.serve()`, `fetch()`, or any of Bun's built-in clients. This package fills that gap.

## Installation

```bash
bun add otel-bun
```

## Quick Start

```typescript
import {
  ensureContextManager,
  instrumentServe,
  instrumentFetch,
  instrumentRedis,
  instrumentWebSocket,
} from "otel-bun";

// IMPORTANT: call this before starting your OTel SDK
// Bun needs an explicit context manager for trace context propagation
ensureContextManager();

// Instrument outgoing fetch() calls
instrumentFetch();

// Wrap your Bun.serve handler
const server = Bun.serve({
  fetch: instrumentServe(async (req, server) => {
    if (req.url.endsWith("/ws")) {
      server.upgrade(req);
      return new Response(null, { status: 101 });
    }
    const data = await fetch("https://api.example.com/data"); // also traced
    return new Response("ok");
  }),
  websocket: instrumentWebSocket({
    message(ws, msg) { ws.send("echo: " + msg); },
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

### HTTP

#### `ensureContextManager()`

Registers the `AsyncLocalStorageContextManager` with the OpenTelemetry API. Safe to call multiple times.

#### `instrumentServe(handler)`

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

#### `setHttpRoute(route)`

Sets the `http.route` attribute on the current active span. Call this from within a route handler when you know the matched route pattern.

```typescript
instrumentServe((req) => {
  setHttpRoute("/api/users/:id");
  return new Response("ok");
});
```

#### `instrumentFetch()` / `uninstrumentFetch()` / `getOriginalFetch()`

Replaces `globalThis.fetch` with an instrumented version that creates client spans. Injects trace context into outgoing headers for distributed tracing.

### WebSockets

#### `instrumentWebSocket(handlers)`

Wraps a `Bun.serve` websocket handler config to create spans for WebSocket lifecycle events (`open`, `message`, `close`, `error`).

```typescript
Bun.serve({
  fetch(req, server) { server.upgrade(req); },
  websocket: instrumentWebSocket({
    message(ws, msg) { ws.send("echo: " + msg); },
    close(ws, code, reason) { console.log("closed", code); },
  }),
});
```

Spans include attributes like `websocket.event`, `websocket.message.size`, `websocket.message.type`, and `websocket.close.code`.

### Redis

#### `instrumentRedis(client, options?)` / `uninstrumentRedis(client)`

Instruments a `Bun.RedisClient` instance, wrapping all command methods to create CLIENT spans with DB semantic conventions.

```typescript
import { RedisClient } from "bun";
import { instrumentRedis } from "otel-bun";

const redis = new RedisClient("redis://localhost:6379");
instrumentRedis(redis, {
  serverAddress: "localhost",
  serverPort: 6379,
  namespace: "0",
});

await redis.get("mykey"); // creates a span: GET
await redis.set("mykey", "value"); // creates a span: SET
```

### SQLite

#### `instrumentSQLite(db, options?)` / `uninstrumentSQLite(db)`

Instruments a `bun:sqlite` Database instance, wrapping `query()`, `prepare()`, `run()`, and `transaction()` to create CLIENT spans.

```typescript
import { Database } from "bun:sqlite";
import { instrumentSQLite } from "otel-bun";

const db = new Database("app.db");
instrumentSQLite(db, { namespace: "app.db" });

db.query("SELECT * FROM users WHERE id = ?").get(1); // creates a span: GET
db.run("INSERT INTO logs (msg) VALUES (?)", "hello"); // creates a span: RUN
```

Spans include `db.query.text` with the SQL statement.

### PostgreSQL (Bun.sql)

#### `instrumentSQL(client, options?)`

Wraps a `Bun.SQL` client with a Proxy that instruments tagged template queries, `.unsafe()`, `.begin()` transactions, and `.reserve()` connections.

```typescript
import { SQL } from "bun";
import { instrumentSQL } from "otel-bun";

const sql = instrumentSQL(new SQL("postgres://localhost/mydb"), {
  serverAddress: "localhost",
  serverPort: 5432,
  namespace: "mydb",
});

await sql`SELECT * FROM users WHERE id = ${1}`; // creates a span: SELECT
await sql.begin(async (tx) => {
  await tx`INSERT INTO users (name) VALUES (${"Alice"})`; // span: INSERT
}); // wrapped in a TRANSACTION span
```

### Child Processes

#### `instrumentSpawn()` / `uninstrumentSpawn()`

Instruments `Bun.spawn` and `Bun.spawnSync` to create spans tracking child process lifecycle.

```typescript
import { instrumentSpawn } from "otel-bun";

instrumentSpawn();

const proc = Bun.spawn(["curl", "-s", "https://example.com"]);
await proc.exited; // span ends with exit code

const result = Bun.spawnSync(["echo", "hello"]); // span covers full execution
```

Spans include `process.command`, `process.command_args`, `process.pid`, and `process.exit.code`.

## Span Attributes

Server spans (`instrumentServe`):
- `http.request.method`, `url.path`, `url.scheme`, `url.query`
- `server.address`, `server.port`, `http.response.status_code`
- `http.route` (when set via `setHttpRoute`)

Client spans (`instrumentFetch`):
- `http.request.method`, `url.full`, `server.address`, `server.port`, `http.response.status_code`

Database spans (`instrumentRedis`, `instrumentSQLite`, `instrumentSQL`):
- `db.system.name`, `db.operation.name`, `db.namespace`
- `db.query.text` (SQLite, PostgreSQL), `server.address`, `server.port`

WebSocket spans (`instrumentWebSocket`):
- `websocket.event`, `websocket.message.size`, `websocket.message.type`
- `websocket.close.code`, `websocket.close.reason`, `network.peer.address`

Process spans (`instrumentSpawn`):
- `process.command`, `process.command_args`, `process.pid`, `process.exit.code`

## Requirements

- Bun >= 1.0
- `@opentelemetry/api` >= 1.0 (peer dependency via your OTel SDK)

## License

ISC
