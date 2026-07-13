/**
 * Telegram delivery policy for completed model messages.
 *
 * Export:
 * - `completedTelegramMessage`: keeps meaningful final or pre-tool model text and hides empty steps.
 */
export function completedTelegramMessage(data: {
  finishReason: string;
  message?: string | null;
}): string | null {
  const message = data.message?.trim();
  return message ? message : null;
}
