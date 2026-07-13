/**
 * Deterministic prohibited-memory content policy.
 *
 * Export:
 * - `requireAllowedMemoryContent`: rejects recognizable secrets and payment card numbers.
 */
import { AppError } from "./app-error.js";
import { MEMORY_CONTENT_MAX_LENGTH } from "./memory-config.js";

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const CREDENTIAL_LABEL_PATTERN =
  /(?:парол(?:ь|я)|password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|секрет(?:ный)? ключ)\s*[:=]\s*\S+/i;
const PROVIDER_TOKEN_PATTERN = /\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/;
const ONE_TIME_CODE_PATTERN =
  /(?:одноразов(?:ый|ого) код|код подтверждения|verification code|one[- ]time code|otp)\D{0,8}\d{4,10}\b/i;
const CARD_CANDIDATE_PATTERN = /(?:\d[ -]?){13,19}/g;

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function requireAllowedMemoryContent(content: string): string {
  const normalized = content.trim();
  if (!normalized || normalized.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_MEMORY_CONTENT_INVALID",
      `Текст памяти должен содержать от 1 до ${MEMORY_CONTENT_MAX_LENGTH} символов`,
    );
  }

  // Reject rather than redact: partial secret storage would be misleading and difficult to erase safely.
  const cardCandidates = normalized.match(CARD_CANDIDATE_PATTERN) ?? [];
  const prohibited =
    PRIVATE_KEY_PATTERN.test(normalized) ||
    CREDENTIAL_LABEL_PATTERN.test(normalized) ||
    PROVIDER_TOKEN_PATTERN.test(normalized) ||
    ONE_TIME_CODE_PATTERN.test(normalized) ||
    cardCandidates.some(passesLuhn);
  if (prohibited) {
    throw new AppError(
      "AGENT_MEMORY_CONTENT_FORBIDDEN",
      "Эту информацию нельзя сохранять в памяти. Используйте защищённое хранилище для секретов",
    );
  }
  return normalized;
}
