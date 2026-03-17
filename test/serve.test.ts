import { describe, expect, test, afterEach } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentServe, setHttpRoute } from "../src/serve.ts";
import { getOriginalFetch } from "../src/fetch.ts";

afterEach(() => {
  exporter.reset();
});

describe("instrumentServe", () => {
  test("creates a server span for each request", async () => {
    const handler = instrumentServe(() => new Response("ok"));

    const server = Bun.serve({ port: 0, fetch: handler });

    try {
      await fetch(`http://localhost:${server.port}/test?q=1`);
      // Give the span processor time to flush
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      // Find the server span (filter out any fetch client spans)
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.name).toBe("GET /test");
      expect(span.attributes["http.request.method"]).toBe("GET");
      expect(span.attributes["url.path"]).toBe("/test");
      expect(span.attributes["url.query"]).toBe("q=1");
      expect(span.attributes["http.response.status_code"]).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("sets error status for 5xx responses", async () => {
    const handler = instrumentServe(
      () => new Response("error", { status: 503 }),
    );

    const server = Bun.serve({ port: 0, fetch: handler });

    try {
      await fetch(`http://localhost:${server.port}/fail`);
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["http.response.status_code"]).toBe(503);
    } finally {
      server.stop();
    }
  });

  test("does not set error status for 4xx responses", async () => {
    const handler = instrumentServe(
      () => new Response("not found", { status: 404 }),
    );

    const server = Bun.serve({ port: 0, fetch: handler });

    try {
      await fetch(`http://localhost:${server.port}/missing`);
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes["http.response.status_code"]).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("records exception when handler throws", async () => {
    const handler = instrumentServe(() => {
      throw new Error("boom");
    });

    // Bun.serve has its own error handler; we need to verify the span was created
    // even though Bun intercepts the error
    const server = Bun.serve({
      port: 0,
      fetch: handler,
      error() {
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    try {
      await fetch(`http://localhost:${server.port}/throw`);
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.length).toBeGreaterThan(0);
      expect(span.events[0]!.name).toBe("exception");
    } finally {
      server.stop();
    }
  });

  test("extracts trace context from incoming headers", async () => {
    const handler = instrumentServe(() => new Response("ok"));

    const server = Bun.serve({ port: 0, fetch: handler });

    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const parentSpanId = "b7ad6b7169203331";

    try {
      // Use the original fetch to avoid instrumented fetch overriding traceparent
      const rawFetch = getOriginalFetch();
      await rawFetch(`http://localhost:${server.port}/ctx`, {
        headers: {
          traceparent: `00-${traceId}-${parentSpanId}-01`,
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.spanContext().traceId).toBe(traceId);
      expect((span as any).parentSpanContext?.spanId).toBe(parentSpanId);
    } finally {
      server.stop();
    }
  });

  test("setHttpRoute updates span attribute", async () => {
    const handler = instrumentServe((_req) => {
      setHttpRoute("/api/stacks/:name");
      return new Response("ok");
    });

    const server = Bun.serve({ port: 0, fetch: handler });

    try {
      await fetch(
        `http://localhost:${server.port}/api/stacks/my-stack`,
      );
      await new Promise((r) => setTimeout(r, 50));

      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.kind === SpanKind.SERVER)!;
      expect(span).toBeDefined();
      expect(span.attributes["http.route"]).toBe("/api/stacks/:name");
    } finally {
      server.stop();
    }
  });
});
