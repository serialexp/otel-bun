import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "otel-bun/redis";

/**
 * All Redis commands we instrument. Each maps to an async method on RedisClient.
 */
const REDIS_COMMANDS = [
  // String
  "set",
  "get",
  "getBuffer",
  "del",
  "exists",
  "expire",
  "ttl",
  // Numeric
  "incr",
  "decr",
  // Hash
  "hmset",
  "hmget",
  "hget",
  "hincrby",
  "hincrbyfloat",
  // Set
  "sadd",
  "srem",
  "sismember",
  "smembers",
  "srandmember",
  "spop",
  // Pub/Sub
  "publish",
  "subscribe",
  "unsubscribe",
  // Raw
  "send",
] as const;

type InstrumentedClient = {
  __otel_originals?: Map<string, Function>;
};

/**
 * Instruments a Bun RedisClient instance, wrapping all command methods
 * to create OpenTelemetry CLIENT spans with DB semantic conventions.
 *
 * Pass connection info to enrich spans with server address/port/namespace.
 */
export function instrumentRedis(
  client: any,
  options?: {
    serverAddress?: string;
    serverPort?: number;
    namespace?: string;
  },
): void {
  const instrumented = client as InstrumentedClient;
  if (instrumented.__otel_originals) return;

  const originals = new Map<string, Function>();
  instrumented.__otel_originals = originals;

  const baseAttributes: Record<string, string | number> = {
    [ATTR_DB_SYSTEM_NAME]: "redis",
  };

  if (options?.serverAddress) {
    baseAttributes[ATTR_SERVER_ADDRESS] = options.serverAddress;
  }
  if (options?.serverPort) {
    baseAttributes[ATTR_SERVER_PORT] = options.serverPort;
  }
  if (options?.namespace) {
    baseAttributes[ATTR_DB_NAMESPACE] = options.namespace;
  }

  for (const command of REDIS_COMMANDS) {
    const original = client[command];
    if (typeof original !== "function") continue;

    originals.set(command, original);

    client[command] = function (this: any, ...args: any[]) {
      const tracer = trace.getTracer(TRACER_NAME);
      const upperCommand = command.toUpperCase();

      const span = tracer.startSpan(
        upperCommand,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            ...baseAttributes,
            [ATTR_DB_OPERATION_NAME]: upperCommand,
          },
        },
        context.active(),
      );

      const spanCtx = trace.setSpan(context.active(), span);

      return context.with(spanCtx, () => {
        try {
          const result = original.apply(this, args);

          // All Redis commands return promises
          if (result && typeof result.then === "function") {
            return result.then(
              (value: any) => {
                span.end();
                return value;
              },
              (error: any) => {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                span.recordException(
                  error instanceof Error ? error : new Error(String(error)),
                );
                span.end();
                throw error;
              },
            );
          }

          // Shouldn't happen for Redis, but handle sync returns
          span.end();
          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              error instanceof Error ? error.message : String(error),
          });
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
          span.end();
          throw error;
        }
      });
    };
  }
}

/**
 * Removes instrumentation from a RedisClient, restoring original methods.
 */
export function uninstrumentRedis(client: any): void {
  const instrumented = client as InstrumentedClient;
  const originals = instrumented.__otel_originals;
  if (!originals) return;

  for (const [command, original] of originals) {
    client[command] = original;
  }

  delete instrumented.__otel_originals;
}
