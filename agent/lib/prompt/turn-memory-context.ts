/** Supplemental, turn-scoped system context; never a new user request or durable history. */
export function formatTurnMemoryContext(content: string): string {
  return `<osinara_turn_memory>\n${content}\n</osinara_turn_memory>`;
}
