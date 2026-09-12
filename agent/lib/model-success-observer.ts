/** Provider-level success observation. A lost health observation never invalidates a received answer. */
import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type { SuccessfulModelCall } from "./model-availability-repository.js";

export function modelSuccessObserver(
  routeKey: string,
  onSuccess: (event: SuccessfulModelCall) => Promise<void> | void,
): LanguageModelMiddleware {
  async function publish(): Promise<void> {
    const event = { observedAt: new Date(), requestId: randomUUID(), routeKey };
    try {
      await onSuccess(event);
    } catch (error) {
      // Explicit recovery: keep the actual model result and wait for a later success observation.
      console.error(JSON.stringify({ code: "AGENT_MODEL_SUCCESS_RECORD_FAILED", routeKey,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error) }));
    }
  }
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      if (["stop", "tool-calls"].includes(result.finishReason.unified) && result.content.some(part =>
        part.type === "tool-call" || part.type === "text" && part.text.trim().length > 0)) await publish();
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      let content = false;
      let complete = false;
      let failed = false;
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === "text-delta" && part.delta.trim().length > 0 || part.type === "tool-call") content = true;
          if (part.type === "finish") complete = ["stop", "tool-calls"].includes(part.finishReason.unified);
          if (part.type === "error") failed = true;
          controller.enqueue(part);
        },
        async flush() { if (content && complete && !failed) await publish(); },
      })) };
    },
  };
}
