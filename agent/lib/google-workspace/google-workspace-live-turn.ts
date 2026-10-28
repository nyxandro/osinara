/**
 * Google Workspace changes happen only in a live turn with a person.
 *
 * Export:
 * - `googleWorkspaceChangeRefusal`: the refusal for a change in a delegated task or a scenario run,
 *   or null in a live turn.
 *
 * A Google change runs without the owner's button. A delegated child mostly reads untrusted pages,
 * and a scenario (an isolated run or a wake-up in the conversation) runs with nobody there to see it,
 * so text in a page or an email could otherwise send, forward or delete through them. Both keep
 * reads. The check reads the turn itself rather than reshaping the tool surface: a wake-up keeps the
 * conversation's tool descriptors byte-identical, so the provider keeps reusing its cache.
 *
 * Two independent marks name a scenario. The turn kind survives a button press inside a scenario,
 * whose continuation runs under the presser's auth; the auth attributes mark a scenario's own turns.
 */
import type { SessionContext } from "../../runtime/context.js";

import { scheduledRunId } from "../agent-schedules/scheduled-session.js";
import { AppError } from "../app-error.js";
import { conversationWakeupRunId } from "../conversation-wakeups/conversation-wakeup-turn.js";

export function googleWorkspaceChangeRefusal(ctx: Pick<SessionContext, "session">): AppError | null {
  if (ctx.session.parent !== undefined) {
    return new AppError(
      "AGENT_GOOGLE_WORKSPACE_SUBAGENT_WRITE_FORBIDDEN",
      "В делегированной задаче Google Workspace доступен только для чтения. Опишите нужное изменение в результате задачи: его выполнит основной агент",
      { isExpectedRefusal: true },
    );
  }
  const kind = ctx.session.turn.kind;
  const scenarioTurn = kind === "scheduled" || kind === "wakeup";
  if (scenarioTurn || scheduledRunId(ctx) !== null || conversationWakeupRunId(ctx.session.auth) !== null) {
    return new AppError(
      "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN",
      "В сценарии по расписанию Google Workspace доступен только для чтения. Сообщите в итоге, какое изменение нужно: человек попросит о нём в чате",
      { isExpectedRefusal: true },
    );
  }
  return null;
}
