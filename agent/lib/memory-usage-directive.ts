/**
 * The model saying which memory records its answer actually rested on.
 *
 * Exports:
 * - `MEMORY_USAGE_DIRECTIVE`: the service line, in the spelling the instruction asks for.
 * - `MEMORY_USAGE_INSTRUCTION`: what the model is told, placed right after the records themselves.
 * - `MemoryUsageDeclaration`: the answer without the line, plus the refs it named.
 * - `readMemoryUsageDirective`: reads and removes the line; pure, so it can run before the
 *   delivery barrier decides whether this turn may have side effects at all.
 *
 * Why this exists: memory cannot tell a record that earns its place in every other conversation
 * from one that has not been useful once since it was written. Both queue for the same twelve
 * slots. On production the reinforcement counter stood at zero for 1456 records out of 1465 and
 * had never reached two, because it counts a fact being *observed again*, not a record being used.
 *
 * Where the instruction sits matters more than how it is worded. A measurement on a neighbouring
 * project, blind, over eighteen real turns and two samples each: the rule inside the mode block
 * produced the line once in thirty-six answers, a conditional reminder twice, and a required
 * reminder immediately after the memory records thirty-four times. Same rule, three places.
 *
 * An empty list is a real answer and must stay distinguishable from silence: «nothing here helped»
 * is information, «the model forgot the rule» is a defect, and the log separates them.
 *
 * The line is transport syntax, so it is removed the way the aside directive is removed: every
 * occurrence, wherever it stands, except inside code the person asked to see. The model writes it
 * on every step it produces text, including the progress note before a tool call and the message
 * that carries a reaction directive, so a reader that only looked at the last line would leak it.
 */
import { isIndentedCodeLine, nextFenceState, type FenceState } from "./markdown-code-fence.js";

const MEMORY_REF_PATTERN = "mem_[0-9a-f]{32}";
const DIRECTIVE_NAME = "память";

export const MEMORY_USAGE_DIRECTIVE = `[${DIRECTIVE_NAME}: mem_… , mem_…]`;

const DIRECTIVE_SOURCE = `\\[${DIRECTIVE_NAME}:[^\\]\\n]*\\]`;
const DIRECTIVE_LINE_PATTERN = new RegExp(`^${DIRECTIVE_SOURCE}[ \\t\\r]*$`, "iu");
const DIRECTIVE_OCCURRENCE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "giu");
const DIRECTIVE_PRESENCE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "iu");
const REF_PATTERN = new RegExp(MEMORY_REF_PATTERN, "gu");

export const MEMORY_USAGE_INSTRUCTION = [
  `Последней строкой ответа всегда пиши служебную строку вида ${MEMORY_USAGE_DIRECTIVE} и перечисляй в ней memoryRef тех записей выше, на которых держится ответ.`,
  `Если ни одна не пригодилась, напиши [${DIRECTIVE_NAME}: нет] — это нормальный ответ, а не ошибка.`,
  "Строка служебная: человек её не увидит, транспорт вырезает её до отправки. Она не считается текстом ответа, поэтому её можно дописать и к реакции, и к молчанию.",
  "Ссылаться можно только на записи из этого блока.",
].join(" ");

export interface MemoryUsageDeclaration {
  /** The answer as the person will read it, with the service line gone. */
  answer: string;
  /** True when the model wrote the line at all, whatever it put inside. */
  declared: boolean;
  memoryRefs: string[];
}

export function readMemoryUsageDirective(text: string): MemoryUsageDeclaration {
  const refs: string[] = [];
  let declared = false;
  const kept: string[] = [];
  let fence: FenceState | null = null;
  for (const line of text.split("\n")) {
    const openFence = fence;
    fence = nextFenceState(line, fence);
    // Code the person asked to see keeps its literal content, directive-shaped or not.
    if (openFence || fence || isIndentedCodeLine(line) || !DIRECTIVE_PRESENCE_PATTERN.test(line)) {
      kept.push(line);
      continue;
    }
    declared = true;
    for (const occurrence of line.matchAll(DIRECTIVE_OCCURRENCE_PATTERN)) {
      refs.push(...[...occurrence[0].matchAll(REF_PATTERN)].map((ref) => ref[0]));
    }
    // A line that was nothing but the directive goes with it; a sentence around it stays.
    if (DIRECTIVE_LINE_PATTERN.test(line)) continue;
    kept.push(line.replace(DIRECTIVE_OCCURRENCE_PATTERN, "").replace(/[ \t]{2,}/gu, " ").trimEnd());
  }
  return {
    answer: kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
    declared,
    memoryRefs: [...new Set(refs)],
  };
}
