/**
 * KLIPY-backed GIF reply tool.
 *
 * Exports:
 * - `createSendGifTool`: dependency-injected search, choice and delivery of one GIF reply.
 * - Default `send_gif`: production tool over KLIPY, the vision model and Telegram.
 *
 * Key constructs:
 * - The content filter follows the verified conversation kind, never the model's input.
 * - While the GIF is searched and chosen, the chat shows "choosing a sticker" instead of typing.
 * - The GIF is sent once: the tool is not replay-safe, so a call interrupted by a crash reaches the
 *   model as an unknown outcome instead of a second GIF.
 * - A delivered GIF stands for the answer, so it enters the conversation history like one.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { telegramCaptionFits } from "../attachments/telegram-workspace-file-delivery.js";
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { composeGifContactSheet, gifPreviewFrame } from "../gifs/gif-contact-sheet.js";
import { createGifPicker } from "../gifs/gif-picker.js";
import { downloadGifPreview } from "../gifs/gif-preview-download.js";
import {
  GIF_BRIEF_MAX_LENGTH,
  GIF_CONTENT_FILTER_BY_CHAT,
  GIF_QUERY_MAX_LENGTH,
} from "../gifs/gif-reply-config.js";
import { gifReplyFailure, gifReplyInputError } from "../gifs/gif-reply-errors.js";
import { createGifReplySearch, type FindGifReply } from "../gifs/gif-reply-search.js";
import { createKlipyClient } from "../gifs/klipy-client.js";
import { sendTelegramAnimation } from "../gifs/telegram-animation-delivery.js";
import { telegramChatActionStatus, type ChatActionStatus } from "../telegram-chat-action-status.js";
import { telegramTurnReplyParameters } from "../telegram-reply.js";
import {
  recordToolDeliveryInTimeline,
  toolDeliveryTimelineTarget,
} from "../telegram-tool-delivery-timeline.js";
import { analyzeImageWithVisionModel } from "../vision-model-analysis.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../workspaces/workspace-context.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface SendGifDependencies {
  choosingStatus: ChatActionStatus;
  find: FindGifReply;
  recordTimeline: typeof recordToolDeliveryInTimeline;
  send: typeof sendTelegramAnimation;
}

const GIF_CAPTION_MAX_LENGTH = 1_024;

const inputSchema = z.object({
  brief: z.string().trim().min(1).max(GIF_BRIEF_MAX_LENGTH)
    .describe("For the model that looks at the candidates: what the reply must express and in which tone, in one or two sentences, and whether a rude gesture is acceptable"),
  caption: z.string().trim().min(1).max(GIF_CAPTION_MAX_LENGTH).optional()
    .describe("An optional short phrase shown under the GIF"),
  query: z.string().trim().min(1).max(GIF_QUERY_MAX_LENGTH)
    .describe("An English search phrase of one to five words naming the emotion, gesture or situation, for example \"eye roll\", \"slow clap\", \"middle finger\""),
}).strict();

type SendGifInput = z.infer<typeof inputSchema>;

const DELIVERED_NEXT_STEP =
  `Гифка уже доставлена в чат и является твоим ответом. Если она говорит всё, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста; если к ней нужны слова, напиши только их и не описывай гифку.`;

const NOT_FOUND_NEXT_STEP =
  "Подходящей гифки не нашлось, в чат ничего не отправлено. Можно один раз вызвать send_gif с другим query; иначе ответь текстом. Если человек прямо просил гифку, коротко скажи, что подходящей не нашлось.";

function parseInput(input: unknown): SendGifInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw gifReplyInputError();
  // Checked before the search: Telegram would refuse the caption only after a GIF was chosen.
  if (parsed.data.caption !== undefined && !telegramCaptionFits(parsed.data.caption)) throw gifReplyInputError();
  return parsed.data;
}

function conversationKind(auth: WorkspaceAuthorization): keyof typeof GIF_CONTENT_FILTER_BY_CHAT {
  if (auth.telegramChatType === "private" && auth.groupId === null) return "private";
  if (auth.groupType === "family_private") return "family";
  if (auth.groupType === "external") return "external";
  throw new AppError("AGENT_WORKSPACE_CONTEXT_INVALID", "Не удалось определить тип чата для гифки");
}

/** In a group the GIF answers the message that addressed the agent, like a text answer does. */
function replyToMessageId(ctx: ToolContext, chatId: string): number | undefined {
  const chatType = ctx.session.auth.current?.attributes.telegramChatType;
  if (chatType !== "group" && chatType !== "supergroup") return undefined;
  return telegramTurnReplyParameters({ chatId, chatType }, ctx)?.message_id;
}

function timelineText(description: string, caption: string | undefined): string {
  return caption === undefined ? `Гифка: ${description}` : `Гифка: ${description}\n\nПодпись: ${caption}`;
}

async function sendGif(
  dependencies: SendGifDependencies,
  input: SendGifInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const contentFilter = GIF_CONTENT_FILTER_BY_CHAT[conversationKind(requireWorkspaceAuthorization(ctx))];
  const target = requireTelegramDeliveryTarget(ctx);
  // Resolved before the search, so a malformed context costs no KLIPY request and no vision call.
  const timelineTarget = toolDeliveryTimelineTarget(ctx);
  const replyTo = replyToMessageId(ctx, target.chatId);

  const found = await dependencies.choosingStatus(target, async () => await dependencies.find({
    abortSignal: ctx.abortSignal,
    brief: input.brief,
    contentFilter,
    query: input.query,
  }));
  if (found.outcome !== "picked") {
    return {
      delivered: false,
      nextStep: NOT_FOUND_NEXT_STEP,
      outcome: found.outcome,
      retryable: false,
      sideEffectStatus: "not_started",
    };
  }

  const delivery = await dependencies.send({
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    chatId: target.chatId,
    height: found.gif.height,
    ...(target.messageThreadId === undefined ? {} : { messageThreadId: target.messageThreadId }),
    ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
    url: found.gif.sendUrl,
    width: found.gif.width,
  });
  const projectionCompleted = await dependencies.recordTimeline(ctx, timelineTarget, {
    contentText: timelineText(found.description, input.caption),
    failureCode: "AGENT_GIF_PROJECTION_FAILED",
    replacesAnswer: true,
    telegramMessageId: delivery.telegramMessageId,
  });
  return {
    delivered: true,
    description: found.description,
    nextStep: DELIVERED_NEXT_STEP,
    projectionCompleted,
    retryable: false,
    sheetsShown: found.sheetsShown,
    sideEffectStatus: "completed",
    telegramMessageId: delivery.telegramMessageId,
  };
}

export function createSendGifTool(dependencies: SendGifDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Answer with a GIF: search KLIPY with an English query, let the vision model choose a fitting GIF from the results by brief, and send it to the current chat.",
      "Use it when asked for a GIF and on your own initiative under the GIF rules of this chat.",
      "After the result follow nextStep; on an error follow correction and do not repeat the call.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        return await sendGif(dependencies, parseInput(rawInput), ctx);
      } catch (error) {
        throw gifReplyFailure(error);
      }
    },
  }) as AnyToolDefinition;
}

function klipyApiKey(): string {
  const key = process.env.KLIPY_API_KEY;
  // The tool is offered only with a key, so a missing one here means the process config changed.
  if (!key) throw new AppError("AGENT_GIF_SEARCH_NOT_CONFIGURED", "Поиск гифок не настроен");
  return key;
}

export default createSendGifTool({
  choosingStatus: telegramChatActionStatus({ action: "choose_sticker", failureCode: "AGENT_GIF_CHOOSING_STATUS_FAILED" }),
  find: createGifReplySearch({
    composeSheet: composeGifContactSheet,
    downloadPreview: downloadGifPreview,
    pick: createGifPicker({ analyze: analyzeImageWithVisionModel }).pick,
    previewFrame: gifPreviewFrame,
    search: async (input) => await createKlipyClient({ apiKey: klipyApiKey(), fetch }).search(input),
  }),
  recordTimeline: recordToolDeliveryInTimeline,
  send: sendTelegramAnimation,
});
