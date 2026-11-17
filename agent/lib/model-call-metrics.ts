/** Per-call measurements only; no prompt, file, credential, or reasoning text is logged or retained. */
import { createHash, randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";

const SESSION_SAMPLES = 128;
const PREFIX_CHARACTERS = 128 * 1024;
const BLOCK_CHARACTERS = 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface Sample { system: string; tools: string; blocks: string[] }

export function createModelCallMetrics(options: {
  provider: string; modelId: string;
  protocol: "openai-chat-completions" | "anthropic-messages";
  log?: (record: Record<string, unknown>) => void;
  now?: () => number;
}): LanguageModelMiddleware {
  const previous = new Map<string, Sample>();
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((record) => console.info(JSON.stringify(record)));
  function wireMetadata(body: unknown): Record<string, unknown> {
    let parsed: unknown;
    // The installed adapter returns JSON text for generate, but the body object for stream.
    try { parsed = typeof body === "string" ? JSON.parse(body) : body; }
    catch { return { wireMetadataAvailable: false }; }
    if (!parsed || typeof parsed !== "object" || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
      return { wireMetadataAvailable: false };
    }
    const wire = parsed as { user?: unknown; system?: unknown; messages: { role?: unknown }[]; tools?: unknown };
    const messages = JSON.stringify(wire.messages);
    const system = JSON.stringify(options.protocol === "anthropic-messages"
      ? wire.system ?? [] : wire.messages.filter((message) => message?.role === "system"));
    const sample: Sample = { system: digest(system), tools: digest(JSON.stringify(wire.tools ?? [])), blocks: [] };
    for (let offset = 0; offset + BLOCK_CHARACTERS <= Math.min(messages.length, PREFIX_CHARACTERS); offset += BLOCK_CHARACTERS) {
      sample.blocks.push(digest(messages.slice(offset, offset + BLOCK_CHARACTERS)));
    }
    const session = typeof wire.user === "string" && wire.user.length ? digest(wire.user) : null;
    const prior = session === null ? undefined : previous.get(session);
    let matching = 0;
    if (prior) while (matching < sample.blocks.length && sample.blocks[matching] === prior.blocks[matching]) matching += 1;
    if (session !== null) {
      previous.delete(session); previous.set(session, sample);
      if (previous.size > SESSION_SAMPLES) previous.delete(previous.keys().next().value!);
    }
    return {
      wireMetadataAvailable: true, sessionKey: session, messageCharacters: messages.length,
      systemCharacters: system.length, toolCount: Array.isArray(wire.tools) ? wire.tools.length : 0,
      systemUnchanged: prior ? sample.system === prior.system : null,
      toolsUnchanged: prior ? sample.tools === prior.tools : null,
      sharedMessagePrefixCharactersLowerBound: prior ? matching * BLOCK_CHARACTERS : null,
      prefixObservationTruncated: messages.length > PREFIX_CHARACTERS,
    };
  }
  function usageFields(usage: LanguageModelV4Usage | undefined, reportedUsage: unknown, outputComplete = true) {
    // Adapters normalize missing counters to zero. Only raw presence proves a measured zero;
    // raw content is inspected here but never logged.
    const count = (...path: string[]): number | null => {
      let value: unknown = reportedUsage;
      for (const key of path) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        value = (value as Record<string, unknown>)[key];
      }
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    if (options.protocol === "openai-chat-completions") {
      const inputTokens = count("prompt_tokens"), outputTokens = count("completion_tokens");
      return {
        usageAvailable: inputTokens !== null && outputTokens !== null,
        inputTokens, outputTokens,
        cacheReadTokens: count("prompt_tokens_details", "cached_tokens"),
        cacheWriteTokens: null,
        reasoningTokens: count("completion_tokens_details", "reasoning_tokens"),
      };
    }
    const inputTokens = count("input_tokens") === null ? null : usage?.inputTokens.total ?? null;
    const outputTokens = !outputComplete || count("output_tokens") === null ? null : usage?.outputTokens.total ?? null;
    return {
      usageAvailable: inputTokens !== null && outputTokens !== null,
      inputTokens, outputTokens,
      cacheReadTokens: count("cache_read_input_tokens"),
      cacheWriteTokens: count("cache_creation_input_tokens"),
      reasoningTokens: count("output_tokens_details", "thinking_tokens"),
    };
  }
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate, params }) {
      const started = now(); const requestId = randomUUID();
      try {
        const result = await doGenerate();
        log({ code: "AGENT_MODEL_CALL_METRICS", requestId, provider: options.provider, modelId: options.modelId,
          durationMs: Math.round(now() - started), finishReason: result.finishReason.unified,
          ...wireMetadata(result.request?.body), ...usageFields(result.usage, result.usage.raw),
        });
        return result;
      } catch (error) {
        log({ code: "AGENT_MODEL_CALL_METRICS", requestId, provider: options.provider, modelId: options.modelId,
          durationMs: Math.round(now() - started), outcome: params.abortSignal?.aborted ? "cancelled" : "failed", usageAvailable: false });
        throw error;
      }
    },
    async wrapStream({ doStream, params }) {
      const started = now(); const requestId = randomUUID();
      let result: Awaited<ReturnType<typeof doStream>>;
      try { result = await doStream(); }
      catch (error) {
        log({ code: "AGENT_MODEL_CALL_METRICS", requestId, provider: options.provider, modelId: options.modelId,
          durationMs: Math.round(now() - started), outcome: params.abortSignal?.aborted ? "cancelled" : "failed", usageAvailable: false });
        throw error;
      }
      const headersMs = Math.round(now() - started);
      const metadata = wireMetadata(result.request?.body);
      const reader = result.stream.getReader();
      let firstDataMs: number | null = null;
      let recorded = false;
      let released = false;
      const release = () => { if (!released) { released = true; reader.releaseLock(); } };
      const record = (outcome: string, usage?: LanguageModelV4Usage, reportedUsage?: unknown) => {
        if (recorded) return; recorded = true;
        log({ code: "AGENT_MODEL_CALL_METRICS", requestId, provider: options.provider, modelId: options.modelId,
          durationMs: Math.round(now() - started), headersMs, firstDataMs, outcome, ...metadata, ...usageFields(usage, reportedUsage, outcome !== "other" && outcome !== "error") });
      };
      return { ...result, stream: new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { record("stream-ended-without-usage"); release(); controller.close(); return; }
            const part = next.value;
            if (["text-delta", "reasoning-delta", "tool-input-delta"].includes(part.type)) firstDataMs ??= Math.round(now() - started);
            if (part.type === "finish") record(part.finishReason.unified, part.usage, options.protocol === "anthropic-messages"
              ? part.providerMetadata?.anthropic?.usage : part.usage.raw);
            if (part.type === "error") record("failed");
            controller.enqueue(part);
          } catch (error) { record(params.abortSignal?.aborted ? "cancelled" : "failed"); release(); controller.error(error); }
        },
        async cancel(reason) { record("cancelled"); try { await reader.cancel(reason); } finally { release(); } },
      }) };
    },
  };
}
