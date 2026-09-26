/**
 * ElevenLabs text-to-speech transport for outbound Telegram voice messages.
 *
 * Exports:
 * - `ELEVENLABS_TTS_MODEL_ID`, `ELEVENLABS_VOICE_ID`, `VOICE_MESSAGE_TEXT_MAX_LENGTH`: pinned synthesis contract.
 * - `VOICE_MESSAGE_MEDIA_TYPE`: the exact media type Telegram receives as a voice note.
 * - `VoiceMessageProviderError`: application error that states whether credits may have been spent.
 * - `createElevenLabsSpeechClient`: dependency-injected, no-retry client.
 * - `elevenLabsSpeechClient`: production client bound to `ELEVENLABS_API_KEY`.
 *
 * Key constructs:
 * - One call maps to one billable synthesis; nothing here repeats a request.
 * - A received 4xx proves the provider refused the synthesis. Transport loss, 5xx and a malformed
 *   success may follow a charged generation, so they are reported as ambiguous.
 */
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

export const ELEVENLABS_TTS_MODEL_ID = "eleven_v3";
// "Сколько сколько?": the owner's own Voice Design voice, a grumpy, sharp-tongued old woman
// speaking Russian. ElevenLabs recommends designed voices over professional clones for Eleven v3.
export const ELEVENLABS_VOICE_ID = "usNkuLTgU7ioKdrKSs3V";
// Eleven v3 accepts at most 5,000 characters in one request.
export const VOICE_MESSAGE_TEXT_MAX_LENGTH = 5_000;
export const VOICE_MESSAGE_MEDIA_TYPE = "audio/ogg; codecs=opus";

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io";
// Ogg Opus is the container Telegram renders as a voice note without transcoding.
const ELEVENLABS_OUTPUT_FORMAT = "opus_48000_64";
// Eleven v3 stability runs from 0 Creative through 0.5 Natural to 1 Robust. The owner chose 0.2:
// close to Creative, which reacts most strongly to audio tags, while keeping some of Natural's
// resistance to the hallucinated sounds and words ElevenLabs warns full Creative produces.
const ELEVENLABS_V3_STABILITY = 0.2;
// A full 5,000-character v3 request is a few minutes of speech and needs well under a minute.
const ELEVENLABS_TTS_TIMEOUT_MS = 120_000;
// 64 kbit/s Opus for the longest request stays near 4 MB; anything far beyond is not our audio.
const ELEVENLABS_AUDIO_RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
// An exhausted balance arrives as 402 `insufficient_credits` today and as 401 with the legacy
// `quota_exceeded` status on older API paths; a library voice on the free plan is 402
// `paid_plan_required`. The body decides, because the 401 status alone reads as a bad key.
const PAYMENT_PROVIDER_CODES = new Set([
  "insufficient_credits",
  "paid_plan_required",
  "payment_required",
  "quota_exceeded",
]);

export type VoiceMessageProviderOutcome = "ambiguous" | "definitive";

export class VoiceMessageProviderError extends AppError {
  readonly outcome: VoiceMessageProviderOutcome;

  constructor(code: string, message: string, outcome: VoiceMessageProviderOutcome) {
    super(code, message);
    this.name = "VoiceMessageProviderError";
    this.outcome = outcome;
  }
}

export interface SynthesizedSpeech {
  bytes: Buffer;
  characterCost: number | null;
  mediaType: typeof VOICE_MESSAGE_MEDIA_TYPE;
}

interface ElevenLabsSpeechClientOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
}

interface ProviderErrorBody {
  detail?: { code?: unknown; request_id?: unknown; status?: unknown };
}

interface ProviderErrorDetail {
  providerErrorCode: string | null;
  providerErrorStatus: string | null;
  requestId: string | null;
}

const DEFINITIVE_STATUS_ERRORS: Readonly<Record<number, readonly [string, string]>> = {
  401: [
    "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED",
    "Сервис озвучки ElevenLabs отклонил ключ доступа. Владельцу нужно проверить ключ ElevenLabs",
  ],
  402: [
    "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
    "В ElevenLabs закончились кредиты или для голоса нужен платный тариф. Владельцу нужно проверить подписку ElevenLabs",
  ],
  403: [
    "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED",
    "Сервис озвучки ElevenLabs запретил доступ к голосу или модели. Владельцу нужно проверить ключ и тариф ElevenLabs",
  ],
  429: [
    "AGENT_VOICE_MESSAGE_PROVIDER_RATE_LIMITED",
    "Сервис озвучки ElevenLabs временно ограничил число запросов. Попробуйте попросить голосовое позже",
  ],
};

const PAYMENT_REQUIRED_ERROR = DEFINITIVE_STATUS_ERRORS[402]!;

const REJECTED_ERROR = [
  "AGENT_VOICE_MESSAGE_PROVIDER_REJECTED",
  "Сервис озвучки ElevenLabs отклонил запрос на озвучку",
] as const;

function providerError(code: string, message: string, outcome: VoiceMessageProviderOutcome) {
  return new VoiceMessageProviderError(code, message, outcome);
}

function missingConfiguration(): VoiceMessageProviderError {
  return providerError(
    "AGENT_VOICE_MESSAGE_CONFIG_MISSING",
    "Голосовые сообщения не настроены: владелец ещё не задал ключ ElevenLabs",
    "definitive",
  );
}

function invalidResponse(reason: string): VoiceMessageProviderError {
  console.error(JSON.stringify({ code: "AGENT_VOICE_MESSAGE_PROVIDER_RESPONSE_INVALID", reason }));
  return providerError(
    "AGENT_VOICE_MESSAGE_PROVIDER_RESPONSE_INVALID",
    "Сервис озвучки ElevenLabs вернул аудио, которое нельзя отправить голосовым",
    "ambiguous",
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function providerErrorDetail(response: Response): Promise<ProviderErrorDetail> {
  try {
    const body = await response.json() as ProviderErrorBody;
    return {
      providerErrorCode: stringOrNull(body.detail?.code),
      providerErrorStatus: stringOrNull(body.detail?.status),
      requestId: stringOrNull(body.detail?.request_id),
    };
  } catch {
    // The HTTP status alone already classifies the failure; an unreadable body only loses detail.
    return {
      providerErrorCode: null,
      providerErrorStatus: null,
      requestId: response.headers.get("request-id"),
    };
  }
}

function classifyRejection(status: number, detail: ProviderErrorDetail): readonly [string, string] {
  const paymentRequired = [detail.providerErrorCode, detail.providerErrorStatus]
    .some((code) => code !== null && PAYMENT_PROVIDER_CODES.has(code));
  if (paymentRequired) return PAYMENT_REQUIRED_ERROR;
  return DEFINITIVE_STATUS_ERRORS[status] ?? REJECTED_ERROR;
}

async function readBoundedAudio(response: Response): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > ELEVENLABS_AUDIO_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw invalidResponse("declared audio length exceeds the limit");
  }
  if (!response.body) throw invalidResponse("success response has no body");

  // Read incrementally so an absent or wrong Content-Length cannot bypass the hard cap.
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > ELEVENLABS_AUDIO_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw invalidResponse("audio stream exceeds the limit");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}

// Delivery sniffs the stored file with the same detector, so accepted audio is always sendable.
async function assertOggOpus(bytes: Buffer): Promise<void> {
  if (bytes.byteLength === 0) throw invalidResponse("audio is empty");
  const detected = await fileTypeFromBuffer(bytes);
  if (detected?.mime !== VOICE_MESSAGE_MEDIA_TYPE) {
    throw invalidResponse(`audio is ${detected?.mime ?? "unrecognized"}, not Ogg Opus`);
  }
}

async function readSpeech(response: Response): Promise<Buffer> {
  try {
    const bytes = await readBoundedAudio(response);
    await assertOggOpus(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof VoiceMessageProviderError) throw error;
    // The synthesis was already accepted, so a body lost mid-download may have been charged.
    console.error(JSON.stringify({
      code: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
      errorName: error instanceof Error ? error.name : "UnknownError",
      model: ELEVENLABS_TTS_MODEL_ID,
      stage: "audio_download",
    }));
    throw providerError(
      "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
      "Сервис озвучки ElevenLabs не ответил вовремя",
      "ambiguous",
    );
  }
}

// An absent or malformed header means the cost is unknown, never that the synthesis was free.
function characterCost(response: Response): number | null {
  const header = response.headers.get("character-cost")?.trim();
  if (!header || !/^[0-9]+$/u.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

export function createElevenLabsSpeechClient(options: ElevenLabsSpeechClientOptions) {
  function requireApiKey(): string {
    const apiKey = options.apiKey;
    if (!apiKey || /\s/u.test(apiKey)) throw missingConfiguration();
    return apiKey;
  }

  return {
    assertConfigured(): void {
      requireApiKey();
    },

    async synthesize(text: string): Promise<SynthesizedSpeech> {
      const apiKey = requireApiKey();
      const url = new URL(`/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, ELEVENLABS_API_BASE_URL);
      url.searchParams.set("output_format", ELEVENLABS_OUTPUT_FORMAT);

      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          body: JSON.stringify({
            model_id: ELEVENLABS_TTS_MODEL_ID,
            text,
            voice_settings: { stability: ELEVENLABS_V3_STABILITY },
          }),
          headers: { "content-type": "application/json", "xi-api-key": apiKey },
          method: "POST",
          signal: AbortSignal.timeout(ELEVENLABS_TTS_TIMEOUT_MS),
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
          errorName: error instanceof Error ? error.name : "UnknownError",
          model: ELEVENLABS_TTS_MODEL_ID,
        }));
        throw providerError(
          "AGENT_VOICE_MESSAGE_PROVIDER_STATUS_UNKNOWN",
          "Сервис озвучки ElevenLabs не ответил вовремя",
          "ambiguous",
        );
      }

      if (!response.ok) {
        const detail = await providerErrorDetail(response);
        const definitive = response.status >= 400 && response.status < 500;
        const [code, message] = definitive
          ? classifyRejection(response.status, detail)
          : [
            "AGENT_VOICE_MESSAGE_PROVIDER_UNAVAILABLE",
            "Сервис озвучки ElevenLabs сейчас не работает",
          ];
        console.error(JSON.stringify({
          code,
          model: ELEVENLABS_TTS_MODEL_ID,
          providerErrorCode: detail.providerErrorCode,
          providerErrorStatus: detail.providerErrorStatus,
          providerStatus: response.status,
          requestId: detail.requestId,
        }));
        throw providerError(code, message, definitive ? "definitive" : "ambiguous");
      }

      const bytes = await readSpeech(response);
      return { bytes, characterCost: characterCost(response), mediaType: VOICE_MESSAGE_MEDIA_TYPE };
    },
  };
}

function productionClient(): ReturnType<typeof createElevenLabsSpeechClient> {
  return createElevenLabsSpeechClient({ apiKey: process.env.ELEVENLABS_API_KEY });
}

// The credential is read per call, like other optional integrations, so a missing key disables
// only this tool with an explicit error instead of blocking the whole agent at startup.
export const elevenLabsSpeechClient = {
  assertConfigured(): void {
    productionClient().assertConfigured();
  },
  synthesize(text: string): Promise<SynthesizedSpeech> {
    return productionClient().synthesize(text);
  },
};
