import { describe, expect, test, afterEach } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentRedis, uninstrumentRedis } from "../src/redis.ts";

/**
 * Minimal mock that mimics Bun's RedisClient method signatures.
 * All commands return promises, matching the real API.
 */
function createMockRedisClient() {
  return {
    get: async (_key: string) => "value",
    set: async (_key: string, _value: string) => undefined,
    del: async (_key: string) => undefined,
    exists: async (_key: string) => true,
    expire: async (_key: string, _seconds: number) => undefined,
    ttl: async (_key: string) => 300,
    incr: async (_key: string) => 1,
    decr: async (_key: string) => 0,
    hmset: async (_key: string, _fields: string[]) => undefined,
    hmget: async (_key: string, _fields: string[]) =>
      ["a", "b"] as (string | null)[],
    hget: async (_key: string, _field: string) => "val",
    hincrby: async (_key: string, _field: string, _amount: number) => 5,
    hincrbyfloat: async (_key: string, _field: string, _amount: number) => 5.5,
    sadd: async (_key: string, _member: string) => undefined,
    srem: async (_key: string, _member: string) => undefined,
    sismember: async (_key: string, _member: string) => true,
    smembers: async (_key: string) => ["a", "b"],
    srandmember: async (_key: string) => "a",
    spop: async (_key: string) => "a",
    publish: async (_channel: string, _message: string) => undefined,
    subscribe: async (
      _channel: string,
      _callback: (message: string, channel: string) => void,
    ) => undefined,
    unsubscribe: async () => undefined,
    send: async (_command: string, _args: string[]) => "OK",
  };
}

afterEach(() => {
  exporter.reset();
});

describe("instrumentRedis", () => {
  test("creates a CLIENT span for GET command", async () => {
    const client = createMockRedisClient();
    instrumentRedis(client, {
      serverAddress: "localhost",
      serverPort: 6379,
    });

    const result = await client.get("mykey");
    expect(result).toBe("value");

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.name).toBe("GET");
    expect(span.attributes["db.operation.name"]).toBe("GET");
    expect(span.attributes["db.system.name"]).toBe("redis");
    expect(span.attributes["server.address"]).toBe("localhost");
    expect(span.attributes["server.port"]).toBe(6379);
  });

  test("creates spans for SET command", async () => {
    const client = createMockRedisClient();
    instrumentRedis(client);

    await client.set("key", "val");

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("SET");
    expect(spans[0]!.attributes["db.operation.name"]).toBe("SET");
  });

  test("includes namespace when provided", async () => {
    const client = createMockRedisClient();
    instrumentRedis(client, { namespace: "0" });

    await client.get("key");

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes["db.namespace"]).toBe("0");
  });

  test("records error status on command failure", async () => {
    const client = createMockRedisClient();
    client.get = async () => {
      throw new Error("connection refused");
    };
    instrumentRedis(client);

    try {
      await client.get("key");
    } catch {
      // expected
    }

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.events[0]!.name).toBe("exception");
  });

  test("instruments all command types", async () => {
    const client = createMockRedisClient();
    instrumentRedis(client);

    await client.incr("counter");
    await client.hmset("hash", ["f1", "v1"]);
    await client.sadd("set", "member");
    await client.send("PING", []);

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toEqual(["INCR", "HMSET", "SADD", "SEND"]);
  });

  test("calling instrumentRedis twice is a no-op", async () => {
    const client = createMockRedisClient();
    instrumentRedis(client);
    instrumentRedis(client);

    await client.get("key");

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    // Should only create 1 span, not 2 (no double-wrapping)
    expect(spans).toHaveLength(1);
  });

  test("uninstrumentRedis restores original methods", async () => {
    const client = createMockRedisClient();
    const originalGet = client.get;

    instrumentRedis(client);
    expect(client.get).not.toBe(originalGet);

    uninstrumentRedis(client);
    expect(client.get).toBe(originalGet);

    await client.get("key");

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
  });
});
