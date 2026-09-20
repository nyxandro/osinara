/**
 * The assistant's own name as people actually type it.
 *
 * Exports:
 * - `AGENT_NAME_STEM_SOURCE`: the alternation of spellings, including the common mishearings.
 * - `isAgentNameMentioned`: true when the text names the assistant at a word boundary.
 *
 * One list, two readers. The Telegram boundary uses it to decide whether a group message was
 * addressed to the assistant at all; memory query preparation uses it to drop that address before
 * searching. Two copies of the list would drift, and the drift would be silent in both places.
 */
export const AGENT_NAME_STEM_SOURCE = "осинар|асинар|азинар|озинар|синаар|osinar|asinar";

const AGENT_NAME_PATTERN = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${AGENT_NAME_STEM_SOURCE})\\p{L}*(?=$|[^\\p{L}\\p{N}_])`,
  "iu",
);

export function isAgentNameMentioned(text: string): boolean {
  return AGENT_NAME_PATTERN.test(text);
}
