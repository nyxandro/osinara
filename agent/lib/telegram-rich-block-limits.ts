/**
 * Telegram Rich Message block-count limits.
 *
 * Exports:
 * - `TELEGRAM_RICH_MESSAGE_MAX_BLOCKS`: documented provider limit including nested blocks.
 * - `estimateTelegramRichBlocks`: conservative Markdown block estimate used before delivery.
 * - `splitTelegramRichBlockByCount`: splits line-oriented lists/tables without losing table headers.
 */
import { nextFenceState, type FenceState } from "./markdown-code-fence.js";

export const TELEGRAM_RICH_MESSAGE_MAX_BLOCKS = 500;

const LIST_ITEM_PATTERN = /^\s*(?:[-+*]|\d+\.)\s/u;
const TABLE_ROW_PATTERN = /^\s*\|?.+\|.+\|?\s*$/u;
const TABLE_DELIMITER_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;

export function estimateTelegramRichBlocks(markdown: string): number {
  let blocks = 0;
  // Every fence Markdown knows (backticks or tildes, any length) holds one block, not one per line.
  let fence: FenceState | null = null;
  const listIndents: number[] = [];
  let table = false;

  // Non-empty prose lines are counted separately on purpose: overestimation is safer than a
  // provider rejection and affects only unusually large rich responses.
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence === null && fence !== null) blocks += 1;
    if (openFence !== null || fence !== null) continue;
    if (!trimmed) {
      listIndents.length = 0;
      table = false;
      continue;
    }
    if (LIST_ITEM_PATTERN.test(line)) {
      const indentation = /^\s*/u.exec(line)![0].replaceAll("\t", "  ").length;
      while (listIndents.length > 0 && listIndents.at(-1)! > indentation) listIndents.pop();
      if (listIndents.at(-1) !== indentation) {
        listIndents.push(indentation);
        blocks += 1;
      }
      blocks += 1;
      table = false;
      continue;
    }
    if (TABLE_ROW_PATTERN.test(line)) {
      if (!table) blocks += 1;
      blocks += 1;
      table = true;
      listIndents.length = 0;
      continue;
    }
    listIndents.length = 0;
    table = false;
    blocks += 1 + (line.match(/<details(?:\s+open)?>/gu)?.length ?? 0);
  }
  return blocks;
}

function groupLines(
  lines: readonly string[],
  maxBlocks: number,
  prefix: readonly string[] = [],
): string[] {
  const chunks: string[] = [];
  let current = [...prefix];
  for (const line of lines) {
    const candidate = [...current, line];
    if (current.length > prefix.length &&
      estimateTelegramRichBlocks(candidate.join("\n")) > maxBlocks) {
      chunks.push(current.join("\n"));
      current = [...prefix, line];
      continue;
    }
    current = candidate;
  }
  if (current.length > prefix.length) chunks.push(current.join("\n"));
  return chunks;
}

export function splitTelegramRichBlockByCount(
  block: string,
  maxBlocks: number,
): string[] {
  if (estimateTelegramRichBlocks(block) <= maxBlocks) return [block];
  const lines = block.split("\n");
  if (lines.length < 2) return [block];

  // Every table continuation repeats its header and delimiter so each provider chunk parses alone.
  if (lines.length > 2 && TABLE_ROW_PATTERN.test(lines[0]!) &&
    TABLE_DELIMITER_PATTERN.test(lines[1]!)) {
    return groupLines(lines.slice(2), maxBlocks, lines.slice(0, 2));
  }
  return groupLines(lines, maxBlocks);
}
