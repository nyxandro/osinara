/**
 * Telegram terminal failure notification privacy policy.
 *
 * Exports:
 * - `shouldNotifyTelegramFailure`: permits failure details only in a verified private chat.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

export function shouldNotifyTelegramFailure(
  channel: Pick<TelegramEventContext, "state">,
): boolean {
  // Missing or shared chat metadata fails closed because terminal errors may expose internals.
  return channel.state.chatType === "private";
}
