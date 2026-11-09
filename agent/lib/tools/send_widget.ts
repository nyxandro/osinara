/**
 * The tool that sends a Telegram widget to the current private chat.
 *
 * Exports:
 * - `createSendWidgetTool`: dependency-injected delivery of one widget.
 * - Default `send_widget`: the production tool over Telegram's `sendWidget` (Bot API 10.4 beta).
 *
 * Key constructs:
 * - The widget is either an A2UI 1.0 `createSurface` message over the Telegram widget catalog, which
 *   the application validates and builds (`agent/lib/widgets/`), or the model's own HTML for a game or
 *   an animation the catalog cannot describe, which never talks to the bot (F6 B of #468).
 * - The caption is required: it is what the chat list, search and every app that does not show widgets
 *   yet display (F3 of #468).
 * - The widget is sent once: the tool is not replay-safe, so a call interrupted by a crash reaches the
 *   model as an unknown outcome instead of a second widget.
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { groupReplyToMessageId, sendTelegramNativeMessage } from "../telegram-sends/telegram-native-send.js";
import { telegramSendFailure, telegramSendInputError } from "../telegram-sends/telegram-send-errors.js";
import { recordToolDeliveryInTimeline, toolDeliveryTimelineTarget } from "../telegram-tool-delivery-timeline.js";
import { officialCheck } from "../widgets/html/official-check.js";
import { sendWidget, type SendWidgetDependencies, WIDGET_TOOL_CODES } from "../widgets/send-widget.js";
import { prepareWidgetButtons } from "../widgets/widget-buttons.js";
import {
  WIDGET_CAPTION_MAX_LENGTH,
  WIDGET_CAPTION_WITH_BUTTONS_MAX_LENGTH,
  WIDGET_HEIGHT_MAX,
  WIDGET_HEIGHT_MIN,
} from "../widgets/widget-config.js";
import { widgetRepository } from "../widgets/widget-repository.js";
import { requireTelegramDeliveryTarget } from "../workspaces/workspace-context.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const inputSchema = z.object({
  caption: z.string().trim().min(1).max(WIDGET_CAPTION_WITH_BUTTONS_MAX_LENGTH)
    .describe(`1-3 lines up to ${WIDGET_CAPTION_MAX_LENGTH} characters: what the widget is and the facts a person acts on (time, place, amount). People whose app does not show widgets see only this. Buttons under the card are written at its end with the same <tg-button> markup as under an answer; they do not count toward the length.`),
  height: z.number().int().min(WIDGET_HEIGHT_MIN).max(WIDGET_HEIGHT_MAX).optional()
    .describe("Only with html: a fixed height in px for a canvas or an animation; otherwise the height follows the content"),
  html: z.string().min(1).optional()
    .describe("Your own self-contained HTML for a game or an animation the catalog cannot describe; it cannot talk to the bot. Never together with surface"),
  surface: z.record(z.string(), z.unknown()).optional()
    .describe("One A2UI 1.0 message { version: \"1.0\", createSurface: { surfaceId, catalogId, components, dataModel } } over the catalog of the widgets skill"),
}).strict();

type SendWidgetInput = z.infer<typeof inputSchema>;

const TOOL = {
  ambiguousCode: WIDGET_TOOL_CODES.ambiguous,
  failureCode: WIDGET_TOOL_CODES.failed,
  name: "send_widget",
  subject: "виджет",
} as const;

function parseInput(input: unknown): SendWidgetInput {
  const parsed = inputSchema.safeParse(input);
  const value = parsed.success ? parsed.data : null;
  if (value === null || (value.surface === undefined) === (value.html === undefined) || (value.height !== undefined && value.html === undefined)) {
    throw telegramSendInputError({
      code: WIDGET_TOOL_CODES.invalid,
      correction: `Передай caption (1-${WIDGET_CAPTION_MAX_LENGTH} символов) и ровно одно из двух: surface — одно сообщение A2UI createSurface по каталогу скилла widgets, или html — свой HTML игры или анимации; height (${WIDGET_HEIGHT_MIN}-${WIDGET_HEIGHT_MAX}) — только вместе с html. Других полей не передавай. Затем повтори вызов один раз.`,
      reason: "Параметры виджета не прошли проверку.",
    });
  }
  return value;
}

export function createSendWidgetTool(dependencies: SendWidgetDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Send a Telegram widget to this private chat: a small interactive card drawn inside the message.",
      "Load the widgets skill before the first call in a conversation: it has the A2UI catalog, the rules and examples.",
      "Prefer surface (A2UI); use html only for a game or an animation the catalog cannot describe.",
      "After the result follow nextStep; on an error follow correction.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        const input = parseInput(rawInput);
        const target = requireTelegramDeliveryTarget(ctx);
        // Resolved before the send, so a malformed context stops it instead of losing the history.
        const timelineTarget = toolDeliveryTimelineTarget(ctx);
        return await sendWidget(dependencies, input, ctx, {
          chatId: target.chatId,
          replyToMessageId: groupReplyToMessageId(ctx, target.chatId),
          timelineTarget,
        });
      } catch (error) {
        throw telegramSendFailure(TOOL, error);
      }
    },
  }) as AnyToolDefinition;
}

export default createSendWidgetTool({
  buttons: prepareWidgetButtons,
  check: officialCheck,
  recordTimeline: recordToolDeliveryInTimeline,
  repository: widgetRepository,
  send: sendTelegramNativeMessage,
});
