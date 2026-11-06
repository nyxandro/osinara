/**
 * The widget methods of Bot API 10.4 other than sending: changing a widget's shared state and answering
 * a press.
 *
 * Exports:
 * - `WidgetTelegram`: the two calls, injectable in tests.
 * - `widgetTelegram`: the production calls, on the widget methods' address.
 *
 * Key constructs:
 * - Both methods answered only on Telegram's beta address on 06.11.2026 (`widget-config.ts`).
 * - An edit that changes nothing is refused with "message is not modified", as `editMessageText` is;
 *   the widget already shows that state, so it counts as done.
 * - A press answer only lets the widget show the outcome; an expired press (`QUERY_ID_INVALID`, after
 *   15 s) or another failure is logged by the caller and changes nothing that was decided.
 * - Both calls have a time limit: Telegram waits 15 s for a press's answer, and an update holds the
 *   widget's row lock, which every press of that widget waits for.
 */
import { callTelegramApi, resolveTelegramBotToken } from "../../runtime/telegram/api.js";

import { AppError } from "../app-error.js";
import { TELEGRAM_WIDGET_API_BASE_URL } from "./widget-config.js";

const ANSWER_TIMEOUT_MS = 5_000;
const EDIT_TIMEOUT_MS = 8_000;

export interface WidgetTelegram {
  answerQuery(input: { readonly data: string; readonly widgetQueryId: string }): Promise<void>;
  editPublicData(input: { readonly chatId: string; readonly messageId: string; readonly publicData: string }): Promise<void>;
}

function description(body: unknown): string {
  const value = body !== null && typeof body === "object" ? (body as { description?: unknown }).description : undefined;
  return typeof value === "string" ? value : "";
}

async function call(method: string, body: Record<string, string | number>, timeoutMs: number): Promise<{ ok: boolean; description: string; status: number }> {
  const botToken = await resolveTelegramBotToken(process.env.TELEGRAM_BOT_TOKEN);
  const response = await callTelegramApi({
    apiBaseUrl: TELEGRAM_WIDGET_API_BASE_URL,
    body,
    botToken,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    method,
  });
  return { description: description(response.body), ok: response.ok, status: response.status };
}

export const widgetTelegram: WidgetTelegram = {
  async answerQuery(input) {
    const result = await call("answerWidgetQuery", { data: input.data, widget_query_id: input.widgetQueryId }, ANSWER_TIMEOUT_MS);
    if (!result.ok) {
      throw new AppError("AGENT_WIDGET_QUERY_ANSWER_FAILED", "Telegram не принял ответ на нажатие в виджете", {
        details: { description: result.description, providerStatus: result.status },
      });
    }
  },

  async editPublicData(input) {
    const result = await call("editMessageWidgetData", {
      chat_id: input.chatId,
      message_id: Number(input.messageId),
      public_data: input.publicData,
    }, EDIT_TIMEOUT_MS);
    if (result.ok || /message is not modified/iu.test(result.description)) return;
    throw new AppError("AGENT_WIDGET_UPDATE_FAILED", "Telegram не принял обновление виджета", {
      details: { description: result.description, providerStatus: result.status },
    });
  },
};
