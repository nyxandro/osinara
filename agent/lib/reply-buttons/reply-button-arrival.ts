/**
 * What reply buttons do the moment an update arrives, ahead of the chat queue.
 *
 * Exports:
 * - `createReplyButtonArrival`: the arrival step over the press and dismissal handlers.
 * - `replyButtonsOnArrival`: the production step.
 *
 * Key constructs:
 * - The chat queue may wait minutes for a running turn, while a person expects a tapped button to
 *   react at once and Telegram refuses a late answer to the tap. So a press is decided and answered,
 *   and a person's message removes their earlier buttons, as soon as the update is stored.
 * - The queue step does the same again in order; both are idempotent, and the first to decide a
 *   press answers it. A failure here only means the person waits for the queue, so it is logged and
 *   never fails the webhook.
 * - The step runs under the runtime admission of a callback, like any other work a release has to
 *   wait for: while the application is frozen for a backup it decides nothing, and the queue step
 *   decides after the release.
 */
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "../../runtime/telegram/inbound.js";

import { withRuntimeAdmission } from "../runtime-maintenance.js";
import { isReplyButtonCallback } from "./reply-button-contract.js";
import { dismissReplyButtonsOnMessage, hasReplyButtonsToDismiss } from "./reply-button-dismissal.js";
import { acknowledgeReplyButtonPress } from "./reply-button-press.js";

interface ReplyButtonArrivalDependencies {
  acknowledgeReplyButtonPress(query: TelegramCallbackQuery, updateId: string): Promise<void>;
  /** Runs the work when the release phase admits it, or returns null without running it. */
  admit(work: () => Promise<void>): Promise<void | null>;
  dismissReplyButtons(message: TelegramMessage, updateId: string): Promise<void>;
  /** A read: most messages come from someone with no buttons on screen and need no admission. */
  hasButtonsToDismiss(message: TelegramMessage): Promise<boolean>;
}

export function createReplyButtonArrival(dependencies: ReplyButtonArrivalDependencies) {
  return async function replyButtonsOnArrival(update: TelegramUpdate, updateId: string): Promise<void> {
    if (update.kind === "callback_query" && !isReplyButtonCallback(update.callbackQuery.data)) return;
    try {
      if (update.kind === "message" && !await dependencies.hasButtonsToDismiss(update.message)) return;
      await dependencies.admit(async () => {
        if (update.kind === "message") await dependencies.dismissReplyButtons(update.message, updateId);
        else await dependencies.acknowledgeReplyButtonPress(update.callbackQuery, updateId);
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_REPLY_BUTTONS_ARRIVAL_FAILED",
        error: error instanceof Error ? error.message : String(error),
        updateId,
      }));
    }
  };
}

export const replyButtonsOnArrival = createReplyButtonArrival({
  acknowledgeReplyButtonPress,
  admit: async (work) => await withRuntimeAdmission("callback", work),
  dismissReplyButtons: dismissReplyButtonsOnMessage,
  hasButtonsToDismiss: hasReplyButtonsToDismiss,
});
