/** Bounds for messages shown to a running turn; they are appended to one tool result at a time. */
export const TURN_INTERJECTION_MAX_MESSAGES = 10;
// Waiting messages the bot will not show (not addressed to it, commands) must not fill the window.
export const TURN_INTERJECTION_CANDIDATE_LIMIT = 50;
// Each transcription holds the finished tool result back until Groq answers.
export const TURN_INTERJECTION_MAX_TRANSCRIPTIONS_PER_CALL = 2;
// A Telegram text is at most 4096 characters; a voice transcript can be longer.
export const TURN_INTERJECTION_MAX_TEXT_CHARACTERS = 4_000;
