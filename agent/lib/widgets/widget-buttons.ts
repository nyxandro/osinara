/**
 * Buttons under a widget card: written into its caption as reply-button markup, sent as its keyboard (#480).
 *
 * Exports:
 * - `WidgetButtons`: the caption without markup, the keyboard and the bookkeeping around the send.
 * - `prepareWidgetButtons`: reads the caption's buttons, checks them and stages their set.
 *
 * Key constructs:
 * - The model writes buttons the way it writes them under an answer, so a widget learns nothing new.
 *   Telegram refuses markup in a media caption, so the buttons go under the card as its keyboard: the
 *   owner's choice F7 of #480, one message with the card and its buttons.
 * - Answer and "read" buttons need the verified person of the chat and a stored set, exactly like an
 *   answer's buttons; link and copy buttons go out by themselves.
 * - A "read" button must name a scenario of this chat: the model gets a correctable error before the
 *   card is sent, instead of a button that would do nothing.
 * - Bookkeeping never costs the card: a set that could not be activated still takes its press.
 */
import type { JsonObject } from "../../runtime/json.js";
import type { ToolContext } from "../../runtime/tool.js";

import { findAgentScheduleSkipTargets } from "../agent-schedules/agent-schedule-skip.js";
import {
  hasAnswerButtons,
  newReplyButtonToken,
  replyButtonLabels,
  skipScheduleIds,
} from "../reply-buttons/reply-button-contract.js";
import { replyButtonTarget } from "../reply-buttons/reply-button-delivery.js";
import { replyButtonKeyboard } from "../reply-buttons/reply-button-keyboard.js";
import { readReplyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";
import { telegramSendInputError } from "../telegram-sends/telegram-send-errors.js";
import { WIDGET_CAPTION_MAX_LENGTH } from "./widget-config.js";

export interface WidgetButtons {
  /** The caption as the card shows it: the markup removed. */
  readonly caption: string;
  /** The buttons' labels, for the history line of the card. */
  readonly labels: readonly string[];
  readonly replyMarkup: JsonObject | null;
  /** The card is in the chat: its buttons are offered. */
  afterDelivery(telegramMessageId: string): Promise<void>;
  /** Telegram refused the card: its buttons never went out. */
  afterRefusal(): Promise<void>;
}

const INVALID_CODE = "AGENT_WIDGET_INPUT_INVALID";
const ONE_MORE_CALL = "Исправь это и вызови send_widget ещё раз один раз; если снова не выйдет, ответь обычным текстом.";

function logFailure(code: string, error: unknown, setId: string): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), setId }));
}

const NO_BOOKKEEPING = {
  async afterDelivery() {
    // Nothing waits for a press: Telegram opens the page or copies the text itself.
  },
  async afterRefusal() {
    // Nothing was staged.
  },
};

export async function prepareWidgetButtons(caption: string, ctx: ToolContext, telegramChatId: string): Promise<WidgetButtons> {
  const reading = readReplyButtonMarkup(caption);
  if (Array.from(reading.markdown).length > WIDGET_CAPTION_MAX_LENGTH) {
    throw telegramSendInputError({
      code: INVALID_CODE,
      correction: `Подпись виджета без разметки кнопок — до ${WIDGET_CAPTION_MAX_LENGTH} символов. Сократи её. ${ONE_MORE_CALL}`,
      reason: "Подпись виджета длиннее допустимого.",
    });
  }
  if (reading.markdown.trim().length === 0) {
    // A caption of buttons alone leaves the card nothing to say where it is not shown.
    throw telegramSendInputError({
      code: INVALID_CODE,
      correction: `Напиши в caption 1-3 строки о карточке до разметки кнопок: что это и факты для действия. ${ONE_MORE_CALL}`,
      reason: "Подпись виджета без кнопок пустая.",
    });
  }
  if (reading.rows === null) {
    if (reading.error === null) return { caption, labels: [], replyMarkup: null, ...NO_BOOKKEEPING };
    throw telegramSendInputError({
      code: INVALID_CODE,
      correction: `Кнопки в подписи виджета: ${reading.error.message}. ${ONE_MORE_CALL}`,
      reason: "Разметка кнопок в подписи виджета не прошла проверку.",
    });
  }
  const rows = reading.rows;
  const labels = replyButtonLabels(rows);
  if (!hasAnswerButtons(rows)) {
    // No press comes back, so no set: the token is never written into a button.
    return { caption: reading.markdown, labels, replyMarkup: replyButtonKeyboard(rows, newReplyButtonToken()), ...NO_BOOKKEEPING };
  }
  const target = replyButtonTarget(ctx.session.auth.current?.attributes, telegramChatId);
  if (target === null) {
    throw telegramSendInputError({
      code: INVALID_CODE,
      correction: `Кнопки-ответы и «прочитано» под виджетом бывают только в личном чате с человеком. Убери их из подписи. ${ONE_MORE_CALL}`,
      reason: "Кнопки этого виджета некому нажать.",
    });
  }
  const named = skipScheduleIds(rows);
  const valid = await findAgentScheduleSkipTargets({ ...target, scheduleIds: named });
  const unknown = named.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw telegramSendInputError({
      code: INVALID_CODE,
      correction: `Кнопка «прочитано» называет сценарий, которого в этом чате нет или который уже не работает: ${unknown.join(", ")}. Возьми id действующего сценария этого чата из manage_agent_schedule list. ${ONE_MORE_CALL}`,
      reason: "Кнопка «прочитано» ссылается на неизвестный сценарий.",
    });
  }
  const set = await replyButtonRepository.stageForWidget({
    ...target,
    buttons: rows,
    caption: reading.markdown,
    token: newReplyButtonToken(),
  });
  return {
    caption: reading.markdown,
    labels,
    replyMarkup: replyButtonKeyboard(set.buttons, set.token),
    async afterDelivery(telegramMessageId) {
      try {
        await replyButtonRepository.activate(set.id, telegramMessageId, []);
      } catch (error) {
        // An unactivated set still takes its press; only a later message of the person keeps it.
        logFailure("AGENT_WIDGET_BUTTONS_ACTIVATION_FAILED", error, set.id);
      }
    },
    async afterRefusal() {
      try {
        await replyButtonRepository.discard(set.id);
      } catch (error) {
        logFailure("AGENT_WIDGET_BUTTONS_DISCARD_FAILED", error, set.id);
      }
    },
  };
}
