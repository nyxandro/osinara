/**
 * Counting what the memory-usage line named, once the turn is allowed to have effects at all.
 *
 * Export:
 * - `recordMemoryUsageDeclaration`: moves the counters and writes down whether the rule was kept.
 *
 * Reading the line and acting on it are deliberately separate. The text has to be cleaned before
 * the transport decides what kind of answer this is — a reaction, a silence, a progress note — and
 * that decision happens before the barrier that stops a superseded session from touching anything.
 * So the answer is cleaned early and the counter is moved late, behind that barrier.
 *
 * The log line is not optional. Without it nobody can tell whether the rule is followed at all,
 * and a signal that quietly stopped arriving looks exactly like a memory where nothing is useful.
 */
import type { SessionAuth } from "eve/context";

import { memoryFailureCode } from "./memory-context-failure.js";
import type { MemoryUsageDeclaration } from "./memory-usage-directive.js";
import { memoryUsageRepository } from "./memory-usage-repository.js";

export async function recordMemoryUsageDeclaration(input: {
  auth: SessionAuth;
  declaration: MemoryUsageDeclaration;
  eveSessionId: string;
  turnId: string;
}): Promise<void> {
  const conversationId = input.auth.current?.attributes.telegramConversationId;
  if (typeof conversationId !== "string") return;

  let counted: string[] = [];
  let used: string[] = [];
  let rejected: string[] = [];
  let failed: string | null = null;
  try {
    const outcome = await memoryUsageRepository.recordUsed(
      { conversationId, eveSessionId: input.eveSessionId, turnId: input.turnId },
      input.declaration.memoryRefs,
    );
    counted = outcome.counted;
    used = outcome.used;
    rejected = outcome.rejected;
  } catch (error) {
    // A counter that did not move must never cost the person their answer.
    failed = memoryFailureCode(error) ?? "UNCLASSIFIED_USAGE_ERROR";
  }

  console.info(JSON.stringify({
    code: "AGENT_MEMORY_USAGE_DIRECTIVE",
    // Fewer counted than used means this turn was processed more than once, not that the model
    // named a record twice: the second pass recognizes the journal rows the first one marked.
    countedCount: counted.length,
    declared: input.declaration.declared,
    failed,
    namedCount: input.declaration.memoryRefs.length,
    rejectedCount: rejected.length,
    sessionId: input.eveSessionId,
    turnId: input.turnId,
    usedCount: used.length,
  }));
}
