/**
 * Installer model-provider config builder tests.
 *
 * Constructs covered:
 * - `buildModelProviderConfig`: maps installer-ready catalog metadata to exact schema v4.
 * - Provider-specific endpoint, protocol, authentication, compatibility, and reasoning contracts.
 * - Canonical reasoning membership and fail-fast model capability validation.
 */
import { describe, expect, it } from "vitest";

import { parseModelProviderConfig } from "../model-provider-config-schema.js";
import { buildModelProviderConfig } from "./model-provider-config-builder.js";
import type {
  ProviderCatalogModel,
  ProviderId,
  ReasoningSelection,
} from "./provider-catalog.js";

function catalogModel(
  overrides: Partial<ProviderCatalogModel> = {},
): ProviderCatalogModel {
  return {
    contextWindowTokens: 64_000,
    defaultReasoningOption: null,
    displayName: "Provider model",
    id: "provider/model",
    maxOutputTokens: 8_000,
    protocol: "openai-chat-completions",
    reasoningOptions: [{ type: "none" }, { effort: "high", type: "effort" }],
    supportsImageInput: false,
    supportsTools: true,
    ...overrides,
  };
}

describe("buildModelProviderConfig", () => {
  it.each([
    {
      expected: {
        baseUrl: "https://api.neuraldeep.ru/v1",
        protocol: "openai-chat-completions",
        providerName: "neuraldeep",
        reasoning: null,
      },
      model: catalogModel({ reasoningOptions: [] }),
      providerId: "neuraldeep",
      reasoning: null,
    },
    {
      expected: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { effort: "high", format: "deepseek", type: "effort" },
      },
      model: catalogModel(),
      providerId: "deepseek",
      reasoning: { effort: "high", type: "effort" },
    },
    {
      expected: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        compatibility: "minimax-anthropic",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
      model: catalogModel({
        protocol: "anthropic-messages",
        reasoningOptions: [{ type: "none" }, { mode: "adaptive", type: "enabled" }],
      }),
      providerId: "minimax",
      reasoning: { mode: "adaptive", type: "enabled" },
    },
    {
      expected: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        protocol: "openai-chat-completions",
        providerName: "opencode-go",
        reasoning: { effort: "high", format: "reasoning-effort", type: "effort" },
      },
      model: catalogModel({ id: "deepseek-v4-flash" }),
      providerId: "opencode-go",
      reasoning: { effort: "high", type: "effort" },
    },
    {
      expected: {
        authentication: "bearer",
        baseUrl: "https://opencode.ai/zen/go/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
      model: catalogModel({
        id: "minimax-m3",
        protocol: "anthropic-messages",
        reasoningOptions: [{ mode: "adaptive", type: "enabled" }],
      }),
      providerId: "opencode-go",
      reasoning: { mode: "adaptive", type: "enabled" },
    },
    {
      expected: {
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai-chat-completions",
        providerName: "openrouter",
        reasoning: { effort: "high", format: "reasoning-object", type: "effort" },
      },
      model: catalogModel(),
      providerId: "openrouter",
      reasoning: { effort: "high", type: "effort" },
    },
  ] satisfies Array<{
    expected: object;
    model: ProviderCatalogModel;
    providerId: ProviderId;
    reasoning: ReasoningSelection | null;
  }>)("builds the exact $providerId transport", ({ expected, model, providerId, reasoning }) => {
    const config = buildModelProviderConfig(providerId, model, reasoning, false);

    expect(config.agent.transport).toEqual(expected);
    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it("keeps unavailable reasoning uncontrolled and maps explicit none to disabled", () => {
    const none = catalogModel({ reasoningOptions: [{ type: "none" }] });
    const unavailable = catalogModel({ reasoningOptions: [] });

    expect(buildModelProviderConfig("deepseek", unavailable, null, false).agent.transport)
      .toMatchObject({ reasoning: null });
    expect(buildModelProviderConfig("openrouter", none, { type: "none" }, false).agent.transport)
      .toMatchObject({ reasoning: { format: "reasoning-object", type: "none" } });
    expect(buildModelProviderConfig("minimax", catalogModel({
      protocol: "anthropic-messages",
      reasoningOptions: [],
    }), null, false).agent.transport).toMatchObject({ reasoning: null });
  });

  it("uses the same image-capable model for primary and vision and fixed voice model", () => {
    const model = catalogModel({ supportsImageInput: true });
    const config = buildModelProviderConfig("openrouter", model, { type: "none" }, true);

    expect(config.agent.models).toEqual({
      primary: { contextWindowTokens: 64_000, id: "provider/model", maxOutputTokens: 8_000 },
      vision: { id: "provider/model", maxOutputTokens: 8_000, supportsImageInput: true },
    });
    expect(config.voice).toEqual({
      enabled: true,
      transcriptionModelId: "whisper-large-v3-turbo",
    });
    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it("uses the unavailable vision and disabled voice schema variants", () => {
    const config = buildModelProviderConfig(
      "openrouter",
      catalogModel({ reasoningOptions: [] }),
      null,
      false,
    );

    expect(config.agent.models.vision).toEqual({ supportsImageInput: false });
    expect(config.voice).toEqual({ enabled: false });
  });

  it("compares selected reasoning canonically rather than by object identity or key order", () => {
    const selected = { type: "effort", effort: "high" } as const;
    const model = catalogModel({ reasoningOptions: [{ effort: "high", type: "effort" }] });

    expect(() => buildModelProviderConfig("openrouter", model, selected, false)).not.toThrow();
    expect(() => buildModelProviderConfig(
      "openrouter",
      model,
      { effort: "low", type: "effort" },
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE");
  });

  it("rejects null when the catalog requires an explicit reasoning selection", () => {
    expect(() => buildModelProviderConfig("openrouter", catalogModel(), null, false))
      .toThrow("AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE");
  });

  it("rejects malformed injected reasoning metadata with a stable error", () => {
    const model = catalogModel({ reasoningOptions: [null] as never });

    expect(() => buildModelProviderConfig("openrouter", model, null, false))
      .toThrow("AGENT_PROVIDER_CONFIG_REASONING_INVALID");
  });

  it.each([
    ["missing context", { contextWindowTokens: null }],
    ["non-positive context", { contextWindowTokens: 0 }],
    ["missing output", { maxOutputTokens: null }],
    ["non-positive output", { maxOutputTokens: -1 }],
    ["output above runtime cap", { maxOutputTokens: 128_001 }],
    ["unknown image support", { supportsImageInput: null }],
    ["missing tool support", { supportsTools: false }],
  ])("rejects installer-unsafe metadata: %s", (_case, overrides) => {
    expect(() => buildModelProviderConfig(
      "openrouter",
      catalogModel(overrides),
      null,
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_MODEL_INVALID");
  });

  it("rejects a model protocol that contradicts its fixed provider transport", () => {
    expect(() => buildModelProviderConfig(
      "deepseek",
      catalogModel({ protocol: "anthropic-messages" }),
      null,
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_PROTOCOL_INVALID");
  });

  it("allows adaptive enabled reasoning only on Anthropic transport", () => {
    const openAiModel = catalogModel({
      reasoningOptions: [{ mode: "adaptive", type: "enabled" }],
    });
    const anthropicModel = catalogModel({
      protocol: "anthropic-messages",
      reasoningOptions: [{ mode: "enabled", type: "enabled" }],
    });

    expect(() => buildModelProviderConfig(
      "openrouter",
      openAiModel,
      { mode: "adaptive", type: "enabled" },
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED");
    expect(() => buildModelProviderConfig(
      "opencode-go",
      anthropicModel,
      { mode: "enabled", type: "enabled" },
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED");
  });
});
