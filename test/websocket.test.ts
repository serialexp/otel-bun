import { describe, expect, test, afterEach } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { exporter } from "./setup.ts";
import { instrumentWebSocket } from "../src/websocket.ts";

afterEach(() => {
  exporter.reset();
});

describe("instrumentWebSocket", () => {
  test("creates spans for open, message, and close", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        server.upgrade(req);
        return new Response(null, { status: 101 });
      },
      websocket: instrumentWebSocket({
        open() {},
        message(ws, msg) {
          ws.send("echo: " + msg);
        },
        close() {},
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send("hello");
        };
        ws.onmessage = () => {
          ws.close();
        };
        ws.onclose = () => resolve();
      });

      await new Promise((r) => setTimeout(r, 100));

      const spans = exporter.getFinishedSpans();
      const events = spans.map((s) => s.attributes["websocket.event"]);

      expect(events).toContain("open");
      expect(events).toContain("message");
      expect(events).toContain("close");
    } finally {
      server.stop();
    }
  });

  test("records message size and type for text messages", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        server.upgrade(req);
        return new Response(null, { status: 101 });
      },
      websocket: instrumentWebSocket({
        message(ws) {
          ws.close();
        },
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => ws.send("test data");
        ws.onclose = () => resolve();
      });

      await new Promise((r) => setTimeout(r, 100));

      const spans = exporter.getFinishedSpans();
      const msgSpan = spans.find(
        (s) => s.attributes["websocket.event"] === "message",
      )!;

      expect(msgSpan).toBeDefined();
      expect(msgSpan.kind).toBe(SpanKind.SERVER);
      expect(msgSpan.attributes["websocket.message.size"]).toBe(9); // "test data"
      expect(msgSpan.attributes["websocket.message.type"]).toBe("text");
    } finally {
      server.stop();
    }
  });

  test("records close code", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        server.upgrade(req);
        return new Response(null, { status: 101 });
      },
      websocket: instrumentWebSocket({
        message() {},
        close() {},
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => ws.close(1000, "done");
        ws.onclose = () => resolve();
      });

      await new Promise((r) => setTimeout(r, 100));

      const spans = exporter.getFinishedSpans();
      const closeSpan = spans.find(
        (s) => s.attributes["websocket.event"] === "close",
      )!;

      expect(closeSpan).toBeDefined();
      expect(closeSpan.attributes["websocket.close.code"]).toBe(1000);
    } finally {
      server.stop();
    }
  });

  test("works without optional handlers", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        server.upgrade(req);
        return new Response(null, { status: 101 });
      },
      websocket: instrumentWebSocket({
        message(ws) {
          ws.close();
        },
        // No open, close, or error handlers
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => ws.send("hi");
        ws.onclose = () => resolve();
      });

      await new Promise((r) => setTimeout(r, 100));

      const spans = exporter.getFinishedSpans();
      // Should still get spans for open, message, and close
      expect(spans.length).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop();
    }
  });

  test("preserves extra config like maxPayloadLength", () => {
    const wrapped = instrumentWebSocket({
      message() {},
      maxPayloadLength: 1024,
      idleTimeout: 30,
    } as any);

    expect((wrapped as any).maxPayloadLength).toBe(1024);
    expect((wrapped as any).idleTimeout).toBe(30);
  });
});
