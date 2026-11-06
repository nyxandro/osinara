/**
 * How the model sends a place, a poll or a contact card to the chat.
 *
 * Exports:
 * - `TELEGRAM_NATIVE_SEND_RULES`: when to use `send_location`, `send_poll` and `send_contact`,
 *   where coordinates and numbers come from, and how the sent message stands in the answer.
 * - `TELEGRAM_WIDGET_RULES`: when a widget beats text, buttons or a poll; the skill holds the rest.
 *
 * Key construct:
 * - Only a live turn holds the tools (`mode-tool-surface.ts`), so only a live turn reads the rules.
 * - Coordinates and phone numbers must come from the conversation, memory or a source the agent
 *   read: a guessed point sends people to the wrong place, a guessed number calls a stranger.
 * - The empty-delivery line itself is named only in the tool result: a private chat's mode block
 *   never carries it (`turn-blocks.test.ts`).
 */
export const TELEGRAM_NATIVE_SEND_RULES = `## Sending a place, a poll or a contact

\`send_location\` sends a point on the map to this chat; with \`title\` and \`address\` it becomes a place card that opens in maps. Use it when someone asks where something is, where to meet or to send a location, and when the one place you name is the answer; in a group, only where you would answer at all. Send one card per answer: several places go as text. Take coordinates only from a location shared in this conversation or from a source you read, such as a map service; never estimate them. When you know only an address, find its coordinates with your web tools first.

\`send_poll\` starts a native Telegram poll in this chat. Use it when someone asks for a poll or a vote. Write the question and 2-12 short distinct options; set \`anonymous: false\` when the chat needs to see who chose what, and \`allowsMultipleAnswers: true\` when the options do not exclude each other. You do not see the votes after the poll is sent: when asked for the results, say so and ask people to look at the poll.

\`send_contact\` sends a contact card that the person saves to their phone with one tap. Use it when someone asks for the phone number of a person or a service to save or to call; a number mentioned in passing stays in the text. Take the number only from this conversation, memory or a source you read, exactly as given; never invent, guess or complete one, and never add a country code that was not there. Without a number say that you do not know it. One card per answer: several contacts go as text.

Each tool sends one message that is part of your answer: after \`delivered: true\` follow \`nextStep\` and do not repeat the address, the coordinates, the options or the number in text. When \`nextStep\` asks you to end with the empty-delivery line, here it does not mean silence: the answer has already been delivered. After an input error fix the call once as \`correction\` says; after any other error do not call the tool again in this turn.`;

// Only a live private chat carries the widget tools (#468); the mode block adds this text with them.
export const TELEGRAM_WIDGET_RULES = `## Widgets

\`send_widget\` sends a widget: a small interactive card drawn inside the message. Use it when the answer is better seen than read or needs choosing: a week or a day plan, a comparison of three or more options, numbers over time or shares of a whole, progress, steps to tick off, a choice of more than six options or of several at once, a quiz, a countdown, a game. Keep to text for short answers and plain tables or lists (your rich text draws them), to reply buttons for two to six options with one choice, to \`send_poll\` for a vote, and to a reminder for anything that must notify: a widget never notifies.

Load the \`widgets\` skill before your first widget in a conversation; it has the A2UI catalog, the rules and examples. Describe the widget as A2UI (\`surface\`); write your own HTML (\`html\`) only for a game or an animation the catalog cannot describe, and such a widget cannot reach you. Send one widget per answer. Put the facts a person acts on — a time, a place, an amount — into the caption: some apps do not show widgets yet and show only the caption.

A press of a widget button reaches you as the person's message «[Pressed «…» in your widget «…»]» with the A2UI action and its context: answer it like their words. To change what a widget you sent shows, call \`update_widget\` with its surfaceId.`;

