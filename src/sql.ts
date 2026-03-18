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
  ATTR_DB_QUERY_TEXT,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  DB_SYSTEM_NAME_VALUE_POSTGRESQL,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "otel-bun/sql";

/**
 * Extracts the SQL text from tagged template literal arguments.
 * Tagged templates are called with (strings[], ...values).
 */
function extractSQL(strings: TemplateStringsArray): string {
  // Reconstruct with $N placeholders
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    return acc + `$${i}` + str;
  }, "");
}

/**
 * Extracts the first SQL keyword as the operation name.
 */
function extractOperation(sql: string): string {
  const match = sql.trimStart().match(/^(\w+)/);
  return match ? match[1]!.toUpperCase() : "QUERY";
}

/**
 * Wraps a Promise-like query result to create a span that ends when
 * the query completes. Preserves chainable methods (.values(), .raw(), etc.).
 */
function wrapQueryResult(
  result: any,
  span: any,
): any {
  // The query result is a Promise with extra methods.
  // We need to intercept .then() to end the span, while preserving
  // chaining methods that return a new query object.
  const chainMethods = new Set(["values", "raw", "simple"]);

  return new Proxy(result, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (onFulfilled: any, onRejected: any) => {
          return target.then(
            (value: any) => {
              span.end();
              return onFulfilled?.(value);
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
              if (onRejected) return onRejected(error);
              throw error;
            },
          );
        };
      }

      // Chain methods return a modified query — pass through the same span
      if (chainMethods.has(prop as string)) {
        const method = Reflect.get(target, prop, receiver);
        if (typeof method === "function") {
          return (...args: any[]) => {
            const newResult = method.apply(target, args);
            return wrapQueryResult(newResult, span);
          };
        }
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Creates an instrumented proxy around a Bun SQL client instance.
 *
 * Intercepts:
 * - Tagged template calls: sql\`SELECT ...\` → creates a span per query
 * - .begin(callback) → creates a TRANSACTION span wrapping the callback
 * - .unsafe(sql, params) → creates a span for raw queries
 *
 * Returns a new proxied object — does not mutate the original.
 *
 * Usage:
 * ```ts
 * import { SQL } from "bun";
 * import { instrumentSQL } from "otel-bun";
 *
 * const sql = instrumentSQL(new SQL("postgres://localhost/mydb"));
 * const rows = await sql`SELECT * FROM users`;
 * ```
 */
export function instrumentSQL(
  client: any,
  options?: {
    serverAddress?: string;
    serverPort?: number;
    namespace?: string;
  },
): any {
  if (client.__otel_instrumented) return client;

  const baseAttributes: Record<string, string | number> = {
    [ATTR_DB_SYSTEM_NAME]: DB_SYSTEM_NAME_VALUE_POSTGRESQL,
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

  function createQuerySpan(sql: string) {
    const tracer = trace.getTracer(TRACER_NAME);
    const operation = extractOperation(sql);

    return tracer.startSpan(
      operation,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...baseAttributes,
          [ATTR_DB_OPERATION_NAME]: operation,
          [ATTR_DB_QUERY_TEXT]: sql,
        },
      },
      context.active(),
    );
  }

  function wrapTransactionClient(txClient: any): any {
    return new Proxy(txClient, {
      apply(_target, thisArg, args) {
        const strings = args[0] as TemplateStringsArray;
        const sql = extractSQL(strings);
        const span = createQuerySpan(sql);
        const result = Reflect.apply(txClient, thisArg, args);
        return wrapQueryResult(result, span);
      },
      get(target, prop, receiver) {
        if (prop === "unsafe") {
          return (sql: string, ...rest: any[]) => {
            const span = createQuerySpan(sql);
            const result = target.unsafe(sql, ...rest);
            return wrapQueryResult(result, span);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const proxy = new Proxy(client, {
    apply(_target, thisArg, args) {
      // Tagged template: sql`...`
      const strings = args[0] as TemplateStringsArray;
      const sql = extractSQL(strings);
      const span = createQuerySpan(sql);
      const result = Reflect.apply(client, thisArg, args);
      return wrapQueryResult(result, span);
    },
    get(target, prop, receiver) {
      if (prop === "__otel_instrumented") return true;

      if (prop === "begin") {
        return async (callback: (tx: any) => Promise<any>) => {
          const tracer = trace.getTracer(TRACER_NAME);
          const span = tracer.startSpan(
            "TRANSACTION",
            {
              kind: SpanKind.CLIENT,
              attributes: {
                ...baseAttributes,
                [ATTR_DB_OPERATION_NAME]: "TRANSACTION",
              },
            },
            context.active(),
          );

          try {
            const result = await target.begin((tx: any) => {
              return callback(wrapTransactionClient(tx));
            });
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
        };
      }

      if (prop === "unsafe") {
        return (sql: string, ...rest: any[]) => {
          const span = createQuerySpan(sql);
          const result = target.unsafe(sql, ...rest);
          return wrapQueryResult(result, span);
        };
      }

      if (prop === "reserve") {
        return async () => {
          const reserved = await target.reserve();
          const wrapped = instrumentSQL(reserved, options);
          // Preserve release method
          wrapped.release = reserved.release?.bind(reserved);
          return wrapped;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}
