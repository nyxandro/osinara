/**
 * Runtime availability of image input for the configured agent model.
 *
 * Export:
 * - `MODEL_VISION_AVAILABLE`: whether the active validated model config declares image input.
 *
 * The installer derives the flag from the model catalog when a model is connected. It is resolved
 * once at module load: the config is validated at startup and changes only with a restart, so every
 * capability that needs vision appears and disappears together, and nothing persisted has to be
 * switched off when the model changes.
 */
import { modelProviderConfig } from "./model-provider-config.js";

export const MODEL_VISION_AVAILABLE = modelProviderConfig.agent.models.vision.supportsImageInput;
