/**
 * Subscription-backed GPT Image transport.
 *
 * Exports:
 * - `ImageGenerationRequest`, `GeneratedImage`: strict transport contracts.
 * - `createImageGenerationClient`: dependency-injected, no-retry CLIProxyAPI client.
 * - `imageGenerationClient`: production client bound to the reviewed model provider config.
 *
 * Key constructs:
 * - One request maps to one `gpt-image-2` generation and one bounded WebP response.
 * - Provider rejection is definitive; transport, 5xx, and malformed success are ambiguous.
 */
import { AppError } from "../app-error.js";
import { modelProviderConfig } from "../model-provider-config.js";

export type ImageBackground = "auto" | "opaque" | "transparent";
export type ImageQuality = "auto" | "high" | "low" | "medium";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export interface ImageGenerationRequest {
  background: ImageBackground;
  prompt: string;
  quality: ImageQuality;
  size: ImageSize;
}

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: "image/webp";
  model: "gpt-image-2";
  revisedPrompt?: string;
}

interface ImageGenerationClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

const IMAGE_MODEL = "gpt-image-2" as const;
const IMAGE_OUTPUT_COMPRESSION = 90;
const IMAGE_GENERATION_TIMEOUT_MS = 5 * 60 * 1_000;
const IMAGE_RESPONSE_MAX_BYTES = 32 * 1_024 * 1_024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

function hasValidImageChunk(bytes: Buffer, type: string, offset: number, size: number): boolean {
  if (type === "VP8 ") {
    return size >= 10 &&
      (bytes[offset]! & 1) === 0 &&
      bytes.subarray(offset + 3, offset + 6).toString("hex") === "9d012a" &&
      (bytes.readUInt16LE(offset + 6) & 0x3fff) > 0 &&
      (bytes.readUInt16LE(offset + 8) & 0x3fff) > 0;
  }
  return type === "VP8L" && size >= 5 && bytes[offset] === 0x2f;
}

function isStructurallyValidWebp(bytes: Buffer): boolean {
  if (
    bytes.length < 25 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return false;

  // Validate every bounded RIFF chunk and require an actual lossy or lossless image payload.
  let foundImage = false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    if (dataEnd > bytes.length) return false;
    if (type === "VP8 " || type === "VP8L") {
      if (!hasValidImageChunk(bytes, type, dataOffset, size)) return false;
      foundImage = true;
    }
    offset = dataEnd + (size % 2);
  }
  return foundImage && offset === bytes.length;
}

function generationUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("images/generations", normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      "Не настроен безопасный адрес сервиса генерации изображений",
    );
  }
  return url.toString();
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > IMAGE_RESPONSE_MAX_BYTES) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
      "Сервис генерации вернул слишком большой ответ. Создайте новый запрос с меньшим изображением",
    );
  }
  if (!response.body) return "";

  // Read incrementally so an upstream response cannot exhaust the agent container.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    byteLength += item.value.byteLength;
    if (byteLength > IMAGE_RESPONSE_MAX_BYTES) {
      await reader.cancel("image response exceeds limit");
      throw new AppError(
        "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
        "Сервис генерации вернул слишком большой ответ. Создайте новый запрос с меньшим изображением",
      );
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseGeneratedImage(source: string): GeneratedImage {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
      error: error instanceof Error ? error.message : String(error),
    }));
    throw new AppError(
      "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
      "Сервис генерации вернул повреждённое изображение. Создайте новый запрос позднее",
    );
  }
  const item = (payload as { data?: unknown })?.data;
  const first = Array.isArray(item) ? item[0] : null;
  const encoded = first && typeof first === "object"
    ? (first as { b64_json?: unknown }).b64_json
    : null;
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !BASE64_PATTERN.test(encoded)
  ) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
      "Сервис генерации не вернул готовое изображение. Создайте новый запрос позднее",
    );
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!isStructurallyValidWebp(bytes)) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_RESPONSE_INVALID",
      "Сервис генерации вернул файл неподдерживаемого формата. Создайте новый запрос позднее",
    );
  }
  const revisedPrompt = first && typeof first === "object"
    ? (first as { revised_prompt?: unknown }).revised_prompt
    : null;
  return {
    bytes,
    mediaType: "image/webp",
    model: IMAGE_MODEL,
    ...(typeof revisedPrompt === "string" && revisedPrompt.trim()
      ? { revisedPrompt: revisedPrompt.trim() }
      : {}),
  };
}

export function createImageGenerationClient(options: ImageGenerationClientOptions) {
  return {
    async generate(input: ImageGenerationRequest): Promise<GeneratedImage> {
      if (!options.apiKey || /\s/u.test(options.apiKey)) {
        throw new AppError(
          "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
          "Не настроен доступ к сервису генерации изображений",
        );
      }
      const url = generationUrl(options.baseUrl);
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          body: JSON.stringify({
            background: input.background,
            model: IMAGE_MODEL,
            moderation: "auto",
            n: 1,
            output_compression: IMAGE_OUTPUT_COMPRESSION,
            output_format: "webp",
            prompt: input.prompt,
            quality: input.quality,
            response_format: "b64_json",
            size: input.size,
            stream: false,
          }),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
          error: error instanceof Error ? error.message : String(error),
          model: IMAGE_MODEL,
          url,
        }));
        throw new AppError(
          "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
          "Не удалось подтвердить результат генерации изображения. Не повторяйте запрос сразу",
        );
      }

      // A received 4xx proves rejection; 5xx may happen after a billable upstream side effect.
      if (!response.ok) {
        console.error(JSON.stringify({
          code: response.status >= 400 && response.status < 500
            ? "AGENT_IMAGE_GENERATION_REJECTED"
            : "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
          model: IMAGE_MODEL,
          statusCode: response.status,
          url,
        }));
        if (response.status >= 400 && response.status < 500) {
          throw new AppError(
            "AGENT_IMAGE_GENERATION_REJECTED",
            "Сервис генерации изображений отклонил запрос. Измените описание и попробуйте снова",
          );
        }
        throw new AppError(
          "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
          "Не удалось подтвердить результат генерации изображения. Не повторяйте запрос сразу",
        );
      }

      return parseGeneratedImage(await boundedResponseText(response));
    },
  };
}

function productionClient(): ReturnType<typeof createImageGenerationClient> {
  if (modelProviderConfig.provider !== "codex-subscription") {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      "Генерация изображений доступна только при подключённой Codex-подписке",
    );
  }
  const apiKey = process.env.MODEL_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      "Не настроен доступ к сервису генерации изображений",
    );
  }
  return createImageGenerationClient({
    apiKey,
    baseUrl: modelProviderConfig.agent.transport.baseUrl,
  });
}

export const imageGenerationClient = {
  generate(input: ImageGenerationRequest): Promise<GeneratedImage> {
    return productionClient().generate(input);
  },
};
