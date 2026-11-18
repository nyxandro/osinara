/**
 * Tools that send something to the chat themselves, outside the turn's final message (#480, #519).
 *
 * Export:
 * - `CHAT_SEND_TOOL_NAMES`: a scenario gets them as its live chat has them; a background task's report
 *   that called one may already have reached the chat, so it is never told again.
 */
export const CHAT_SEND_TOOL_NAMES = ["send_contact", "send_gif", "send_location", "send_poll", "send_voice_message", "send_widget"] as const;
