/**
 * Making sure every chunk actually fits the model's window.
 *
 * Export:
 * - `fitMemoryChunksToTokenLimit`: splits any chunk the tokenizer says is too long.
 *
 * The chunker cuts by characters, and characters are not tokens. Measured on this model: ordinary
 * Russian runs about 2.7 characters per token, text with links and codes about 2.4, and the worst
 * shapes — a line of single letters, a wall of punctuation — reach 1.5. A script with one token per
 * character would be worse still. A character limit chosen to survive the worst case would have to
 * stay near five hundred, which is why the previous one sat at four hundred and used a third of the
 * window on every ordinary record.
 *
 * So the limit is chosen from the measured distribution and this check catches what falls outside
 * it. The service is configured not to truncate, so an overflow returns an error and the record
 * simply never enters the semantic index — the failure this guards against is silence, not noise.
 *
 * Splitting keeps the chunk an exact slice of the record: a chunk is cut at a whitespace boundary
 * inside its own offsets, and the two halves together cover exactly what the original covered.
 */
import { AppError } from "./app-error.js";
import { MEMORY_EMBEDDING_MAX_TOKENS } from "./memory-config.js";

export interface FittableChunk {
  content: string;
  endOffset: number;
  startOffset: number;
}

/** Halving from nine hundred characters reaches a few dozen in four rounds; nothing needs more. */
const MAX_SPLIT_ROUNDS = 4;

/** Offsets with surrounding whitespace excluded, so the stored text is exactly this slice. */
function trimmedSlice<T extends FittableChunk>(chunk: T, content: string, from: number, to: number): T | null {
  let start = from;
  let end = to;
  while (start < end && /\s/u.test(content[start]!)) start += 1;
  while (end > start && /\s/u.test(content[end - 1]!)) end -= 1;
  if (start >= end) return null;
  return { ...chunk, content: content.slice(start, end), endOffset: end, startOffset: start };
}

function splitAtWhitespace<T extends FittableChunk>(chunk: T, content: string): T[] | null {
  const middle = Math.floor((chunk.startOffset + chunk.endOffset) / 2);
  let boundary = middle;
  while (boundary > chunk.startOffset && !/\s/u.test(content[boundary - 1]!)) boundary -= 1;
  // No whitespace in the first half: cut at the midpoint, but never inside a surrogate pair.
  if (boundary === chunk.startOffset) {
    boundary = middle;
    if (content.codePointAt(boundary - 1)! > 0xffff) boundary += 1;
  }
  if (boundary <= chunk.startOffset || boundary >= chunk.endOffset) return null;
  const halves = [
    trimmedSlice(chunk, content, chunk.startOffset, boundary),
    trimmedSlice(chunk, content, boundary, chunk.endOffset),
  ].filter((half): half is T => half !== null);
  return halves.length === 0 ? null : halves;
}

/**
 * `measure` receives the exact texts that will be sent to the model — chunk plus whatever header
 * wraps it — and returns their token counts in the same order.
 */
export async function fitMemoryChunksToTokenLimit<T extends FittableChunk>(
  input: {
    chunks: readonly T[];
    content: string;
    measure: (chunks: readonly T[]) => Promise<number[]>;
    onSplit?: (tokens: number) => void;
  },
): Promise<T[]> {
  let current = [...input.chunks];
  for (let round = 0; round <= MAX_SPLIT_ROUNDS; round += 1) {
    const tokenCounts = await input.measure(current);
    if (tokenCounts.length !== current.length) {
      throw new AppError(
        "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID",
        "Локальный сервис памяти вернул неполный размер текста",
      );
    }
    const oversize = tokenCounts.findIndex((tokens) => tokens > MEMORY_EMBEDDING_MAX_TOKENS);
    if (oversize === -1) return current;

    const next: T[] = [];
    for (const [index, chunk] of current.entries()) {
      if (tokenCounts[index]! <= MEMORY_EMBEDDING_MAX_TOKENS) {
        next.push(chunk);
        continue;
      }
      input.onSplit?.(tokenCounts[index]!);
      const halves = splitAtWhitespace(chunk, input.content);
      if (halves === null) {
        throw new AppError(
          "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
          "Фрагмент текста памяти не помещается в окно модели и не делится дальше",
        );
      }
      next.push(...halves);
    }
    current = next.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
  }
  throw new AppError(
    "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
    "Текст памяти не удалось разделить до размера окна модели",
  );
}
