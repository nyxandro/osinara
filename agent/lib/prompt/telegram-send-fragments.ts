/**
 * How the model sends a place or a poll to the chat.
 *
 * Export:
 * - `PLACE_AND_POLL_RULES`: when to use `send_location` and `send_poll`, where coordinates come
 *   from, and how the sent message stands in the answer.
 *
 * Key construct:
 * - Only a live turn holds the tools (`mode-tool-surface.ts`), so only a live turn reads the rules.
 * - Coordinates must come from a shared location or a source the agent read: a guessed point sends
 *   people to the wrong place.
 */
export const PLACE_AND_POLL_RULES = `## Sending a place or a poll

\`send_location\` sends a point on the map to this chat; with \`title\` and \`address\` it becomes a place card that opens in maps. Use it when someone asks where something is, where to meet or to send a location, and when a place you name is the answer. Take coordinates only from a location shared in this conversation or from a source you read, such as a map service; never estimate them. When you know only an address, find its coordinates with your web tools first.

\`send_poll\` starts a native Telegram poll in this chat. Use it when someone asks for a poll or a vote. Write the question and 2-12 short distinct options; set \`anonymous: false\` when the chat needs to see who chose what, and \`allowsMultipleAnswers: true\` when the options do not exclude each other.

Each tool sends one message that is part of your answer: after \`delivered: true\` follow \`nextStep\` and do not repeat the address, the coordinates or the options in text. On an error do not call the tool again in this turn; follow \`correction\`.`;
