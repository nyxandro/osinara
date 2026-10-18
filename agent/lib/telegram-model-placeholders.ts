/**
 * Texts the Telegram boundary puts into the model's message in place of words a person did not write.
 *
 * Export:
 * - `CAPTIONLESS_ATTACHMENT_MODEL_TEXT`: what the model reads for a file sent without a caption.
 *
 * Shared with memory so that the placeholder is recognised as no question at all: from 2026-10-09
 * to 2026-10-16 memory was searched by it twice and brought eight unrelated records each time.
 */
export const CAPTIONLESS_ATTACHMENT_MODEL_TEXT = "Пользователь отправил файл без подписи.";
