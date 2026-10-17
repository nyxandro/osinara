/**
 * Runtime availability of GIF replies.
 *
 * Exports:
 * - `gifRepliesAvailable`: pure check of the two conditions.
 * - `GIF_REPLIES_AVAILABLE`: availability for this process.
 *
 * A GIF is chosen by looking at its frames, so the model must accept images, and the search needs
 * a KLIPY key. Without either the tool and its prompt rules are absent everywhere, the way voice
 * transcription is absent without its key. Both inputs are fixed for the life of the process.
 */
import { MODEL_VISION_AVAILABLE } from "../model-vision-availability.js";

export function gifRepliesAvailable(input: { klipyApiKey: string | undefined; vision: boolean }): boolean {
  return input.vision && input.klipyApiKey !== undefined && input.klipyApiKey.length > 0;
}

export const GIF_REPLIES_AVAILABLE = gifRepliesAvailable({
  klipyApiKey: process.env.KLIPY_API_KEY,
  vision: MODEL_VISION_AVAILABLE,
});
