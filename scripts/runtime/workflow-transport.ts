/** Installed by the version-pinned Workflow patch; no application data or auth enters this layer. */
import { createHash } from "node:crypto";
import { Agent, fetch } from "undici";
import { WorkflowInvokePayloadSchema, type Queue } from "@workflow/world";

// Longer than the runner's 30-minute command window, without changing external model timeouts.
// A transport deadline never proves the server-side executor died; the fence below remains required.
export const WORKFLOW_HTTP_TIMEOUT_MS = 35 * 60 * 1000;
type Handler = Parameters<Queue["createQueueHandler"]>[1];
type Result = Awaited<ReturnType<Handler>>;

export function createWorkflowHttpClient() {
  const dispatcher = new Agent({ headersTimeout: WORKFLOW_HTTP_TIMEOUT_MS, bodyTimeout: WORKFLOW_HTTP_TIMEOUT_MS });
  return {
    async fetch(url: string, options: Parameters<typeof fetch>[1]) {
      try {
        return await fetch(url, { ...options, dispatcher });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        console.error(JSON.stringify({ code: "AGENT_WORKFLOW_TRANSPORT_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          causeCode: cause && typeof cause === "object" && "code" in cause ? cause.code : null,
        }));
        throw error;
      }
    },
    close: () => dispatcher.close(),
  };
}

export function createWorkflowExecutionFence(isClosing: () => boolean = () => false): (handler: Handler) => Handler {
  const deliveries = new Map<string, { digest: string; execution: Promise<Result> }>();
  const runTails = new Map<string, Promise<Result>>();
  return (handler) => async (message, meta) => {
    const deliveryKey = `${meta.queueName}:${meta.messageId}`;
    const bytes = JSON.stringify(message);
    if (bytes === undefined) throw new Error("AGENT_WORKFLOW_PAYLOAD_INVALID: Queue delivery has no serialized input");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = deliveries.get(deliveryKey);
    if (existing) {
      if (existing.digest !== digest) throw new Error("AGENT_WORKFLOW_DELIVERY_CONFLICT: Live delivery ID has different input bytes");
      console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_EXECUTION_JOINED", messageId: meta.messageId, attempt: meta.attempt }));
      return existing.execution;
    }
    const invocation = WorkflowInvokePayloadSchema.safeParse(message);
    const runKey = invocation.success && invocation.data.stepId
      ? JSON.stringify([invocation.data.runId, invocation.data.stepId])
      : deliveryKey;
    const previous = runTails.get(runKey);
    const execute = () => {
      if (isClosing()) throw new Error("AGENT_WORKFLOW_SHUTTING_DOWN: Delivery did not start before shutdown");
      return handler(message, meta);
    };
    // A workflow replay must receive cancellation while an inline step is still running.
    // Only explicit step deliveries serialize; Workflow retains its atomic inline-step ownership.
    const execution = previous ? previous.then(execute, execute) : Promise.resolve().then(execute);
    const entry = { digest, execution };
    deliveries.set(deliveryKey, entry);
    runTails.set(runKey, execution);
    try {
      return await execution;
    } finally {
      if (deliveries.get(deliveryKey) === entry) deliveries.delete(deliveryKey);
      if (runTails.get(runKey) === execution) runTails.delete(runKey);
    }
  };
}
