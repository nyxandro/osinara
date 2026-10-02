/**
 * Prompt-cache breakpoints for providers on the Anthropic protocol.
 *
 * Exports:
 * - `usesAnthropicPromptCache`: whether the model is served over the Anthropic protocol.
 * - `markPromptCache`: marks the system prompt, the last tool and the conversation tail, so the
 *   provider reuses the cached prefix across steps instead of reading the whole prompt again.
 *
 * Derived from eve 0.40.0 `harness/prompt-cache.ts` and its use in `harness/tool-loop.ts` and
 * `harness/step-hooks.ts` (Apache-2.0, see NOTICE-eve). Changes: no AI Gateway branch (Osinara
 * calls providers directly); the three marks are applied in one place, on the request as sent.
 */
import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet } from "ai";

const CACHE_MARKER = Object.freeze({
  anthropic: Object.freeze({ cacheControl: Object.freeze({ type: "ephemeral" as const }) }),
  bedrock: Object.freeze({ cachePoint: Object.freeze({ type: "default" as const }) }),
});

export function usesAnthropicPromptCache(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  const provider = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
  if (provider.includes("anthropic")) return true;
  // Bedrock's Converse provider carries the Anthropic identity in the model id.
  const modelId = typeof model.modelId === "string" ? model.modelId.toLowerCase() : "";
  return provider.includes("bedrock") && modelId.includes("anthropic");
}

function markTools(tools: ToolSet): ToolSet {
  const entries = Object.entries(tools);
  if (entries.length === 0) return tools;
  const [lastName, lastTool] = entries.at(-1)!;
  return {
    ...tools,
    [lastName]: { ...lastTool, providerOptions: { ...lastTool.providerOptions, ...CACHE_MARKER } },
  } as ToolSet;
}

// The last message and the last assistant message before it: the cached prefix grows by one step.
function markConversation(messages: readonly ModelMessage[]): ModelMessage[] {
  const out = [...messages];
  const mark = (index: number) => {
    const message = out[index]!;
    out[index] = { ...message, providerOptions: { ...message.providerOptions, ...CACHE_MARKER } } as ModelMessage;
  };
  if (out.length === 0) return out;
  mark(out.length - 1);
  for (let index = out.length - 2; index >= 0; index -= 1) {
    if (out[index]?.role === "assistant") {
      mark(index);
      break;
    }
  }
  return out;
}

export function markPromptCache(input: {
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly tools: ToolSet;
}): { readonly messages: ModelMessage[]; readonly system: SystemModelMessage; readonly tools: ToolSet } {
  return {
    messages: markConversation(input.messages),
    system: { content: input.system, providerOptions: { ...CACHE_MARKER }, role: "system" },
    tools: markTools(input.tools),
  };
}
