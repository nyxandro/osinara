/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `completedTelegramMessage`: keeps meaningful final or pre-tool model text and hides empty steps.
 *
 * MiniMax reasoning is separated by `minimax-model.ts`; Eve routes reasoning parts
 * to dedicated events that this delivery policy never receives.
 */
export function completedTelegramMessage(data: {
  finishReason: string;
  message?: string | null;
}): string | null {
  const message =
    data.message === undefined || data.message === null ? "" : data.message.trim();
  return message ? message : null;
}
