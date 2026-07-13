/**
 * Trusted Telegram delivery adapter.
 *
 * Exports:
 * - `deliverFamilyInvitation`: sends a one-time invitation without model exposure.
 */
import { sendTelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";

interface FamilyInvitationDelivery {
  chatId: string;
  code: string;
  expiresAt: string;
  signal: AbortSignal;
}

function requireTelegramDeliveryConfig(): { botToken: string; botUsername: string } {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!botToken || !botUsername) {
    throw new Error(
      "AGENT_TELEGRAM_CONFIG_MISSING: Не заданы настройки Telegram для доставки приглашения",
    );
  }
  return { botToken, botUsername };
}

export async function deliverFamilyInvitation(input: FamilyInvitationDelivery): Promise<void> {
  const { botToken, botUsername } = requireTelegramDeliveryConfig();
  const startLink = `https://t.me/${botUsername}?start=${encodeURIComponent(input.code)}`;

  // The token is sent directly to the verified owner chat and is never returned as tool output.
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS),
  ]);
  const fetchWithSignal: typeof fetch = (request, init) =>
    fetch(request, {
      ...init,
      signal,
    });

  // Eve owns Telegram request construction while this adapter owns cancellation and secret handling.
  try {
    await sendTelegramMessage({
      body: {
        text: [
          "Одноразовое приглашение в семейного агента:",
          startLink,
          `Действует до ${input.expiresAt}.`,
        ].join("\n"),
      },
      chatId: input.chatId,
      credentials: { botToken },
      fetch: fetchWithSignal,
    });
  } catch (error) {
    // Preserve the original transport error while adding safe structured diagnostics and a stable code.
    console.error(
      JSON.stringify({
        code: "AGENT_TELEGRAM_INVITATION_DELIVERY_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        providerMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    if (error instanceof Error) {
      error.message =
        "AGENT_TELEGRAM_INVITATION_DELIVERY_FAILED: Не удалось связаться с Telegram. Попробуйте еще раз";
    }
    throw error;
  }
}
