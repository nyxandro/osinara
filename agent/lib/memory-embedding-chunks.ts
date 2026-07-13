/**
 * Deterministic memory embedding chunking.
 *
 * Exports:
 * - `MemoryEmbeddingChunkText`: source-aligned text chunk metadata.
 * - `chunkMemoryContent`: bounded overlapping chunks that fit multilingual E5-small.
 * - `chunkMemoryQuery`: the same complete coverage without the stored-memory length cap.
 */
import { AppError } from "./app-error.js";
import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
} from "./memory-config.js";

export interface MemoryEmbeddingChunkText {
  chunkIndex: number;
  content: string;
  endOffset: number;
  startOffset: number;
}

const WHITESPACE_PATTERN = /\s/;

function trimmedBounds(content: string, startOffset: number, endOffset: number) {
  let start = startOffset;
  let end = endOffset;
  while (start < end && WHITESPACE_PATTERN.test(content[start]!)) start += 1;
  while (end > start && WHITESPACE_PATTERN.test(content[end - 1]!)) end -= 1;
  return { end, start };
}

function preferredEnd(content: string, startOffset: number): number {
  const hardEnd = Math.min(startOffset + MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS, content.length);
  if (hardEnd === content.length) return hardEnd;

  // Prefer a natural boundary near the hard limit without producing tiny fragments.
  const minimumEnd = startOffset + MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS;
  for (let index = hardEnd; index >= minimumEnd; index -= 1) {
    if (WHITESPACE_PATTERN.test(content[index - 1]!)) return index;
  }
  return hardEnd;
}

function chunkText(content: string): MemoryEmbeddingChunkText[] {
  if (!content.trim()) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти невозможно подготовить для смыслового поиска",
    );
  }

  const chunks: MemoryEmbeddingChunkText[] = [];
  let sourceStart = 0;
  while (sourceStart < content.length) {
    const sourceEnd = preferredEnd(content, sourceStart);
    const bounds = trimmedBounds(content, sourceStart, sourceEnd);
    if (bounds.start < bounds.end) {
      chunks.push({
        chunkIndex: chunks.length,
        content: content.slice(bounds.start, bounds.end),
        endOffset: bounds.end,
        startOffset: bounds.start,
      });
    }
    if (sourceEnd >= content.length) break;

    // Overlap preserves semantics crossing a boundary; strict progress prevents malformed loops.
    sourceStart = Math.max(
      sourceEnd - MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
      sourceStart + 1,
    );
  }
  if (chunks.length === 0) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти не образовал ни одного фрагмента для поиска",
    );
  }
  return chunks;
}

export function chunkMemoryContent(content: string): MemoryEmbeddingChunkText[] {
  if (content.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_INPUT_INVALID",
      "Текст памяти превышает допустимый размер смыслового индекса",
    );
  }
  return chunkText(content);
}

export function chunkMemoryQuery(query: string): MemoryEmbeddingChunkText[] {
  return chunkText(query);
}
