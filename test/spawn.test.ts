import { describe, expect, test, afterEach, beforeAll, afterAll } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentSpawn, uninstrumentSpawn } from "../src/spawn.ts";

beforeAll(() => {
  instrumentSpawn();
});

afterAll(() => {
  uninstrumentSpawn();
});

afterEach(() => {
  exporter.reset();
});

describe("instrumentSpawn (async)", () => {
  test("creates a span for a successful process", async () => {
    const proc = Bun.spawn(["echo", "hello"]);
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.name).toBe("spawn echo");
    expect(span.attributes["process.command"]).toBe("echo");
    expect(span.attributes["process.command_args"]).toBe("hello");
    expect(span.attributes["process.pid"]).toBe(proc.pid);
    expect(span.attributes["process.exit.code"]).toBe(0);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("sets error status for non-zero exit code", async () => {
    const proc = Bun.spawn(["false"]);
    await proc.exited;

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.attributes["process.exit.code"]).toBe(1);
  });

  test("handles command with no arguments", async () => {
    const proc = Bun.spawn(["true"]);
    await proc.exited;

    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("spawn true");
    expect(spans[0]!.attributes["process.command_args"]).toBeUndefined();
  });

  test("calling instrumentSpawn twice is a no-op", () => {
    const before = Bun.spawn;
    instrumentSpawn();
    expect(Bun.spawn).toBe(before);
  });
});

describe("instrumentSpawn (sync)", () => {
  test("creates a span for spawnSync", () => {
    const result = Bun.spawnSync(["echo", "hello"]);
    expect(result.exitCode).toBe(0);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.name).toBe("spawn echo");
    expect(span.attributes["process.command"]).toBe("echo");
    expect(span.attributes["process.exit.code"]).toBe(0);
  });

  test("sets error status for failed spawnSync", () => {
    const result = Bun.spawnSync(["false"]);
    expect(result.exitCode).toBe(1);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });
});
