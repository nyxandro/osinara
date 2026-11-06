/**
 * The `private-question` channel: turns started by a `/me` command in a group (#467).
 *
 * Export:
 * - `privateQuestionObserver`: the turn observer the runtime routes this channel's turns to. It shows the
 *   answer, or a failure text, in place of the person's «Думаю…» and nothing anywhere else.
 */
import { privateQuestionStore } from "../lib/private-questions/private-question-repository.js";
import { createPrivateQuestionObserver } from "../lib/private-questions/private-question-delivery.js";
import { privateQuestionTelegram } from "../lib/private-questions/private-question-telegram.js";
import { recoverDatabaseBookkeeping } from "../lib/database-recovery.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";

export const privateQuestionObserver = createPrivateQuestionObserver({
  bindApplicationSession: (applicationSessionId, agentSessionId) =>
    sessionRepository.bindAgentSession(applicationSessionId, agentSessionId).then(() => undefined),
  async recordSessionTurn(applicationSessionId, agentSessionId, outcome) {
    // The one-off session retires after its single turn and is deleted with the other retired ones.
    await recoverDatabaseBookkeeping(() => outcome === "completed"
      ? sessionRepository.recordTurnCompleted(applicationSessionId, agentSessionId, false, true)
      : sessionRepository.recordTurnFailed(applicationSessionId, agentSessionId));
  },
  store: privateQuestionStore,
  telegram: privateQuestionTelegram,
});
