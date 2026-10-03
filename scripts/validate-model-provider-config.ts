/**
 * Runtime model configuration preflight.
 *
 * Construct:
 * - Loads and validates the canonical config and its dependent credentials before the agent starts.
 */
import { modelProviderConfig } from "../agent/lib/model-provider-config.js";
import { validateModelProviderRuntimeEnvironment } from "../agent/lib/model-provider-config-schema.js";

// Voice activation changes which secret is mandatory, so validate it against the parsed config.
validateModelProviderRuntimeEnvironment(modelProviderConfig, process.env);

// Import-time loading performs the validation; this assertion prevents dead-code elimination.
if (modelProviderConfig.schemaVersion !== 4) {
  throw new Error("AGENT_MODEL_PROVIDER_CONFIG_INVALID: Неподдерживаемая версия конфигурации");
}
