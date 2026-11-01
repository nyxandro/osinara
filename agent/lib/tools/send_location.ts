/**
 * The tool that sends a place or a point on the map to the current chat.
 *
 * Exports:
 * - `createSendLocationTool`: dependency-injected delivery of one location message.
 * - Default `send_location`: production tool over Telegram `sendVenue` and `sendLocation`.
 *
 * Key constructs:
 * - With a title and an address the point becomes a place card that opens in maps (`sendVenue`);
 *   without them it is a bare point (`sendLocation`).
 * - The message is sent once: the tool is not replay-safe, so a call interrupted by a crash reaches
 *   the model as an unknown outcome instead of a second message.
 * - The sent place enters the history as the same line the agent reads when a person shares one.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";
import { z } from "zod";

import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { telegramContentDescription } from "../telegram-content/telegram-content-description.js";
import { groupReplyToMessageId, sendTelegramNativeMessage } from "../telegram-sends/telegram-native-send.js";
import { telegramSendFailure, telegramSendInputError } from "../telegram-sends/telegram-send-errors.js";
import {
  recordToolDeliveryInTimeline,
  toolDeliveryTimelineTarget,
} from "../telegram-tool-delivery-timeline.js";
import { requireTelegramDeliveryTarget } from "../workspaces/workspace-context.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface SendLocationDependencies {
  recordTimeline: typeof recordToolDeliveryInTimeline;
  send: typeof sendTelegramNativeMessage;
}

// Telegram documents no limit for a venue's title and address; these keep a card readable.
const VENUE_TITLE_MAX_LENGTH = 128;
const VENUE_ADDRESS_MAX_LENGTH = 256;

const inputSchema = z.object({
  address: z.string().trim().min(1).max(VENUE_ADDRESS_MAX_LENGTH).optional()
    .describe("The place's street address, as the person would read it; only together with title"),
  latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees, from a shared location or a source you read"),
  longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees, from a shared location or a source you read"),
  title: z.string().trim().min(1).max(VENUE_TITLE_MAX_LENGTH).optional()
    .describe("The place's name; pass it with address to send a place card, omit both for a bare point"),
}).strict();

type SendLocationInput = z.infer<typeof inputSchema>;

const TOOL = {
  ambiguousCode: "AGENT_LOCATION_DELIVERY_AMBIGUOUS",
  failureCode: "AGENT_LOCATION_SEND_FAILED",
  name: "send_location",
  subject: "место на карте",
} as const;

const DELIVERED_NEXT_STEP =
  `Место уже в чате и стало частью твоего ответа. Если оно отвечает целиком, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста; если нужны слова, напиши только их и не повторяй адрес и координаты.`;

function parseInput(input: unknown): SendLocationInput {
  const parsed = inputSchema.safeParse(input);
  // A venue needs both: Telegram refuses a card with only one of them.
  if (!parsed.success || (parsed.data.title === undefined) !== (parsed.data.address === undefined)) {
    throw telegramSendInputError({
      code: "AGENT_LOCATION_SEND_INPUT_INVALID",
      correction:
        `Передай latitude от -90 до 90 и longitude от -180 до 180 в десятичных градусах. Для карточки места добавь вместе title до ${VENUE_TITLE_MAX_LENGTH} символов и address до ${VENUE_ADDRESS_MAX_LENGTH} символов, для простой точки не передавай ни того, ни другого. Других полей не передавай. Затем повтори вызов один раз.`,
      reason: "Параметры места не прошли проверку.",
    });
  }
  return parsed.data;
}

async function sendLocation(
  dependencies: SendLocationDependencies,
  input: SendLocationInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const target = requireTelegramDeliveryTarget(ctx);
  // Resolved before the send, so a malformed context stops it instead of losing the history.
  const timelineTarget = toolDeliveryTimelineTarget(ctx);
  const replyToMessageId = groupReplyToMessageId(ctx, target.chatId);
  const point = { latitude: input.latitude, longitude: input.longitude };
  const venue = input.title !== undefined && input.address !== undefined
    ? { address: input.address, title: input.title }
    : null;

  const delivery = await dependencies.send({
    body: venue === null ? point : { ...point, ...venue },
    codes: {
      ambiguous: TOOL.ambiguousCode,
      ambiguousMessage: "Не удалось подтвердить отправку места. Проверьте чат перед повторной просьбой",
      failed: "AGENT_LOCATION_DELIVERY_FAILED",
      failedMessage: "Telegram не принял место на карте",
    },
    method: venue === null ? "sendLocation" : "sendVenue",
    target: {
      ...target,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    },
  });
  const contentText = telegramContentDescription(venue === null ? { location: point } : { venue: { ...venue, location: point } })!;
  const projectionCompleted = await dependencies.recordTimeline(ctx, timelineTarget, {
    contentText,
    failureCode: "AGENT_LOCATION_PROJECTION_FAILED",
    telegramMessageId: delivery.telegramMessageId,
  });
  return {
    delivered: true,
    nextStep: DELIVERED_NEXT_STEP,
    projectionCompleted,
    retryable: false,
    sideEffectStatus: "completed",
    telegramMessageId: delivery.telegramMessageId,
  };
}

export function createSendLocationTool(dependencies: SendLocationDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Send a point on the map to the current chat; with title and address it becomes a place card that opens in maps.",
      "Use it when someone asks where something is, where to meet or to send a location, and when a place is the answer.",
      "Take coordinates only from a location shared in the conversation or from a source you read; never estimate them.",
      "After the result follow nextStep; on an error follow correction and do not repeat the call.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        return await sendLocation(dependencies, parseInput(rawInput), ctx);
      } catch (error) {
        throw telegramSendFailure(TOOL, error);
      }
    },
  }) as AnyToolDefinition;
}

export default createSendLocationTool({
  recordTimeline: recordToolDeliveryInTimeline,
  send: sendTelegramNativeMessage,
});
