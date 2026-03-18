import { describe, expect, test, afterEach } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentSQL } from "../src/sql.ts";

afterEach(() => {
  exporter.reset();
});

/**
 * Creates a mock that mimics Bun's SQL client behavior.
 * The client is a callable function (for tagged templates) with methods.
 */
function createMockSQLClient() {
  const mockResult = Object.assign(Promise.resolve([{ id: 1 }]), {
    values() {
      return Object.assign(Promise.resolve([[1]]), {
        then: (resolve: any, reject: any) =>
          Promise.resolve([[1]]).then(resolve, reject),
      });
    },
    raw() {
      return Object.assign(Promise.resolve([Buffer.from("1")]), {
        then: (resolve: any, reject: any) =>
          Promise.resolve([Buffer.from("1")]).then(resolve, reject),
      });
    },
    simple() {
      return mockResult;
    },
  });

  // The SQL client is callable (tagged template) and has methods
  const client = function (_strings: TemplateStringsArray, ..._values: any[]) {
    return mockResult;
  };

  client.unsafe = function (_sql: string, ..._params: any[]) {
    return mockResult;
  };

  client.begin = async function (callback: (tx: any) => Promise<any>) {
    // Transaction client is also callable
    const tx = function (
      _strings: TemplateStringsArray,
      ..._values: any[]
    ) {
      return mockResult;
    };
    tx.unsafe = client.unsafe;
    return callback(tx);
  };

  client.reserve = async function () {
    const reserved = function (
      _strings: TemplateStringsArray,
      ..._values: any[]
    ) {
      return mockResult;
    };
    reserved.unsafe = client.unsafe;
    reserved.release = () => {};
    return reserved;
  };

  return client;
}

describe("instrumentSQL", () => {
  test("creates a span for tagged template query", async () => {
    const client = createMockSQLClient();
    const sql = instrumentSQL(client, {
      serverAddress: "localhost",
      serverPort: 5432,
      namespace: "mydb",
    });

    const result = await sql`SELECT * FROM users WHERE id = ${1}`;
    expect(result).toEqual([{ id: 1 }]);

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.name).toBe("SELECT");
    expect(span.attributes["db.operation.name"]).toBe("SELECT");
    expect(span.attributes["db.system.name"]).toBe("postgresql");
    expect(span.attributes["db.query.text"]).toBe(
      "SELECT * FROM users WHERE id = $1",
    );
    expect(span.attributes["server.address"]).toBe("localhost");
    expect(span.attributes["server.port"]).toBe(5432);
    expect(span.attributes["db.namespace"]).toBe("mydb");
  });

  test("creates a span for unsafe query", async () => {
    const client = createMockSQLClient();
    const sql = instrumentSQL(client);

    await sql.unsafe("SELECT * FROM users WHERE id = $1", [1]);

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("SELECT");
    expect(spans[0]!.attributes["db.query.text"]).toBe(
      "SELECT * FROM users WHERE id = $1",
    );
  });

  test("creates a TRANSACTION span for begin()", async () => {
    const client = createMockSQLClient();
    const sql = instrumentSQL(client);

    await sql.begin(async (tx: any) => {
      await tx`INSERT INTO users (name) VALUES (${"Alice"})`;
    });

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    const txnSpan = spans.find(
      (s) => s.attributes["db.operation.name"] === "TRANSACTION",
    )!;
    expect(txnSpan).toBeDefined();
    expect(txnSpan.name).toBe("TRANSACTION");

    const insertSpan = spans.find(
      (s) => s.attributes["db.operation.name"] === "INSERT",
    )!;
    expect(insertSpan).toBeDefined();
  });

  test("extracts operation name from SQL", async () => {
    const client = createMockSQLClient();
    const sql = instrumentSQL(client);

    await sql`INSERT INTO users (name) VALUES (${"Bob"})`;

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.name).toBe("INSERT");
    expect(spans[0]!.attributes["db.operation.name"]).toBe("INSERT");
  });

  test("records error on query failure", async () => {
    const failingResult = Object.assign(
      Promise.reject(new Error("connection refused")),
      {
        values() {
          return this;
        },
        raw() {
          return this;
        },
        simple() {
          return this;
        },
      },
    );

    const client = function () {
      return failingResult;
    };
    client.unsafe = () => failingResult;
    client.begin = async () => {};
    client.reserve = async () => {};

    const sql = instrumentSQL(client);

    try {
      await sql`SELECT * FROM users`;
    } catch {
      // expected
    }

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.events[0]!.name).toBe("exception");
  });

  test("calling instrumentSQL twice returns same proxy", () => {
    const client = createMockSQLClient();
    const sql1 = instrumentSQL(client);
    const sql2 = instrumentSQL(sql1);
    expect(sql2).toBe(sql1);
  });

  test("reconstructs SQL with positional placeholders", async () => {
    const client = createMockSQLClient();
    const sql = instrumentSQL(client);

    await sql`UPDATE users SET name = ${"Alice"}, email = ${"a@b.com"} WHERE id = ${1}`;

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes["db.query.text"]).toBe(
      "UPDATE users SET name = $1, email = $2 WHERE id = $3",
    );
  });
});
