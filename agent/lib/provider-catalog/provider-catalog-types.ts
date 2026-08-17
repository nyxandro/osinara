/**
 * Provider catalog public and internal contracts.
 *
 * Exports:
 * - `ProviderId`: supported live model-catalog providers.
 * - `ProviderProtocol`: runtime protocols accepted by the installer boundary.
 * - `ReasoningEffort`: normalized effort values published by provider metadata.
 * - `ReasoningSelection`: installer-ready disabled, effort, or provider-native enabled choice.
 * - `ProviderCatalogModel`: normalized model metadata without fabricated defaults.
 * - `ProviderCatalogFetch`: injected Fetch API-compatible dependency.
 * - `FetchProviderCatalogOptions`: explicit catalog request inputs.
 */
export type ProviderId = "deepseek" | "minimax" | "neuraldeep" | "opencode-go" | "openrouter";

export type ProviderProtocol = "anthropic-messages" | "openai-chat-completions";

export type ReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal";

export type ReasoningSelection =
  | { type: "none" }
  | { effort: ReasoningEffort; type: "effort" }
  | { mode: "adaptive" | "enabled"; type: "enabled" };

/** Null means the provider response did not supply the metadata; it is not an estimate. */
export interface ProviderCatalogModel {
  contextWindowTokens: number | null;
  defaultReasoningOption: ReasoningSelection | null;
  displayName: string;
  id: string;
  maxOutputTokens: number | null;
  protocol: ProviderProtocol;
  reasoningOptions: ReasoningSelection[];
  supportsImageInput: boolean | null;
  supportsTools: boolean | null;
}

export type ProviderCatalogFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchProviderCatalogOptions {
  apiKey?: string;
  fetch: ProviderCatalogFetch;
  providerId: ProviderId;
  timeoutMs: number;
}
