/**
 * Putting out a pressed button that the application will not act on.
 *
 * Export:
 * - `answerCallbackQuietly`: answers the callback query without any text; never rejects.
 *
 * A button in a group the application does not work for — never registered or disconnected — does
 * nothing, but Telegram keeps showing the presser a waiting indicator until the query is answered.
 * Telegram refuses an answer to a query that is too old; that is expected for old buttons and only noted.
 */
import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { callTelegramApi } from "../runtime/telegram/api.js";

export async function answerCallbackQuietly(callbackQueryId: string): Promise<void> {
  try {
    const response = await callTelegramApi({
      body: { callback_query_id: callbackQueryId },
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
      method: "answerCallbackQuery",
    });
    if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
  } catch (error) {
    console.info(JSON.stringify({
      code: "AGENT_TELEGRAM_QUIET_CALLBACK_ANSWER_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
