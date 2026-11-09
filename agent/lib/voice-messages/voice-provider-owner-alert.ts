/**
 * The owner's message when ElevenLabs refuses for a reason only the owner can fix (#480, F5).
 *
 * Export:
 * - `voiceProviderOwnerAlert`: the incident for one refused voice note, or null when the failure
 *   is not the account's.
 *
 * Key constructs:
 * - One message a day for each cause, keyed by the cause and the UTC date: a scenario that speaks
 *   every hour into an empty balance must not flood the owner.
 * - The cause decides the advice: topping up does not help when the voice needs a paid plan, and
 *   neither does when the key itself is refused.
 */
import type { OperationalIncident } from "../operational-incidents/owner-alerts.js";
import { VoiceMessageProviderError } from "./elevenlabs-speech-client.js";

type AlertCause = "access" | "credits" | "key" | "plan";

const SUMMARIES: Readonly<Record<AlertCause, string>> = {
  access: "ElevenLabs закрыл доступ к нашему голосу или модели озвучки: голосовые сейчас уходят текстом. Проверьте в ElevenLabs доступ к голосу и тариф.",
  credits: "В ElevenLabs закончились кредиты: голосовые сейчас уходят текстом. Пополните баланс или смените тариф ElevenLabs.",
  key: "ElevenLabs отклонил ключ доступа: голосовые сейчас уходят текстом. Проверьте ключ ELEVENLABS_API_KEY и его права в ElevenLabs.",
  plan: "ElevenLabs требует платный тариф для нашего голоса: голосовые сейчас уходят текстом. Оформите платный тариф ElevenLabs.",
};

// ElevenLabs' codes of a refusal that a paid plan, not a top-up, resolves.
const PLAN_CODES = new Set(["paid_plan_required", "payment_required"]);

// A refusal of the voice or the model, not of the key itself (`voice_access_denied`, `model_access_denied`).
const ACCESS_CODE_PATTERN = /voice|model/u;

function causeOf(error: VoiceMessageProviderError): AlertCause | null {
  if (error.code === "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED") {
    return error.providerErrorCode !== null && ACCESS_CODE_PATTERN.test(error.providerErrorCode) ? "access" : "key";
  }
  if (error.code !== "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED") return null;
  return error.providerErrorCode !== null && PLAN_CODES.has(error.providerErrorCode) ? "plan" : "credits";
}

export function voiceProviderOwnerAlert(error: unknown, now: Date): OperationalIncident | null {
  if (!(error instanceof VoiceMessageProviderError)) return null;
  const cause = causeOf(error);
  if (cause === null) return null;
  return {
    code: error.code,
    context: { providerCode: error.providerErrorCode },
    key: `voice-provider:${cause}:${now.toISOString().slice(0, 10)}`,
    summary: SUMMARIES[cause],
  };
}
