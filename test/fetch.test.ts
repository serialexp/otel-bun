import { describe, expect, test, afterEach, beforeAll } from "bun:test";
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentFetch } from "../src/fetch.ts";

// Instrument fetch after the provider is registered (setup.ts runs first)
beforeAll(() => {
  instrumentFetch();
});

afterEach(() => {
  exporter.reset();
});

describe("instrumentFetch", () => {
  test("creates a client span for outgoing requests", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });

    try {
      await fetch(`http://localhost:${server.port}/api/data`);
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.CLIENT)!;
      expect(span).toBeDefined();
      expect(span.name).toBe("GET localhost");
      expect(span.attributes["http.request.method"]).toBe("GET");
      expect(span.attributes["url.full"]).toBe(
        `http://localhost:${server.port}/api/data`,
      );
      expect(span.attributes["http.response.status_code"]).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("injects trace context into outgoing headers", async () => {
    let receivedTraceparent: string | null = null;

    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        receivedTraceparent = req.headers.get("traceparent");
        return new Response("ok");
      },
    });

    try {
      // Create a parent span so there's context to propagate
      const tracer = trace.getTracer("test");
      const parentSpan = tracer.startSpan("parent");
      const ctx = trace.setSpan(context.active(), parentSpan);

      await context.with(ctx, () =>
        fetch(`http://localhost:${server.port}/`),
      );
      await new Promise((r) => setTimeout(r, 50));

      parentSpan.end();

      expect(receivedTraceparent).toBeDefined();
      expect(receivedTraceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
      );

      // The traceparent should contain the parent's trace ID
      const traceId = parentSpan.spanContext().traceId;
      expect(receivedTraceparent).toContain(traceId);
    } finally {
      server.stop();
    }
  });

  test("sets error status for 5xx responses", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("error", { status: 500 }),
    });

    try {
      await fetch(`http://localhost:${server.port}/fail`);
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.CLIENT)!;
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      server.stop();
    }
  });

  test("records exception on network error", async () => {
    try {
      await fetch("http://localhost:1/unreachable");
    } catch {
      // Expected to throw
    }
    await new Promise((r) => setTimeout(r, 50));

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.kind === SpanKind.CLIENT)!;
    expect(span).toBeDefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.length).toBeGreaterThan(0);
    expect(span.events[0]!.name).toBe("exception");
  });

  test("handles POST requests", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("created", { status: 201 }),
    });

    try {
      await fetch(`http://localhost:${server.port}/items`, {
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      });
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.CLIENT)!;
      expect(span).toBeDefined();
      expect(span.attributes["http.request.method"]).toBe("POST");
      expect(span.attributes["http.response.status_code"]).toBe(201);
    } finally {
      server.stop();
    }
  });

  test("calling instrumentFetch twice is a no-op", () => {
    const before = globalThis.fetch;
    instrumentFetch();
    expect(globalThis.fetch).toBe(before);
  });
});
