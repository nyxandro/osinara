/**
 * Tap-to-answer buttons under the agent's own answer.
 *
 * Export:
 * - Default `attach_reply_buttons`: stages buttons for this turn's final text answer.
 *
 * Key constructs:
 * - The buttons go out under the final answer of the turn, attached by the final delivery; the tool
 *   itself sends nothing.
 * - They are addressed to the person the turn answers: in a group only they can tap.
 * - A tap returns as that person's ordinary message and authorizes nothing more than its words.
 */
import { defineTool, type ToolContext } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  newReplyButtonToken,
  parseReplyButtonRows,
  REPLY_BUTTON_ROWS_SCHEMA,
  replyButtonLabels,
} from "../reply-buttons/reply-button-contract.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";

const ATTACHED_NEXT_STEP =
  "The buttons will appear under your final text answer of this turn. Write that answer now with the question in it; do not list the options again. A reaction or silence shows no buttons.";

const BUTTON_CHAT_TYPES = new Set(["group", "private", "supergroup"] as const);
type ButtonChatType = typeof BUTTON_CHAT_TYPES extends Set<infer T> ? T : never;

function isButtonChatType(value: unknown): value is ButtonChatType {
  return typeof value === "string" && BUTTON_CHAT_TYPES.has(value as ButtonChatType);
}

function requireTarget(ctx: ToolContext) {
  const attributes = ctx.session.auth.current?.attributes;
  const chatType = attributes?.telegramChatType;
  if (
    typeof attributes?.telegramChatId !== "string" ||
    typeof attributes.telegramUserId !== "string" ||
    !/^[1-9][0-9]*$/u.test(attributes.telegramUserId) ||
    !isButtonChatType(chatType) ||
    attributes.groupType === "external"
  ) {
    throw new AppError(
      "AGENT_REPLY_BUTTONS_CONTEXT_INVALID",
      "Кнопки ответа доступны только в личном чате и семейной группе",
    );
  }
  return {
    addresseeTelegramUserId: attributes.telegramUserId,
    telegramChatId: attributes.telegramChatId,
    telegramChatType: chatType,
  };
}

export default defineTool({
  description: "Tap-to-answer buttons under your final text answer of this turn. Call it before writing that answer; a second call replaces them.",
  inputSchema: z.strictObject({ rows: REPLY_BUTTON_ROWS_SCHEMA }),
  // Staging is keyed by the turn: a repeated call after a crash replaces the same staged set.
  replaySafe: true,
  async execute(input, ctx) {
    const rows = parseReplyButtonRows(input.rows);
    await replyButtonRepository.stageForTurn({
      ...requireTarget(ctx),
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
      buttons: rows,
      token: newReplyButtonToken(),
    });
    return { buttons: replyButtonLabels(rows), next: ATTACHED_NEXT_STEP, status: "attached" };
  },
});
