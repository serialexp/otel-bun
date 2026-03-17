import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "otel-bun/fetch";

const originalFetch = globalThis.fetch;

/**
 * Replaces the global fetch() with an instrumented version that creates
 * OpenTelemetry client spans for each outgoing request.
 *
 * Injects trace context into outgoing headers (W3C traceparent by default)
 * for distributed tracing across services.
 */
export function instrumentFetch(): void {
  if ((globalThis.fetch as any).__otel_instrumented) return;

  const instrumented = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const tracer = trace.getTracer(TRACER_NAME);
    const activeCtx = context.active();

    // Parse URL without consuming the request body
    let url: URL;
    let method: string;
    if (input instanceof Request) {
      url = new URL(input.url);
      method = input.method;
    } else {
      url = new URL(input.toString());
      method = init?.method ?? "GET";
    }

    const spanName = `${method} ${url.hostname}`;

    const span = tracer.startSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: method,
          [ATTR_URL_FULL]: `${url.origin}${url.pathname}`,
          [ATTR_SERVER_ADDRESS]: url.hostname,
          [ATTR_SERVER_PORT]: Number.parseInt(url.port) || undefined,
        },
      },
      activeCtx,
    );

    const spanCtx = trace.setSpan(activeCtx, span);

    // Inject trace context into outgoing headers
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    propagation.inject(spanCtx, headers, {
      set(carrier, key, value) {
        carrier.set(key, value);
      },
    });

    try {
      const response = await context.with(spanCtx, () =>
        originalFetch(input, {
          ...init,
          headers,
        }),
      );

      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

      if (response.status >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.status}`,
        });
      }

      return response;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    } finally {
      span.end();
    }
  };

  (instrumented as any).__otel_instrumented = true;
  globalThis.fetch = instrumented as typeof fetch;
}

/**
 * Restores the original global fetch(), removing instrumentation.
 */
export function uninstrumentFetch(): void {
  globalThis.fetch = originalFetch;
}

/**
 * Returns the original, non-instrumented fetch function.
 * Useful for testing or when you need to make requests without tracing.
 */
export function getOriginalFetch(): typeof fetch {
  return originalFetch;
}
