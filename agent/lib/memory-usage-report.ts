/**
 * Taking the memory-usage line out of an answer and counting what it named.
 *
 * Export:
 * - `applyMemoryUsageDirective`: the text a person will read, with the counters already moved.
 *
 * It sits between the model and the transport because the line is transport syntax: a person must
 * never see it, and the counter must move only for records this turn had actually shown.
 *
 * The log line is not optional. Without it nobody can tell whether the rule is followed at all,
 * and a signal that quietly stopped arriving looks exactly like a memory where nothing is useful.
 */
import type { SessionAuth } from "eve/context";

import { readMemoryUsageDirective } from "./memory-usage-directive.js";
import { memoryUsageRepository } from "./memory-usage-repository.js";

export async function applyMemoryUsageDirective(input: {
  auth: SessionAuth;
  sessionId: string;
  text: string;
  turnId: string;
}): Promise<string> {
  const directive = readMemoryUsageDirective(input.text);
  const conversationId = input.auth.current?.attributes.telegramConversationId;
  if (typeof conversationId !== "string") return directive.answer;

  let used: string[] = [];
  let rejected: string[] = [];
  let failed: string | null = null;
  try {
    const outcome = await memoryUsageRepository.recordUsed(
      { conversationId, turnId: input.turnId, turnOrdinal: 0 },
      directive.memoryRefs,
    );
    used = outcome.used;
    rejected = outcome.rejected;
  } catch (error) {
    // A counter that did not move must never cost the person their answer.
    failed = error instanceof Error ? error.name : "UnknownError";
  }

  console.info(JSON.stringify({
    code: "AGENT_MEMORY_USAGE_DIRECTIVE",
    declared: directive.declared,
    failed,
    namedCount: directive.memoryRefs.length,
    rejectedCount: rejected.length,
    sessionId: input.sessionId,
    turnId: input.turnId,
    usedCount: used.length,
  }));
  return directive.answer;
}
