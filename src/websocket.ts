import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

const TRACER_NAME = "otel-bun/websocket";

/**
 * Wraps a Bun.serve websocket handler configuration to create OpenTelemetry
 * spans for WebSocket lifecycle events.
 *
 * Creates spans for:
 * - `open` — when a client connects
 * - `message` — for each message received
 * - `close` — when a client disconnects
 * - `error` — records exceptions on the active span
 *
 * Usage:
 * ```ts
 * Bun.serve({
 *   fetch(req, server) {
 *     server.upgrade(req);
 *     return undefined;
 *   },
 *   websocket: instrumentWebSocket({
 *     message(ws, msg) { ws.send("echo: " + msg); },
 *   }),
 * });
 * ```
 */
export function instrumentWebSocket<T>(
  handlers: WebSocketHandlers<T>,
): WebSocketHandlers<T> {
  const { open, message, close, error, drain, ...rest } = handlers;

  return {
    ...rest,

    open(ws) {
      const tracer = trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan(
        "websocket open",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "websocket.event": "open",
            ...(ws.remoteAddress
              ? { "network.peer.address": ws.remoteAddress }
              : {}),
          },
        },
        context.active(),
      );

      try {
        open?.call(handlers, ws);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }
    },

    message(ws, msg) {
      const tracer = trace.getTracer(TRACER_NAME);

      const msgSize =
        typeof msg === "string" ? msg.length : (msg as ArrayBuffer).byteLength;

      const span = tracer.startSpan(
        "websocket message",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "websocket.event": "message",
            "websocket.message.size": msgSize,
            "websocket.message.type":
              typeof msg === "string" ? "text" : "binary",
          },
        },
        context.active(),
      );

      try {
        message.call(handlers, ws, msg);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }
    },

    close(ws, code, reason) {
      const tracer = trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan(
        "websocket close",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "websocket.event": "close",
            "websocket.close.code": code,
            ...(reason ? { "websocket.close.reason": reason } : {}),
          },
        },
        context.active(),
      );

      try {
        close?.call(handlers, ws, code, reason);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }
    },

    error(ws, err) {
      const tracer = trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan(
        "websocket error",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "websocket.event": "error",
          },
        },
        context.active(),
      );

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });
      span.recordException(err);

      try {
        error?.call(handlers, ws, err);
      } finally {
        span.end();
      }
    },

    ...(drain ? { drain } : {}),
  } as WebSocketHandlers<T>;
}

/**
 * Mirrors the shape of Bun's websocket handler config.
 * Using `any` for ServerWebSocket to avoid depending on bun types at runtime.
 */
type WebSocketHandlers<T> = {
  message: (ws: any, message: string | ArrayBuffer | Uint8Array) => void;
  open?: (ws: any) => void;
  close?: (ws: any, code: number, reason: string) => void;
  error?: (ws: any, error: Error) => void;
  drain?: (ws: any) => void;
  [key: string]: any;
};
