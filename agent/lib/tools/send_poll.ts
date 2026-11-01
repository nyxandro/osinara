/**
 * The tool that starts a native Telegram poll in the current chat.
 *
 * Exports:
 * - `createSendPollTool`: dependency-injected delivery of one poll.
 * - Default `send_poll`: production tool over Telegram `sendPoll`.
 *
 * Key constructs:
 * - A regular poll with 2-12 distinct options; anonymity and several answers follow the call and
 *   otherwise Telegram's own defaults (anonymous, one answer).
 * - The poll is sent once: the tool is not replay-safe, so a call interrupted by a crash reaches
 *   the model as an unknown outcome instead of a second poll.
 * - The sent poll enters the history as the same line the agent reads for a poll it receives.
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

interface SendPollDependencies {
  recordTimeline: typeof recordToolDeliveryInTimeline;
  send: typeof sendTelegramNativeMessage;
}

// Telegram's limits for `sendPoll` (Bot API 10.3); one option is no choice, so two is the floor.
const POLL_QUESTION_MAX_LENGTH = 300;
const POLL_OPTION_MAX_LENGTH = 100;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 12;

const inputSchema = z.object({
  allowsMultipleAnswers: z.boolean().optional()
    .describe("true when the options do not exclude each other; one answer when omitted"),
  anonymous: z.boolean().optional()
    .describe("false when the chat needs to see who chose what; Telegram makes the poll anonymous when omitted"),
  options: z.array(z.string().trim().min(1).max(POLL_OPTION_MAX_LENGTH)).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS)
    .describe(`${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} short distinct answer options, each up to ${POLL_OPTION_MAX_LENGTH} characters`),
  question: z.string().trim().min(1).max(POLL_QUESTION_MAX_LENGTH)
    .describe(`The poll question, up to ${POLL_QUESTION_MAX_LENGTH} characters`),
}).strict();

type SendPollInput = z.infer<typeof inputSchema>;

const TOOL = {
  ambiguousCode: "AGENT_POLL_DELIVERY_AMBIGUOUS",
  failureCode: "AGENT_POLL_SEND_FAILED",
  name: "send_poll",
  subject: "опрос",
} as const;

const DELIVERED_NEXT_STEP =
  `Опрос уже в чате и стал частью твоего ответа. Если он отвечает на просьбу целиком, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста; если нужны слова, напиши только их и не перечисляй варианты.`;

function distinct(options: readonly string[]): boolean {
  return new Set(options.map((option) => option.toLocaleLowerCase("ru"))).size === options.length;
}

function parseInput(input: unknown): SendPollInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !distinct(parsed.data.options)) {
    throw telegramSendInputError({
      code: "AGENT_POLL_SEND_INPUT_INVALID",
      correction:
        `Передай question до ${POLL_QUESTION_MAX_LENGTH} символов и options — от ${POLL_MIN_OPTIONS} до ${POLL_MAX_OPTIONS} разных вариантов до ${POLL_OPTION_MAX_LENGTH} символов каждый; при необходимости anonymous и allowsMultipleAnswers как true или false. Других полей не передавай. Затем повтори вызов один раз.`,
      reason: "Параметры опроса не прошли проверку.",
    });
  }
  return parsed.data;
}

async function sendPoll(
  dependencies: SendPollDependencies,
  input: SendPollInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const target = requireTelegramDeliveryTarget(ctx);
  // Resolved before the send, so a malformed context stops it instead of losing the history.
  const timelineTarget = toolDeliveryTimelineTarget(ctx);
  const replyToMessageId = groupReplyToMessageId(ctx, target.chatId);

  const delivery = await dependencies.send({
    body: {
      ...(input.allowsMultipleAnswers === undefined ? {} : { allows_multiple_answers: input.allowsMultipleAnswers }),
      ...(input.anonymous === undefined ? {} : { is_anonymous: input.anonymous }),
      options: input.options.map((text) => ({ text })),
      question: input.question,
    },
    codes: {
      ambiguous: TOOL.ambiguousCode,
      ambiguousMessage: "Не удалось подтвердить отправку опроса. Проверьте чат перед повторной просьбой",
      failed: "AGENT_POLL_DELIVERY_FAILED",
      failedMessage: "Telegram не принял опрос: возможно, в этом чате боту нельзя отправлять опросы",
    },
    method: "sendPoll",
    target: {
      ...target,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    },
  });
  const contentText = telegramContentDescription({
    poll: {
      allows_multiple_answers: input.allowsMultipleAnswers === true,
      is_anonymous: input.anonymous !== false,
      options: input.options.map((text) => ({ text, voter_count: 0 })),
      question: input.question,
      total_voter_count: 0,
      type: "regular",
    },
  })!;
  const projectionCompleted = await dependencies.recordTimeline(ctx, timelineTarget, {
    contentText,
    failureCode: "AGENT_POLL_PROJECTION_FAILED",
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

export function createSendPollTool(dependencies: SendPollDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Start a native Telegram poll in the current chat.",
      "Use it when someone asks for a poll or a vote; write the question and short distinct options.",
      "After the result follow nextStep; on an error follow correction and do not repeat the call.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        return await sendPoll(dependencies, parseInput(rawInput), ctx);
      } catch (error) {
        throw telegramSendFailure(TOOL, error);
      }
    },
  }) as AnyToolDefinition;
}

export default createSendPollTool({
  recordTimeline: recordToolDeliveryInTimeline,
  send: sendTelegramNativeMessage,
});
