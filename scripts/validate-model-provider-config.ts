/**
 * Runtime model configuration preflight.
 *
 * Construct:
 * - Loads and validates the canonical server-mounted provider configuration before Eve starts.
 */
import { modelProviderConfig } from "../agent/lib/model-provider-config.js";

// Import-time loading performs the validation; this assertion prevents dead-code elimination.
if (modelProviderConfig.schemaVersion !== 1) {
  throw new Error("AGENT_MODEL_PROVIDER_CONFIG_INVALID: Неподдерживаемая версия конфигурации");
}
