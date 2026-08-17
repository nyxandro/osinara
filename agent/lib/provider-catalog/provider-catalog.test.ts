/**
 * Provider catalog boundary tests.
 *
 * Constructs covered:
 * - `fetchProviderCatalog`: fetches provider model catalogs through an injected fetch.
 * - Provider authentication, endpoint selection, HTTP handling, and bounded timeout behavior.
 * - DeepSeek, MiniMax, and NeuralDeep parsing without fabricated live availability.
 * - Models.dev enrichment, strict live-ID intersection, and installer-ready model filtering.
 * - OpenCode Go's maintained protocol allowlist and exclusion of unknown or unsupported IDs.
 * - Stable `AppError` codes for invalid input and malformed provider responses.
 */
import { describe, expect, it, vi } from "vitest";

import {
  fetchProviderCatalog,
  type ProviderCatalogFetch,
  type ProviderCatalogModel,
} from "./provider-catalog.js";
import {
  createFetch,
  expectAppError,
  jsonResponse,
  REQUEST_TIMEOUT_MS,
} from "./provider-catalog-test-helpers.js";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Routes injected requests by URL so live and metadata responses remain independently testable. */
function createCatalogFetch(responses: Record<string, Response>): ProviderCatalogFetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = responses[url];
    if (!response) throw new Error(`Unexpected test URL: ${url}`);
    return response;
  });
}

describe("fetchProviderCatalog", () => {
  it.each(["deepseek", "minimax", "neuraldeep"] as const)(
    "requires authentication before fetching the %s catalog",
    async (providerId) => {
      const fetch = createFetch(jsonResponse({ object: "list", data: [] }));

      await expectAppError(
        fetchProviderCatalog({ fetch, providerId, timeoutMs: REQUEST_TIMEOUT_MS }),
        "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
        `Для загрузки каталога ${providerId} нужен API-ключ`,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns the documented NeuralDeep qwen3.8 model only when it is live", async () => {
    const fetch = createCatalogFetch({
      "https://api.neuraldeep.ru/v1/models": jsonResponse({
        object: "list",
        data: [
          { id: "qwen3.8-27b", object: "model", owned_by: "neuraldeep" },
          { id: "embedding-only", object: "model", owned_by: "neuraldeep" },
        ],
      }),
    });

    const models = await fetchProviderCatalog({
      apiKey: "neuraldeep-secret",
      fetch,
      providerId: "neuraldeep",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://api.neuraldeep.ru/v1/models", {
      headers: { authorization: "Bearer neuraldeep-secret" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(models).toEqual<ProviderCatalogModel[]>([{
      contextWindowTokens: 262_144,
      defaultReasoningOption: null,
      displayName: "Qwen 3.8 27B",
      id: "qwen3.8-27b",
      maxOutputTokens: 16_384,
      protocol: "openai-chat-completions",
      reasoningOptions: [],
      supportsImageInput: true,
      supportsTools: true,
    }]);
  });

  it("rejects a blank required API key before fetching", async () => {
    const fetch = createFetch(jsonResponse({ object: "list", data: [] }));

    await expectAppError(
      fetchProviderCatalog({
        apiKey: "   ",
        fetch,
        providerId: "deepseek",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
      "Для загрузки каталога deepseek нужен API-ключ",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("intersects DeepSeek live IDs with complete models.dev metadata", async () => {
    const fetch = createCatalogFetch({
      "https://api.deepseek.com/models": jsonResponse({
        object: "list",
        data: [
          { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
          { id: "live-without-metadata", object: "model", owned_by: "deepseek" },
          { id: "no-tools", object: "model", owned_by: "deepseek" },
          { id: "incomplete-limits", object: "model", owned_by: "deepseek" },
          { id: "no-text", object: "model", owned_by: "deepseek" },
        ],
      }),
      [MODELS_DEV_URL]: jsonResponse({
        deepseek: {
          id: "deepseek",
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              limit: { context: 1_000_000, output: 384_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "DeepSeek V4 Flash",
              reasoning_options: [
                { type: "toggle" },
                { type: "effort", values: ["low", "high", "max"] },
              ],
              tool_call: true,
            },
            "metadata-only": {
              id: "metadata-only",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "Metadata Only",
              reasoning_options: [],
              tool_call: true,
            },
            "no-tools": {
              id: "no-tools",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "No Tools",
              reasoning_options: [],
              tool_call: false,
            },
            "incomplete-limits": {
              id: "incomplete-limits",
              limit: { context: 64_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "Incomplete Limits",
              reasoning_options: [],
              tool_call: true,
            },
            "no-text": {
              id: "no-text",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["image"], output: ["text"] },
              name: "No Text",
              reasoning_options: [],
              tool_call: true,
            },
          },
          name: "DeepSeek",
        },
      }),
    });

    const models = await fetchProviderCatalog({
      apiKey: "deepseek-secret",
      fetch,
      providerId: "deepseek",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/models", {
      headers: { authorization: "Bearer deepseek-secret" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenCalledWith(MODELS_DEV_URL, {
      headers: {},
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(models).toEqual<ProviderCatalogModel[]>([
      {
        contextWindowTokens: 1_000_000,
        defaultReasoningOption: null,
        displayName: "DeepSeek V4 Flash",
        id: "deepseek-v4-flash",
        maxOutputTokens: 128_000,
        protocol: "openai-chat-completions",
        reasoningOptions: [
          { type: "none" },
          { effort: "low", type: "effort" },
          { effort: "high", type: "effort" },
          { effort: "max", type: "effort" },
        ],
        supportsImageInput: false,
        supportsTools: true,
      },
    ]);
  });

  it("maps a MiniMax toggle only to the mode expressible by its Anthropic transport", async () => {
    const fetch = createCatalogFetch({
      "https://api.minimax.io/v1/models": jsonResponse({
        object: "list",
        data: [{ id: "MiniMax-M3", object: "model", owned_by: "minimax" }],
      }),
      [MODELS_DEV_URL]: jsonResponse({
        minimax: {
          id: "minimax",
          models: {
            "MiniMax-M3": {
              id: "MiniMax-M3",
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ["text", "image", "video"], output: ["text"] },
              name: "MiniMax M3",
              reasoning_options: [{ type: "toggle" }],
              tool_call: true,
            },
          },
          name: "MiniMax",
        },
      }),
    });

    const models = await fetchProviderCatalog({
      apiKey: "minimax-secret",
      fetch,
      providerId: "minimax",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith("https://api.minimax.io/v1/models", {
      headers: { authorization: "Bearer minimax-secret" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(models).toEqual<ProviderCatalogModel[]>([
      {
        contextWindowTokens: 1_000_000,
        defaultReasoningOption: null,
        displayName: "MiniMax M3",
        id: "MiniMax-M3",
        maxOutputTokens: 128_000,
        protocol: "anthropic-messages",
        reasoningOptions: [
          { type: "none" },
          { mode: "adaptive", type: "enabled" },
        ],
        supportsImageInput: true,
        supportsTools: true,
      },
    ]);
  });

  it("keeps only OpenCode Go IDs with an exact maintained supported protocol", async () => {
    const fetch = createCatalogFetch({
      "https://opencode.ai/zen/go/v1/models": jsonResponse({
        object: "list",
        data: [
          { id: "minimax-m3", object: "model", created: 1, owned_by: "opencode" },
          { id: "deepseek-v4-flash", object: "model", created: 1, owned_by: "opencode" },
          { id: "gpt-5.6-luna", object: "model", created: 1, owned_by: "opencode" },
          { id: "future-unknown-model", object: "model", created: 1, owned_by: "opencode" },
        ],
      }),
      [MODELS_DEV_URL]: jsonResponse({
        "opencode-go": {
          id: "opencode-go",
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              limit: { context: 1_000_000, output: 384_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "DeepSeek V4 Flash (2x usage)",
              reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
              tool_call: true,
            },
            "gpt-5.6-luna": {
              id: "gpt-5.6-luna",
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "GPT 5.6 Luna",
              reasoning_options: [{ type: "effort", values: ["high"] }],
              tool_call: true,
            },
            "minimax-m3": {
              id: "minimax-m3",
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ["text", "image"], output: ["text"] },
              name: "MiniMax M3",
              reasoning_options: [{ type: "toggle" }],
              tool_call: true,
            },
          },
          name: "OpenCode Go",
        },
      }),
    });

    const models = await fetchProviderCatalog({
      fetch,
      providerId: "opencode-go",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/models", {
      headers: {},
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(models.map(({ id, protocol, reasoningOptions }) => ({
      id,
      protocol,
      reasoningOptions,
    }))).toEqual([
      {
        id: "minimax-m3",
        protocol: "anthropic-messages",
        reasoningOptions: [
          { type: "none" },
          { mode: "adaptive", type: "enabled" },
        ],
      },
      {
        id: "deepseek-v4-flash",
        protocol: "openai-chat-completions",
        reasoningOptions: [
          { effort: "low", type: "effort" },
          { effort: "high", type: "effort" },
          { effort: "max", type: "effort" },
        ],
      },
    ]);
    expect(models[0]).toMatchObject({
      contextWindowTokens: 1_000_000,
      defaultReasoningOption: null,
      displayName: "MiniMax M3",
      maxOutputTokens: 128_000,
      supportsImageInput: true,
      supportsTools: true,
    });
  });

  it("sends optional bearer authentication to OpenCode Go", async () => {
    const fetch = createCatalogFetch({
      "https://opencode.ai/zen/go/v1/models": jsonResponse({ object: "list", data: [] }),
      [MODELS_DEV_URL]: jsonResponse({
        "opencode-go": { id: "opencode-go", models: {}, name: "OpenCode Go" },
      }),
    });

    await fetchProviderCatalog({
      apiKey: "go-secret",
      fetch,
      providerId: "opencode-go",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { authorization: "Bearer go-secret" },
    }));
  });

});
