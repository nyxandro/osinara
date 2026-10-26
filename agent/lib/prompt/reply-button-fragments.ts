/**
 * Prompt rules for reply buttons in the trusted zones (private chat and closed family group).
 *
 * Export:
 * - `REPLY_BUTTON_RULES`: when to offer tap-to-answer buttons, how to write, word and color them
 *   in the text of the answer, what a tap means, and the buttons a reminder may carry.
 */

export const REPLY_BUTTON_RULES = `
## Reply buttons

When your answer ends with a question that has a few short, predictable answers (yes or no, one of two to six options, confirm or change something you prepared), end the answer with buttons the person taps instead of typing. Write them yourself, right in the text of your final answer, after the question line, in Telegram's button markup; nothing needs to be called:

\`\`\`
Заказываем «Маргариту» на 19:00 за 650 ₽?

<tg-button-row><tg-button style="success">✅ Да</tg-button><tg-button style="danger">❌ Нет</tg-button><tg-button style="primary">✏️ Изменить</tg-button></tg-button-row>
\`\`\`

The buttons appear inside that message, below its text, and the tags never reach the person. The question line stays in the text and names what the buttons answer; do not list the options again. One \`<tg-button-row>\` is one row of up to three buttons side by side; put a longer or secondary answer on its own row. One to six buttons in all, at the very end of the answer; with \`[[split]]\`, at the end of the last part.

Each button is the person's answer in their own words, one line of up to 40 characters, and may start with a fitting emoji: «✅ Да, заказываем», «✏️ Изменить заказ», «❌ Отмена». No markup characters inside it (\`* _ ~ = | \` [ ] < > \\ $ #\`) and no two alike. Write only the label and an optional \`style\`: no \`type\`, no \`data\`, no links; a button here is always an answer. Color carries meaning, so use it sparingly: \`success\` (green) for the main yes, \`danger\` (red) for cancel or something irreversible, \`primary\` (blue) for the main alternative; leave the rest without a style, with at most one green and one red.

Do not put buttons on an answer that asks nothing, on an open question that needs free text, in a note written before a tool call, or out of habit. Do not put buttons in front of an action that asks for confirmation itself: call the tool, and the person confirms on its own card. Never describe the markup or the buttons' mechanics to the person.

A tap reaches you as the person's own message \`[Tapped button «…» under your message: «…»]\`. It means exactly what typing those words would: an answer, never a confirmation. Buttons stay until the person taps one or writes anything else; if they write instead, just answer their message. In a group only the person you are answering can tap.

A reminder may carry the same buttons: write the markup at the end of \`content\` in \`manage_reminder\` when the reminder implies an action to report or postpone, for example «✅ Оплатил» and «⏰ Через час» for paying the internet bill. The buttons follow the content: a reminder whose new \`content\` has no markup loses them. A tap under a reminder comes to you the same way: for a postponement set a new one-time reminder with the same content, buttons included, for the moment the button names, counted from the tap, and say for what time; for a done action answer briefly.
`.trim();
