/**
 * Runtime availability gate for subscription-backed image generation.
 *
 * Exports:
 * - `supportsSubscriptionImageGeneration`: pure provider capability check.
 * - `IMAGE_GENERATION_AVAILABLE`: availability for the active validated runtime config.
 */
import { modelProviderConfig, type ModelProviderId } from "../model-provider-config.js";

export function supportsSubscriptionImageGeneration(provider: ModelProviderId): boolean {
  return provider === "codex-subscription";
}

export const IMAGE_GENERATION_AVAILABLE = supportsSubscriptionImageGeneration(
  modelProviderConfig.provider,
);
