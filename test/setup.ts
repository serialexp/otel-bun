import { trace, context, propagation } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

export const exporter = new InMemorySpanExporter();

// Bun requires explicit context manager registration
context.setGlobalContextManager(new AsyncLocalStorageContextManager());

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
