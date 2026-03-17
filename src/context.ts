import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

/**
 * Registers the AsyncLocalStorageContextManager with the OpenTelemetry API.
 *
 * This is REQUIRED for Bun. Without it, context.with() is a no-op and
 * trace context won't propagate across async boundaries — meaning parent/child
 * span relationships, context extraction from incoming requests, and context
 * injection into outgoing requests will all silently fail.
 *
 * The standard @opentelemetry/sdk-node registers this automatically, but only
 * for Node.js. When using Bun, you must call this (or register the context
 * manager yourself) before any tracing will work correctly.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function ensureContextManager(): void {
  // context.setGlobalContextManager is idempotent in the OTel API —
  // it returns false if already set, so this is safe to call multiple times
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
}
