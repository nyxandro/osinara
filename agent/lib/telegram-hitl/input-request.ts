/**
 * Secure Telegram rendering for Eve HITL input requests.
 *
 * Exports:
 * - `createTelegramInputRequestHandler`: dependency-injected renderer and durable approval binder.
 * - `handleTelegramInputRequested`: production Eve `input.requested` event handler.
 *
 * Key constructs:
 * - A prompt exists only in a private chat: every shared-chat request, including a session-budget
 *   continuation, fails before parking or Telegram delivery.
 */
import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  type TelegramChatType,
  type TelegramEventContext,
} from "eve/channels/telegram";
import type { InputRequestKind } from "eve/client";
import type { SessionContext } from "eve/context";

import {
  localizeTelegramReplyMarkup,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import { AppError } from "../app-error.js";
import { memoryOperationHash } from "../memory-record.js";
import {
  applicationSessionId,
  registerTelegramDeliveredMessageRoutes,
} from "../sessions/session-context.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramTurnReplyParameters } from "../telegram-reply.js";
import { postTelegramMessageWithoutContinuationChange } from "../telegram-stable-delivery.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./approval-repository.js";
import {
  presentTelegramApproval,
  type TelegramApprovalPresenter,
} from "./approval-presentation.js";

interface InputRequestedData {
  requests: ReadonlyArray<TelegramInputRequest & { kind: InputRequestKind }>;
}

interface InputRequestDependencies {
  approvals: Pick<TelegramHitlApprovalRepository, "register">;
  parkSession(input: {
    applicationSessionId: string;
    pendingRequestId: string | null;
    requesterTelegramUserId: string;
    requesterUserId: string | null;
  }): Promise<void>;
  present: TelegramApprovalPresenter;
  registerMessageRoutes(
    channel: TelegramEventContext,
    ctx: Pick<SessionContext, "session">,
    messageIds: readonly string[],
  ): Promise<void>;
}

const HITL_PREPARING_MESSAGE = "Подготавливаю безопасный запрос подтверждения.";
const HITL_PROMPT_CHUNK_CHARACTERS = 3_000;
const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

function toTelegramJson(value: unknown): TelegramJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) return value;
  if (Array.isArray(value)) return value.map(toTelegramJson);
  if (typeof value !== "object") {
    throw new AppError(
      "AGENT_APPROVAL_MARKUP_INVALID",
      "Не удалось подготовить безопасные кнопки подтверждения",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toTelegramJson(item)]),
  );
}

function callbackData(replyMarkup: Readonly<Record<string, unknown>> | undefined): string[] {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return row.flatMap((button) => {
      if (!button || typeof button !== "object") return [];
      const value = (button as Record<string, unknown>).callback_data;
      return typeof value === "string" ? [value] : [];
    });
  });
}

function callbackOptions(
  request: TelegramInputRequest,
  callbacks: readonly string[],
): Array<{ callbackData: string; label: string; optionId: string }> {
  const options = request.options ?? [];
  if (callbacks.length !== options.length) {
    throw new AppError(
      "AGENT_APPROVAL_MARKUP_INVALID",
      "Не удалось связать кнопки с вариантами подтверждения",
    );
  }
  return options.map((option, index) => ({
    callbackData: callbacks[index]!,
    label: option.label,
    optionId: option.id,
  }));
}

function splitPrompt(prompt: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < prompt.length) {
    let end = Math.min(offset + HITL_PROMPT_CHUNK_CHARACTERS, prompt.length);
    // Keep UTF-16 surrogate pairs intact because Telegram rejects malformed text payloads.
    if (end < prompt.length && /[\uD800-\uDBFF]/u.test(prompt[end - 1]!)) end -= 1;
    chunks.push(prompt.slice(offset, end));
    offset = end;
  }
  return chunks.length === 0 ? [""] : chunks;
}

function numberedPromptChunk(chunk: string, index: number, total: number): string {
  return total === 1 ? chunk : `Часть ${index + 1} из ${total}\n\n${chunk}`;
}

const SESSION_LIMIT_CHAT_NOTICE =
  "Задача оказалась слишком длинной для одного хода, и продолжить её в общем чате нельзя. Разбейте запрос на части и отправьте заново.";

/**
 * Returns the refusal for a prompt this chat cannot carry, or null when it may be shown.
 *
 * A refused tool approval reaches the model as a tool denial, which it explains itself. A session
 * budget is authored by Eve outside the tool surface, so nothing would reach the chat at all: that
 * one refusal carries a plain notice the caller delivers before ending the turn.
 */
function sharedChatInputRefusal(
  data: InputRequestedData,
  chatType: TelegramChatType,
  ctx: Pick<SessionContext, "session">,
): { chatNotice?: string; error: AppError } | null {
  // Authorizing an action belongs to one accountable person, so an approval and a session budget
  // exist only in a private chat. A plain question authorizes nothing and stays available to the
  // family group, where the participants are the verified family; an external group is public and
  // receives no prompt at all. Eve authors some requests outside the tool surface, so descriptor
  // denials cannot stop them and this boundary is the only one that can.
  const groupType = ctx.session.auth.current?.attributes.groupType;
  if (chatType === "private" && groupType === undefined) return null;
  if (groupType === "family_private" && data.requests.every((request) => request.kind === "question")) {
    return null;
  }

  const requestsSessionBudget = data.requests.some((request) =>
    request.kind === "session-limit" ||
    request.action.toolName === SESSION_LIMIT_CONTINUATION_TOOL_NAME
  );
  if (requestsSessionBudget) {
    return {
      chatNotice: SESSION_LIMIT_CHAT_NOTICE,
      error: new AppError(
        "AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN",
        "Агент остановил слишком длинную задачу в общем чате. Разбейте запрос на части и отправьте его заново",
      ),
    };
  }
  return {
    error: new AppError(
      "AGENT_EXTERNAL_APPROVAL_FORBIDDEN",
      "В общем чате нельзя запрашивать подтверждение. Напишите агенту в личные сообщения",
    ),
  };
}

export function createTelegramInputRequestHandler(dependencies: InputRequestDependencies) {
  return async function handleInputRequested(
    data: InputRequestedData,
    channel: TelegramEventContext,
    ctx: Pick<SessionContext, "session">,
  ): Promise<void> {
    const appSessionId = applicationSessionId(ctx);
    const caller = ctx.session.auth.current;
    const telegramUserId = caller?.attributes.telegramUserId;
    const chatId = channel.state.chatId;
    // A scheduled run opens its session before any Telegram response, so the channel has not
    // anchored a chat type yet. The stored schedule already carries the verified one, and it is
    // admitted only for the same chat the channel is about to post into.
    const attributeChatType = caller?.attributes.telegramChatType;
    const chatType = channel.state.chatType ??
      (caller?.attributes.telegramChatId === chatId && typeof attributeChatType === "string"
        ? attributeChatType
        : undefined);
    if (
      caller?.authenticator !== "telegram" ||
      typeof telegramUserId !== "string" ||
      !chatId ||
      (chatType !== "group" && chatType !== "private" && chatType !== "supergroup")
    ) {
      throw new AppError(
        "AGENT_APPROVAL_CONTEXT_INVALID",
        "Не удалось безопасно привязать подтверждение к пользователю Telegram",
      );
    }

    const firstRequest = data.requests[0];
    if (!firstRequest) {
      throw new AppError(
        "AGENT_APPROVAL_REQUEST_MISSING",
        "Eve не передал запрос, который нужно показать пользователю",
      );
    }

    // Policy is evaluated before semantic presentation, session parking, persistence, or approval
    // I/O. Only a plain notice may precede the refusal, and it binds nothing.
    const refusal = sharedChatInputRefusal(data, chatType, ctx);
    if (refusal) {
      if (refusal.chatNotice !== undefined) {
        await postTelegramMessageWithoutContinuationChange(channel, refusal.chatNotice);
      }
      throw refusal.error;
    }

    // Resolve trusted semantic subjects before parking so presentation failures remain recoverable.
    const localizedRequests: Array<{
      kind: InputRequestKind;
      request: TelegramInputRequest;
    }> = [];
    for (const request of data.requests) {
      localizedRequests.push({
        kind: request.kind,
        request: await dependencies.present(request, ctx),
      });
    }
    await dependencies.parkSession({
      applicationSessionId: appSessionId,
      pendingRequestId: firstRequest.requestId,
      requesterTelegramUserId: telegramUserId,
      requesterUserId: UUID_PATTERN.test(caller.principalId) ? caller.principalId : null,
    });
    for (const { kind, request: localizedRequest } of localizedRequests) {
      const promptChunks = splitPrompt(localizedRequest.prompt);
      const finalChunkIndex = promptChunks.length - 1;
      const rendered = renderTelegramInputRequest({
        ...localizedRequest,
        kind,
        prompt: numberedPromptChunk(
          promptChunks[finalChunkIndex]!,
          finalChunkIndex,
          promptChunks.length,
        ),
      }, channel.state);
      const replyMarkup = localizeTelegramReplyMarkup(rendered.replyMarkup);
      const callbacks = callbackData(replyMarkup);
      const options = callbackOptions(localizedRequest, callbacks);
      const replyParameters = telegramTurnReplyParameters(channel.state, ctx);

      // Long semantic prompts are sent in full before the final actionable message. No earlier
      // chunk carries callbacks, so the user cannot approve before seeing every material value.
      const detailMessageIds: string[] = [];
      for (let index = 0; index < finalChunkIndex; index += 1) {
        detailMessageIds.push(await postTelegramMessageWithoutContinuationChange(channel, {
          ...(index === 0 && replyParameters !== undefined
            ? { reply_parameters: replyParameters }
            : {}),
          text: numberedPromptChunk(promptChunks[index]!, index, promptChunks.length),
        }));
      }

      // The actionable prompt is revealed only after both the route and approver binding are durable.
      const sentMessageId = await postTelegramMessageWithoutContinuationChange(channel, {
        ...(callbacks.length === 0 ? { reply_markup: replyMarkup } : {}),
        ...(detailMessageIds.length > 0 || replyParameters === undefined
          ? {}
          : { reply_parameters: replyParameters }),
        text: HITL_PREPARING_MESSAGE,
      });
      // Exact prompt ownership is required for both interactive and scheduled callback/reply claims.
      await dependencies.registerMessageRoutes(channel, ctx, [...detailMessageIds, sentMessageId]);
      await dependencies.approvals.register({
        kind,
        applicationSessionId: appSessionId,
        callbackData: callbacks,
        callbackOptions: options,
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
        requestId: localizedRequest.requestId,
        promptText: localizedRequest.prompt,
        telegramChatId: chatId,
        telegramChatType: chatType,
        telegramMessageId: sentMessageId,
        telegramMessageThreadId: channel.state.messageThreadId === null
          ? null
          : String(channel.state.messageThreadId),
        telegramUserId,
        toolCallId: localizedRequest.action.callId,
        toolInputHash: memoryOperationHash(localizedRequest.action.input),
        toolName: localizedRequest.action.toolName,
      });
      if (rendered.freeformRequestId) {
        registerTelegramFreeformPrompt(channel.state, {
          messageId: sentMessageId,
          requestId: rendered.freeformRequestId,
        });
      }
      const edited = await channel.telegram.request("editMessageText", {
        chat_id: chatId,
        message_id: Number(sentMessageId),
        ...(channel.state.messageThreadId === null
          ? {}
          : { message_thread_id: channel.state.messageThreadId }),
        ...(callbacks.length > 0 ? { reply_markup: toTelegramJson(replyMarkup) } : {}),
        text: rendered.text,
      });
      if (!edited.ok) {
        throw new AppError(
          "AGENT_APPROVAL_MESSAGE_EDIT_FAILED",
          "Telegram не показал подготовленный запрос подтверждения. Повторите действие",
        );
      }
    }
  };
}

export const handleTelegramInputRequested = createTelegramInputRequestHandler({
  approvals: telegramHitlApprovalRepository,
  parkSession: (input) => sessionRepository.parkSession(input),
  present: presentTelegramApproval,
  registerMessageRoutes: registerTelegramDeliveredMessageRoutes,
});
