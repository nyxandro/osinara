/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `completedTelegramMessage`: keeps meaningful final or pre-tool model text and hides empty steps.
 * - `visibleTelegramModelText`: removes provider-embedded thinking from Telegram output.
 */
const COMPLETE_THINKING_BLOCK_PATTERN =
  /<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/giu;
const UNCLOSED_THINKING_BLOCK_PATTERN = /<think(?:\s[^>]*)?(?:>|$)[\s\S]*$/iu;
const STRAY_THINKING_CLOSE_PATTERN = /<\/think\s*>/giu;
const THINKING_OPEN_PREFIX = "<think";

export function visibleTelegramModelText(message: string): string {
  // MiniMax emits reasoning inside ordinary content, so remove complete and still-streaming blocks.
  let visible = message
    .replace(COMPLETE_THINKING_BLOCK_PATTERN, "")
    .replace(UNCLOSED_THINKING_BLOCK_PATTERN, "")
    .replace(STRAY_THINKING_CLOSE_PATTERN, "");

  // Cumulative Eve drafts can end in a split opening tag such as `<thi`; keep it private too.
  const normalized = visible.toLowerCase();
  for (let length = THINKING_OPEN_PREFIX.length - 1; length > 0; length -= 1) {
    if (!normalized.endsWith(THINKING_OPEN_PREFIX.slice(0, length))) continue;
    visible = visible.slice(0, -length);
    break;
  }
  return visible.trim();
}

export function completedTelegramMessage(data: {
  finishReason: string;
  message?: string | null;
}): string | null {
  const message =
    data.message === undefined || data.message === null
      ? ""
      : visibleTelegramModelText(data.message);
  return message ? message : null;
}
