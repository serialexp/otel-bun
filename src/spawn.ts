import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

const TRACER_NAME = "otel-bun/spawn";

// Process semantic convention attributes (experimental, using string literals)
const ATTR_PROCESS_COMMAND = "process.command";
const ATTR_PROCESS_COMMAND_ARGS = "process.command_args";
const ATTR_PROCESS_EXIT_CODE = "process.exit.code";
const ATTR_PROCESS_PID = "process.pid";

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

function extractCommand(args: any[]): { cmd: string[]; options: any } {
  if (Array.isArray(args[0])) {
    return { cmd: args[0], options: args[1] ?? {} };
  }
  // Options object form: { cmd: [...], ...options }
  const { cmd, ...options } = args[0];
  return { cmd, options };
}

/**
 * Instruments Bun.spawn and Bun.spawnSync to create spans tracking
 * child process lifecycle.
 *
 * For spawn() (async): span starts at spawn and ends when the process exits.
 * For spawnSync(): span covers the entire synchronous execution.
 */
export function instrumentSpawn(): void {
  if ((Bun.spawn as any).__otel_instrumented) return;

  const instrumentedSpawn = function (...args: any[]) {
    const tracer = trace.getTracer(TRACER_NAME);
    const { cmd } = extractCommand(args);
    const command = cmd[0] ?? "unknown";

    const span = tracer.startSpan(
      `spawn ${command}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_PROCESS_COMMAND]: command,
          ...(cmd.length > 1
            ? { [ATTR_PROCESS_COMMAND_ARGS]: cmd.slice(1).join(" ") }
            : {}),
        },
      },
      context.active(),
    );

    try {
      const subprocess = originalSpawn.apply(Bun, args as any);

      span.setAttribute(ATTR_PROCESS_PID, subprocess.pid);

      // End the span when the process exits
      subprocess.exited.then(
        (exitCode: number) => {
          span.setAttribute(ATTR_PROCESS_EXIT_CODE, exitCode);
          if (exitCode !== 0) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Process exited with code ${exitCode}`,
            });
          }
          span.end();
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
        },
      );

      return subprocess;
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

  (instrumentedSpawn as any).__otel_instrumented = true;
  Bun.spawn = instrumentedSpawn as typeof Bun.spawn;

  const instrumentedSpawnSync = function (...args: any[]) {
    const tracer = trace.getTracer(TRACER_NAME);
    const { cmd } = extractCommand(args);
    const command = cmd[0] ?? "unknown";

    const span = tracer.startSpan(
      `spawn ${command}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_PROCESS_COMMAND]: command,
          ...(cmd.length > 1
            ? { [ATTR_PROCESS_COMMAND_ARGS]: cmd.slice(1).join(" ") }
            : {}),
        },
      },
      context.active(),
    );

    try {
      const result = originalSpawnSync.apply(Bun, args as any);

      span.setAttribute(ATTR_PROCESS_PID, result.pid);
      span.setAttribute(ATTR_PROCESS_EXIT_CODE, result.exitCode);

      if (result.exitCode !== 0) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `Process exited with code ${result.exitCode}`,
        });
      }

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

  Bun.spawnSync = instrumentedSpawnSync as typeof Bun.spawnSync;
}

/**
 * Restores the original Bun.spawn and Bun.spawnSync.
 */
export function uninstrumentSpawn(): void {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
}
