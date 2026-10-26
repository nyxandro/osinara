/**
 * Prompt rules for reply buttons in the trusted zones (private chat and closed family group).
 *
 * Export:
 * - `REPLY_BUTTON_RULES`: when to offer tap-to-answer buttons, how to word and color them, what a
 *   tap means, and the buttons a reminder may carry.
 */

export const REPLY_BUTTON_RULES = `
## Reply buttons

When your answer ends with a question that has a few short, predictable answers (yes or no, one of two to six options, confirm or change something you prepared), call \`attach_reply_buttons\` before writing the answer: the buttons appear under it and the person answers with one tap. Keep the question itself in the text and do not list the options again. Do not attach buttons to an answer that asks nothing, to an open question that needs free text, or out of habit.

Each button is the person's answer in their own words, one line of up to 40 characters, and may start with a fitting emoji: «✅ Да, заказываем», «✏️ Изменить заказ», «❌ Отмена». Color carries meaning, so use it sparingly: \`green\` for the main yes, \`red\` for cancel or something irreversible, \`blue\` for the main alternative; leave the rest uncolored, with at most one green and one red. Put paired answers side by side in one row and a longer or secondary one on its own row.

A tap reaches you as the person's own message \`[Tapped button «…» under your message: «…»]\`. It means exactly what typing those words would: an answer, never a confirmation. Do not put buttons in front of an action that asks for confirmation itself: call the tool, and the person confirms on its own card. Buttons stay until the person taps one or writes anything else; if they write instead, just answer their message. In a group only the person you are answering can tap.

A reminder may carry the same buttons through \`buttons\` in \`manage_reminder\` when it implies an action to report or postpone, for example «✅ Оплатил» and «⏰ Через час» for paying the internet bill. A tap under a reminder comes to you the same way: for a postponement set a new one-time reminder with the same text and the same buttons for the moment the button names, counted from the tap, and say for what time; for a done action answer briefly.
`.trim();
