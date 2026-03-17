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
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_QUERY,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "otel-bun/serve";

/**
 * Getter for extracting trace context from incoming Request headers.
 */
const headerGetter = {
  get(carrier: Request, key: string): string | undefined {
    return carrier.headers.get(key) ?? undefined;
  },
  keys(carrier: Request): string[] {
    return [...carrier.headers.keys()];
  },
};

/**
 * Wraps a Bun.serve fetch handler to create OpenTelemetry server spans
 * for each incoming request.
 *
 * Extracts trace context from incoming headers (W3C traceparent by default),
 * creates a span with HTTP semantic convention attributes, and sets status
 * based on the response.
 */
export function instrumentServe(
  handler: (
    request: Request,
    server: any,
  ) => Response | Promise<Response>,
): (request: Request, server: any) => Promise<Response> {
  return async (request: Request, server: any): Promise<Response> => {
    const tracer = trace.getTracer(TRACER_NAME);
    const url = new URL(request.url);

    // Extract incoming trace context from request headers
    const extractedContext = propagation.extract(
      context.active(),
      request,
      headerGetter,
    );

    const spanName = `${request.method} ${url.pathname}`;

    return context.with(extractedContext, async () => {
      const span = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.SERVER,
          attributes: {
            [ATTR_HTTP_REQUEST_METHOD]: request.method,
            [ATTR_URL_PATH]: url.pathname,
            [ATTR_URL_SCHEME]: url.protocol.replace(":", ""),
            [ATTR_SERVER_ADDRESS]: url.hostname,
            [ATTR_SERVER_PORT]: Number.parseInt(url.port) || undefined,
            ...(url.search ? { [ATTR_URL_QUERY]: url.search.slice(1) } : {}),
          },
        },
        context.active(),
      );

      try {
        const response = await context.with(
          trace.setSpan(context.active(), span),
          () => handler(request, server),
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
          message:
            error instanceof Error ? error.message : String(error),
        });
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Set the http.route attribute on the current active span.
 * Call this from within a route handler when you know the matched route pattern.
 *
 * Example: setHttpRoute("/api/stacks/:stackName")
 */
export function setHttpRoute(route: string): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(ATTR_HTTP_ROUTE, route);
    // Update span name to use route pattern instead of raw path
    span.updateName(
      `${span.attributes?.[ATTR_HTTP_REQUEST_METHOD] ?? "HTTP"} ${route}`,
    );
  }
}
