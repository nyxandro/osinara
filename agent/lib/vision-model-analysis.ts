/**
 * One image question to the configured vision model.
 *
 * Export:
 * - `analyzeImageWithVisionModel`: sends a question and image bytes, returns the model's text.
 *
 * The model receives only the question and the image, never the conversation. Provider failures
 * propagate unchanged so that each caller can name them in its own contract.
 */
import { generateText } from "ai";

import { AppError } from "./app-error.js";
import { visionModel } from "./model-registry.js";

export async function analyzeImageWithVisionModel(input: {
  abortSignal?: AbortSignal;
  bytes: Uint8Array;
  mediaType: string;
  question: string;
}): Promise<string> {
  if (visionModel === null) {
    throw new AppError(
      "AGENT_MODEL_VISION_CONFIG_INCONSISTENT",
      "Конфигурация vision-модели не соответствует заявленной поддержке изображений",
    );
  }
  const result = await generateText({
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    messages: [{
      content: [
        { text: input.question, type: "text" },
        { data: input.bytes, mediaType: input.mediaType, type: "file" },
      ],
      role: "user",
    }],
    maxRetries: 0,
    model: visionModel,
  });
  return result.text;
}
