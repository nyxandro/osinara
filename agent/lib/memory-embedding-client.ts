/**
 * Local Text Embeddings Inference client.
 *
 * Exports:
 * - `embedMemoryPassages`: embeds indexed chunks with the E5 passage protocol.
 * - `embedMemoryQuery`: embeds retrieval queries with the E5 query protocol.
 */
import { AppError } from "./app-error.js";
import { chunkMemoryQuery } from "./memory-embedding-chunks.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
} from "./memory-config.js";

const EMBEDDING_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

interface EmbeddingResponseItem {
  embedding: unknown;
  index: unknown;
}

interface EmbeddingResponse {
  data?: EmbeddingResponseItem[];
  model?: unknown;
}

const E5_PASSAGE_PREFIX = "passage: ";
const E5_QUERY_PREFIX = "query: ";

function requireEmbeddingBaseUrl(): string {
  const raw = process.env.MEMORY_EMBEDDING_BASE_URL;
  if (!raw) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_CONFIG_MISSING",
      "Не задан адрес локального сервиса памяти",
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_CONFIG_INVALID",
      "Адрес локального сервиса памяти имеет неподдерживаемый протокол",
    );
  }
  return url.origin;
}

function parseVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== MEMORY_EMBEDDING_DIMENSIONS) return null;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return value as number[];
}

async function embedMemoryTexts(
  texts: readonly string[],
  fetchImplementation: typeof fetch = fetch,
): Promise<number[][]> {
  if (texts.length === 0 || texts.some((text) => !text.trim())) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Для поиска памяти требуется непустой текст",
    );
  }
  const endpoint = new URL("/v1/embeddings", requireEmbeddingBaseUrl()).toString();
  const response = await fetchImplementation(endpoint, {
    body: JSON.stringify({
      encoding_format: "float",
      input: texts,
      model: MEMORY_EMBEDDING_MODEL,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_PROVIDER_FAILED",
      "Локальный сервис памяти не смог обработать текст. Повторите попытку позже",
    );
  }
  const payload = (await response.json()) as EmbeddingResponse;
  if (payload.model !== MEMORY_EMBEDDING_MODEL) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_MODEL_MISMATCH",
      "Локальный сервис памяти использует другую модель",
    );
  }
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
      "Локальный сервис памяти вернул некорректный результат",
    );
  }

  // TEI may return batch entries out of order; indexes must form one complete zero-based sequence.
  const ordered: Array<number[] | undefined> = Array.from({ length: texts.length });
  for (const item of payload.data) {
    if (!Number.isInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= texts.length) {
      throw new AppError(
        "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
        "Локальный сервис памяти вернул некорректный порядок результатов",
      );
    }
    const vector = parseVector(item.embedding);
    if (!vector || ordered[Number(item.index)]) {
      throw new AppError(
        "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
        "Локальный сервис памяти вернул вектор неверного формата",
      );
    }
    ordered[Number(item.index)] = vector;
  }
  if (ordered.some((vector) => vector === undefined)) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
      "Локальный сервис памяти вернул неполный результат",
    );
  }
  return ordered as number[][];
}

export async function embedMemoryPassages(
  texts: readonly string[],
  fetchImplementation: typeof fetch = fetch,
): Promise<number[][]> {
  return embedMemoryTexts(
    texts.map((text) => `${E5_PASSAGE_PREFIX}${text}`),
    fetchImplementation,
  );
}

export async function embedMemoryQuery(
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<number[]> {
  const chunks = chunkMemoryQuery(query);
  const embeddings: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
    embeddings.push(...await embedMemoryTexts(
      chunks
        .slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE)
        .map((chunk) => `${E5_QUERY_PREFIX}${chunk.content}`),
      fetchImplementation,
    ));
  }
  if (embeddings.length === 1) return embeddings[0]!;

  // A normalized centroid gives every query fragment influence without dropping long-message content.
  const centroid = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, (_, dimension) =>
    embeddings.reduce((sum, embedding) => sum + embedding[dimension]!, 0) / embeddings.length,
  );
  const magnitude = Math.sqrt(centroid.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
      "Локальный сервис памяти вернул некорректное объединение запроса",
    );
  }
  return centroid.map((value) => value / magnitude);
}
