/**
 * Telegram buttons for approvals that wait for a person.
 *
 * Exports:
 * - `renderTelegramInputRequest`: the prompt text and its buttons; every button gets a short
 *   callback id stored in the channel state.
 * - `telegramCallbackInputResponse`, `isTelegramSyntheticResponse`, `resolveTelegramInputResponses`:
 *   a pressed button, mapped back to the request it answers.
 * - `TELEGRAM_HITL_CALLBACK_PREFIX`, `isTelegramHitlCallback`: the prefix of the runtime's callback
 *   data, and whether a pressed button is one of its cards.
 *
 * The callback ids continue the per-conversation counter (`nextHitlCallbackId`), so a button still
 * visible in a chat never maps to a new request.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { InputRequest, InputResponse } from "../hitl/types.js";
import type { TelegramHitlState } from "./channel-types.js";

export const TELEGRAM_HITL_CALLBACK_PREFIX = "hitl:";

export function isTelegramHitlCallback(data: string | undefined): data is string {
  return data !== undefined && data.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX);
}

/** Synthetic request id prefix sent through `send()` for callback queries. */
export const TELEGRAM_CALLBACK_RESPONSE_PREFIX = "telegram_callback:";

const TELEGRAM_BUTTON_LABEL_MAX_LENGTH = 64;
const TELEGRAM_PROMPT_MAX_LENGTH = 4000;
const TELEGRAM_INLINE_ROW_SIZE = 2;


/** Rendered Telegram message body for one pending approval: its text and inline keyboard. */
export interface TelegramInputRequestMessage {
  readonly replyMarkup: Readonly<Record<string, unknown>>;
  readonly text: string;
}

/** Renders one `InputRequest` as a Telegram inline keyboard. */
export function renderTelegramInputRequest(
  request: InputRequest,
  state: TelegramHitlState,
): TelegramInputRequestMessage {
  const buttons = request.options.map((option) => ({
    callback_data: registerTelegramCallback(state, {
      optionId: option.id,
      requestId: request.requestId,
    }),
    text: truncate(option.label, TELEGRAM_BUTTON_LABEL_MAX_LENGTH),
  }));
  return {
    replyMarkup: {
      inline_keyboard: chunk(buttons, TELEGRAM_INLINE_ROW_SIZE),
    },
    text: truncate(request.prompt, TELEGRAM_PROMPT_MAX_LENGTH),
  };
}

/**
 * Wraps Telegram callback data as a synthetic `InputResponse` (requestId prefixed
 * with `telegram_callback:`, optionId hardcoded to `"selected"`). It is a
 * placeholder; {@link resolveTelegramInputResponses} resolves it back to the real
 * stored response.
 */
export function telegramCallbackInputResponse(callbackData: string): InputResponse {
  return {
    optionId: "selected",
    requestId: `${TELEGRAM_CALLBACK_RESPONSE_PREFIX}${callbackData}`,
  };
}

/** True when an input response needs Telegram-specific durable-state remapping. */
export function isTelegramSyntheticResponse(response: InputResponse): boolean {
  return response.requestId.startsWith(TELEGRAM_CALLBACK_RESPONSE_PREFIX);
}

/** Remaps compact Telegram callback ids into the input responses they stand for. */
export function resolveTelegramInputResponses(
  state: TelegramHitlState,
  responses: readonly InputResponse[],
): InputResponse[] {
  const resolved: InputResponse[] = [];

  for (const response of responses) {
    if (response.requestId.startsWith(TELEGRAM_CALLBACK_RESPONSE_PREFIX)) {
      const callbackData = response.requestId.slice(TELEGRAM_CALLBACK_RESPONSE_PREFIX.length);
      const mapped = state.hitlCallbacks?.[callbackData];
      if (mapped !== undefined) {
        resolved.push(mapped);
        delete state.hitlCallbacks?.[callbackData];
      }
      continue;
    }

    resolved.push(response);
  }

  return resolved;
}

function registerTelegramCallback(state: TelegramHitlState, response: InputResponse): string {
  const next = state.nextHitlCallbackId ?? 0;
  state.nextHitlCallbackId = next + 1;
  const callbackData = `${TELEGRAM_HITL_CALLBACK_PREFIX}${next.toString(36)}`;
  state.hitlCallbacks = {
    ...state.hitlCallbacks,
    [callbackData]: response,
  };
  return callbackData;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
