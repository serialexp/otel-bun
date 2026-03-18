import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Database } from "bun:sqlite";
import { exporter } from "./setup.ts";
import { instrumentSQLite, uninstrumentSQLite } from "../src/sqlite.ts";

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  db.run("INSERT INTO users (name, email) VALUES ('Alice', 'alice@test.com')");
  exporter.reset();
});

afterEach(() => {
  db.close();
});

describe("instrumentSQLite", () => {
  test("creates a span for query().all()", () => {
    instrumentSQLite(db, { namespace: ":memory:" });

    const rows = db.query("SELECT * FROM users").all();
    expect(rows).toHaveLength(1);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.name).toBe("ALL");
    expect(span.attributes["db.operation.name"]).toBe("ALL");
    expect(span.attributes["db.system.name"]).toBe("sqlite");
    expect(span.attributes["db.query.text"]).toBe("SELECT * FROM users");
    expect(span.attributes["db.namespace"]).toBe(":memory:");
  });

  test("creates a span for query().get()", () => {
    instrumentSQLite(db);

    const row = db.query("SELECT * FROM users WHERE id = ?").get(1);
    expect(row).toBeDefined();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("GET");
    expect(spans[0]!.attributes["db.query.text"]).toBe(
      "SELECT * FROM users WHERE id = ?",
    );
  });

  test("creates a span for query().run()", () => {
    instrumentSQLite(db);

    const result = db
      .query("INSERT INTO users (name, email) VALUES (?, ?)")
      .run("Charlie", "charlie@test.com");
    expect(result.changes).toBe(1);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("RUN");
  });

  test("creates a span for query().values()", () => {
    instrumentSQLite(db);

    const rows = db.query("SELECT name, email FROM users").values();
    expect(rows[0]).toEqual(["Alice", "alice@test.com"]);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("VALUES");
  });

  test("creates a span for db.run()", () => {
    instrumentSQLite(db);

    db.run("INSERT INTO users (name, email) VALUES ('Eve', 'eve@test.com')");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("RUN");
    expect(spans[0]!.attributes["db.query.text"]).toBe(
      "INSERT INTO users (name, email) VALUES ('Eve', 'eve@test.com')",
    );
  });

  test("creates a span for prepare()", () => {
    instrumentSQLite(db);

    const stmt = db.prepare("SELECT * FROM users WHERE name = ?");
    stmt.all("Alice");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("ALL");
    expect(spans[0]!.attributes["db.query.text"]).toBe(
      "SELECT * FROM users WHERE name = ?",
    );
  });

  test("creates a span for transaction()", () => {
    instrumentSQLite(db);

    const insertMany = db.transaction((names: string[]) => {
      for (const name of names) {
        db.run(
          `INSERT INTO users (name, email) VALUES ('${name}', '${name}@test.com')`,
        );
      }
    });

    insertMany(["Frank", "Grace"]);

    const spans = exporter.getFinishedSpans();
    const txnSpan = spans.find(
      (s) => s.attributes["db.operation.name"] === "TRANSACTION",
    );
    expect(txnSpan).toBeDefined();
    expect(txnSpan!.name).toBe("TRANSACTION");

    // Should have spans for BEGIN, 2 INSERTs, and COMMIT (plus the TRANSACTION span)
    const runSpans = spans.filter(
      (s) => s.attributes["db.operation.name"] === "RUN",
    );
    expect(runSpans).toHaveLength(4);
    expect(runSpans[0]!.attributes["db.query.text"]).toBe("BEGIN");
    expect(runSpans[3]!.attributes["db.query.text"]).toBe("COMMIT");
  });

  test("records error on failed query", () => {
    instrumentSQLite(db);

    try {
      db.run("SELECT * FROM nonexistent_table");
    } catch {
      // expected
    }

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.events[0]!.name).toBe("exception");
  });

  test("calling instrumentSQLite twice is a no-op", () => {
    instrumentSQLite(db);
    instrumentSQLite(db);

    db.run("INSERT INTO users (name, email) VALUES ('Test', 'test@test.com')");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
  });

  test("uninstrumentSQLite restores original methods", () => {
    instrumentSQLite(db);
    uninstrumentSQLite(db);

    db.run("INSERT INTO users (name, email) VALUES ('Test', 'test@test.com')");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
  });
});
