/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `completedTelegramMessage`: keeps meaningful final or pre-tool model text and hides empty steps.
 * - `visibleTelegramModelText`: removes plain and namespaced MiniMax thinking from Telegram output.
 */
const COMPLETE_THINKING_BLOCK_PATTERN =
  /<(mm:)?think(?:\s[^>]*)?>[\s\S]*?<\/\1think\s*>/giu;
const UNCLOSED_THINKING_BLOCK_PATTERN =
  /<(?:mm:)?think(?:\s[^>]*)?(?:>|$)[\s\S]*$/iu;
const CONTENT_THROUGH_LAST_THINKING_CLOSE_PATTERN =
  /^[\s\S]*<\/(?:mm:)?think\s*>/iu;
const THINKING_OPEN_PREFIXES = ["<mm:think", "<think"] as const;

export function visibleTelegramModelText(message: string): string {
  // MiniMax emits reasoning inside ordinary content, sometimes with only a closing boundary.
  let visible = message
    .replace(COMPLETE_THINKING_BLOCK_PATTERN, "")
    .replace(UNCLOSED_THINKING_BLOCK_PATTERN, "")
    .replace(CONTENT_THROUGH_LAST_THINKING_CLOSE_PATTERN, "");

  // Cumulative Eve drafts can end in a split plain or namespaced opening tag.
  const normalized = visible.toLowerCase();
  for (const prefix of THINKING_OPEN_PREFIXES) {
    for (let length = prefix.length - 1; length > 0; length -= 1) {
      if (!normalized.endsWith(prefix.slice(0, length))) continue;
      visible = visible.slice(0, -length);
      return visible.trim();
    }
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
