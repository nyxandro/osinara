/**
 * External-group model presentation for subscription image generation.
 *
 * Export:
 * - `EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION`: group-only description and input schema.
 */
import type { ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

type AnyToolDefinition = ToolDefinition<any, any>;

const IMAGE_PROMPT_MAX_LENGTH = 8_000;
const TELEGRAM_CAPTION_MAX_LENGTH = 1_024;

export const EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION: Pick<
  AnyToolDefinition,
  "description" | "inputSchema"
> = {
  description: [
    "Create one raster image through GPT-Image-2, save it in the group workspace and send it right away as a photo to the current external group.",
    "In prompt describe the purpose, scene, object, composition, style and exclusions. For an unspecified size, quality or background pass auto.",
    "Do not use it for SVG, code-native diagrams, editing an existing file or background generation.",
    "If the error reports an unknown status, do not repeat the call automatically: the subscription limit may have been spent.",
  ].join(" "),
  inputSchema: z.object({
    background: z.enum(["transparent", "opaque", "auto"]),
    caption: z.string().min(1).max(TELEGRAM_CAPTION_MAX_LENGTH).optional(),
    prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
    quality: z.enum(["low", "medium", "high", "auto"]),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]),
  }).strict(),
};
