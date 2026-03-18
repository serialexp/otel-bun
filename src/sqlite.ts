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
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "otel-bun/sqlite";

const STATEMENT_METHODS = ["all", "get", "run", "values"] as const;

/**
 * Wraps a bun:sqlite Statement to create spans for each query execution.
 * Safe to call on an already-wrapped statement (query() returns cached statements).
 */
function wrapStatement(
  statement: any,
  sql: string,
  dbNamespace: string | undefined,
): any {
  if (statement.__otel_wrapped) return statement;
  statement.__otel_wrapped = true;

  for (const method of STATEMENT_METHODS) {
    const original = statement[method];
    if (typeof original !== "function") continue;

    statement[method] = function (this: any, ...args: any[]) {
      const tracer = trace.getTracer(TRACER_NAME);
      const operationName = method.toUpperCase();

      const attributes: Record<string, string> = {
        [ATTR_DB_SYSTEM_NAME]: "sqlite",
        [ATTR_DB_OPERATION_NAME]: operationName,
        [ATTR_DB_QUERY_TEXT]: sql,
      };

      if (dbNamespace) {
        attributes[ATTR_DB_NAMESPACE] = dbNamespace;
      }

      const span = tracer.startSpan(
        operationName,
        {
          kind: SpanKind.CLIENT,
          attributes,
        },
        context.active(),
      );

      try {
        const result = original.apply(this, args);
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

  return statement;
}

type InstrumentedDatabase = {
  __otel_originals?: {
    query: Function;
    prepare: Function;
    run: Function;
    transaction: Function;
  };
};

/**
 * Instruments a bun:sqlite Database instance, wrapping query/prepare/run/transaction
 * to create OpenTelemetry CLIENT spans with DB semantic conventions.
 *
 * All operations are synchronous (SQLite in Bun is sync), so spans are
 * started and ended within the same call.
 */
export function instrumentSQLite(
  db: any,
  options?: {
    /** Database name/path for the db.namespace attribute */
    namespace?: string;
  },
): void {
  const instrumented = db as InstrumentedDatabase;
  if (instrumented.__otel_originals) return;

  const dbNamespace = options?.namespace;

  const originalQuery = db.query.bind(db);
  const originalPrepare = db.prepare.bind(db);
  const originalRun = db.run.bind(db);
  const originalTransaction = db.transaction.bind(db);

  instrumented.__otel_originals = {
    query: originalQuery,
    prepare: originalPrepare,
    run: originalRun,
    transaction: originalTransaction,
  };

  // Wrap query() — returns a cached Statement
  db.query = function (sql: string) {
    const statement = originalQuery(sql);
    return wrapStatement(statement, sql, dbNamespace);
  };

  // Wrap prepare() — returns a fresh Statement
  db.prepare = function (sql: string) {
    const statement = originalPrepare(sql);
    return wrapStatement(statement, sql, dbNamespace);
  };

  // Wrap run()/exec() — executes SQL directly
  db.run = function (sql: string, ...args: any[]) {
    const tracer = trace.getTracer(TRACER_NAME);

    const attributes: Record<string, string> = {
      [ATTR_DB_SYSTEM_NAME]: "sqlite",
      [ATTR_DB_OPERATION_NAME]: "RUN",
      [ATTR_DB_QUERY_TEXT]: sql,
    };

    if (dbNamespace) {
      attributes[ATTR_DB_NAMESPACE] = dbNamespace;
    }

    const span = tracer.startSpan(
      "RUN",
      {
        kind: SpanKind.CLIENT,
        attributes,
      },
      context.active(),
    );

    try {
      const result = originalRun(sql, ...args);
      span.end();
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.end();
      throw error;
    }
  };

  // exec is an alias for run
  db.exec = db.run;

  // Wrap transaction() — wraps the callback to create a span for the whole transaction
  db.transaction = function (fn: (...args: any[]) => any) {
    const wrappedFn = function (this: any, ...args: any[]) {
      const tracer = trace.getTracer(TRACER_NAME);

      const attributes: Record<string, string> = {
        [ATTR_DB_SYSTEM_NAME]: "sqlite",
        [ATTR_DB_OPERATION_NAME]: "TRANSACTION",
      };

      if (dbNamespace) {
        attributes[ATTR_DB_NAMESPACE] = dbNamespace;
      }

      const span = tracer.startSpan(
        "TRANSACTION",
        {
          kind: SpanKind.CLIENT,
          attributes,
        },
        context.active(),
      );

      try {
        const result = fn.apply(this, args);
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

    const txn = originalTransaction(wrappedFn);
    return txn;
  };
}

/**
 * Removes instrumentation from a Database, restoring original methods.
 */
export function uninstrumentSQLite(db: any): void {
  const instrumented = db as InstrumentedDatabase;
  const originals = instrumented.__otel_originals;
  if (!originals) return;

  db.query = originals.query;
  db.prepare = originals.prepare;
  db.run = originals.run;
  db.exec = originals.run;
  db.transaction = originals.transaction;

  delete instrumented.__otel_originals;
}
