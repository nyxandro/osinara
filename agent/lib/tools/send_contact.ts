/**
 * The tool that sends a contact card to the current chat.
 *
 * Exports:
 * - `createSendContactTool`: dependency-injected delivery of one contact message.
 * - Default `send_contact`: production tool over Telegram `sendContact`.
 *
 * Key constructs:
 * - The number keeps the digits and the leading plus the model wrote; spaces, brackets, dots and
 *   dashes go. A country prefix is never guessed: `8 916…` stays `8916…`.
 * - The message is sent once: the tool is not replay-safe, so a call interrupted by a crash reaches
 *   the model as an unknown outcome instead of a second card.
 * - The sent card enters the history as the same line the agent reads when a person shares one.
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

interface SendContactDependencies {
  recordTimeline: typeof recordToolDeliveryInTimeline;
  send: typeof sendTelegramNativeMessage;
}

// Telegram documents no limit for the names; these keep a card readable in a phone's address book.
const CONTACT_NAME_MAX_LENGTH = 64;
// Service numbers such as 112 are three digits; E.164 allows at most fifteen.
const PHONE_MIN_DIGITS = 3;
const PHONE_MAX_DIGITS = 15;
const PHONE_SEPARATORS = /[\s().\-]/gu;
const CLEAN_PHONE_PATTERN = new RegExp(`^\\+?\\d{${PHONE_MIN_DIGITS},${PHONE_MAX_DIGITS}}$`, "u");

const inputSchema = z.object({
  firstName: z.string().trim().min(1).max(CONTACT_NAME_MAX_LENGTH)
    .describe("The name the card is saved under, for example «Иван» or «Сантехник Иван»"),
  lastName: z.string().trim().min(1).max(CONTACT_NAME_MAX_LENGTH).optional()
    .describe("The surname or a short role, only when known"),
  phone: z.string().trim().min(1)
    .describe("The phone number exactly as it was given in a message, memory or a source you read; never invent or complete one"),
}).strict();

interface SendContactInput {
  firstName: string;
  lastName?: string;
  phone: string;
}

const TOOL = {
  ambiguousCode: "AGENT_CONTACT_DELIVERY_AMBIGUOUS",
  failureCode: "AGENT_CONTACT_SEND_FAILED",
  name: "send_contact",
  subject: "карточку контакта",
} as const;

const DELIVERED_NEXT_STEP =
  `Карточка контакта уже в чате и стала частью твоего ответа. Если она отвечает целиком, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста; если нужны слова, напиши только их и не повторяй номер.`;

function inputError(): Error {
  return telegramSendInputError({
    code: "AGENT_CONTACT_SEND_INPUT_INVALID",
    correction:
      `Передай phone: номер из ${PHONE_MIN_DIGITS}–${PHONE_MAX_DIGITS} цифр, плюс допустим только в начале, пробелы, скобки и дефисы можно оставить; firstName до ${CONTACT_NAME_MAX_LENGTH} символов и при необходимости lastName. Других полей не передавай. Затем повтори вызов один раз.`,
    reason: "Параметры контакта не прошли проверку.",
  });
}

function parseInput(input: unknown): SendContactInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw inputError();
  const phone = parsed.data.phone.replace(PHONE_SEPARATORS, "");
  if (!CLEAN_PHONE_PATTERN.test(phone)) throw inputError();
  return { ...parsed.data, phone };
}

async function sendContact(
  dependencies: SendContactDependencies,
  input: SendContactInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const target = requireTelegramDeliveryTarget(ctx);
  // Resolved before the send, so a malformed context stops it instead of losing the history.
  const timelineTarget = toolDeliveryTimelineTarget(ctx);
  const replyToMessageId = groupReplyToMessageId(ctx, target.chatId);
  const body = {
    first_name: input.firstName,
    ...(input.lastName === undefined ? {} : { last_name: input.lastName }),
    phone_number: input.phone,
  };

  const delivery = await dependencies.send({
    body,
    codes: {
      ambiguous: TOOL.ambiguousCode,
      ambiguousMessage: "Не удалось подтвердить отправку контакта. Проверьте чат перед повторной просьбой",
      failed: "AGENT_CONTACT_DELIVERY_FAILED",
      failedMessage: "Telegram не принял карточку контакта",
    },
    method: "sendContact",
    target: {
      ...target,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    },
  });
  const contentText = telegramContentDescription({ contact: body })!;
  const projectionCompleted = await dependencies.recordTimeline(ctx, timelineTarget, {
    contentText,
    failureCode: "AGENT_CONTACT_PROJECTION_FAILED",
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

export function createSendContactTool(dependencies: SendContactDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Send a contact card to the current chat; the person saves it to their phone's contacts with one tap.",
      "Use it when someone asks for a person's or a service's phone number to save or to call.",
      "Take the number only from a message, memory or a source you read; never invent, guess or complete one. Without a number say that you do not know it.",
      "After the result follow nextStep; on an error follow correction.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        return await sendContact(dependencies, parseInput(rawInput), ctx);
      } catch (error) {
        throw telegramSendFailure(TOOL, error);
      }
    },
  }) as AnyToolDefinition;
}

export default createSendContactTool({
  recordTimeline: recordToolDeliveryInTimeline,
  send: sendTelegramNativeMessage,
});
