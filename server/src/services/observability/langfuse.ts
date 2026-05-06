import { trace as otelTrace, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const HOST = process.env.PAPERCLIP_LANGFUSE_HOST;
const PUBLIC_KEY = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY;
const DISABLED = process.env.PAPERCLIP_LANGFUSE_DISABLED === "1";

const enabled = !DISABLED && !!HOST && !!PUBLIC_KEY && !!SECRET_KEY;

let sdk: NodeSDK | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;
const TRACER_NAME = "paperclip-server";

if (enabled) {
  // Map PAPERCLIP_LANGFUSE_* env vars to native LANGFUSE_* expected by SDK
  process.env.LANGFUSE_HOST = HOST as string;
  process.env.LANGFUSE_PUBLIC_KEY = PUBLIC_KEY as string;
  process.env.LANGFUSE_SECRET_KEY = SECRET_KEY as string;

  spanProcessor = new LangfuseSpanProcessor();
  sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  try {
    sdk.start();
  } catch (err) {
    console.warn("[langfuse] failed to start OTel SDK:", err);
    sdk = null;
    spanProcessor = null;
  }
}

export interface RunTraceHandle {
  isNoop: boolean;
  end(opts?: {
    status?: "ok" | "error";
    output?: unknown;
    statusMessage?: string;
  }): void;
  event(name: string, attrs?: Record<string, unknown>): void;
}

const NOOP_HANDLE: RunTraceHandle = {
  isNoop: true,
  end: () => {},
  event: () => {},
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function startRunTrace(opts: {
  runId: string;
  name: string;
  userId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  input?: unknown;
}): RunTraceHandle {
  if (!enabled || !spanProcessor) return NOOP_HANDLE;

  const tracer = otelTrace.getTracer(TRACER_NAME);
  let span: Span;
  try {
    span = tracer.startSpan(opts.name, { kind: SpanKind.SERVER });
  } catch (err) {
    console.warn("[langfuse] startSpan failed:", err);
    return NOOP_HANDLE;
  }

  // Langfuse trace-id propagation: tag span with runId so downstream
  // generations (litellm-side) can be linked by trace-id (Phase 3b).
  span.setAttribute("langfuse.trace.id", opts.runId);
  span.setAttribute("langfuse.observation.type", "trace");
  if (opts.userId) span.setAttribute("user.id", opts.userId);
  if (opts.sessionId) span.setAttribute("session.id", opts.sessionId);
  if (opts.input !== undefined) {
    span.setAttribute("langfuse.observation.input", safeJson(opts.input));
  }
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) {
      if (v == null) continue;
      span.setAttribute(`langfuse.trace.metadata.${k}`, typeof v === "string" ? v : safeJson(v));
    }
  }

  return {
    isNoop: false,
    end: ({ status, output, statusMessage } = {}) => {
      try {
        if (output !== undefined) {
          span.setAttribute("langfuse.observation.output", safeJson(output));
        }
        if (statusMessage) {
          span.setAttribute("langfuse.observation.status_message", statusMessage);
        }
        if (status === "error") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      } catch (err) {
        console.warn("[langfuse] span end failed:", err);
      }
    },
    event: (name, attrs) => {
      try {
        span.addEvent(name, attrs as Record<string, string | number | boolean>);
      } catch (err) {
        // swallow — events are non-critical
        void err;
      }
    },
  };
}

export async function flushLangfuse(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (err) {
    console.warn("[langfuse] flush failed:", err);
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.warn("[langfuse] shutdown failed:", err);
  }
}

const PROJECT_ID = process.env.PAPERCLIP_LANGFUSE_PROJECT_ID ?? "paperclip";
const PUBLIC_URL = process.env.PAPERCLIP_LANGFUSE_PUBLIC_URL ?? HOST;

export function langfuseTraceUrl(runId: string): string | null {
  if (!enabled || !PUBLIC_URL) return null;
  return `${PUBLIC_URL.replace(/\/+$/, "")}/project/${PROJECT_ID}/traces/${encodeURIComponent(runId)}`;
}

export const langfuseEnabled = enabled;
