/**
 * Maintained NeuralDeep model metadata required by the installer.
 *
 * Exports:
 * - `selectSupportedNeuralDeepModels`: intersects live model IDs with audited runtime metadata.
 *
 * Key constructs:
 * - The allowlist contains only models whose context, tools, vision, and request limit are verified.
 * - Live `/models` availability remains mandatory, so stale configured entries are never offered.
 */
import type { ProviderCatalogModel, ProviderProtocol } from "./provider-catalog-types.js";

interface LiveNeuralDeepModel {
  readonly id: string;
  readonly protocol: ProviderProtocol;
}

const QWEN_3_8_CONTEXT_TOKENS = 262_144;
const QWEN_3_8_REQUEST_OUTPUT_TOKENS = 16_384;

// NeuralDeep documents this model as 256k, multimodal, tool-capable, and reasoning-enabled.
// The request output cap matches NeuralDeep's published Qwen coding-agent configuration.
const SUPPORTED_MODELS: Readonly<Record<string, ProviderCatalogModel>> = {
  "qwen3.8-27b": {
    contextWindowTokens: QWEN_3_8_CONTEXT_TOKENS,
    defaultReasoningOption: null,
    displayName: "Qwen 3.8 27B",
    id: "qwen3.8-27b",
    maxOutputTokens: QWEN_3_8_REQUEST_OUTPUT_TOKENS,
    protocol: "openai-chat-completions",
    reasoningOptions: [],
    supportsImageInput: true,
    supportsTools: true,
  },
};

export function selectSupportedNeuralDeepModels(
  liveModels: readonly LiveNeuralDeepModel[],
): ProviderCatalogModel[] {
  return liveModels.flatMap(({ id, protocol }) => {
    const model = SUPPORTED_MODELS[id];
    if (!model || model.protocol !== protocol) return [];
    return [{ ...model, reasoningOptions: [...model.reasoningOptions] }];
  });
}
