/**
 * Prompt rules for reply buttons in the trusted zones (private chat and closed family group).
 *
 * Exports:
 * - `REPLY_BUTTON_RULES`: when to offer tap-to-answer buttons, how to write, word and color them
 *   in the text of the answer, what a tap means, and what a tap under a reminder asks for.
 * - `LINK_AND_COPY_BUTTON_RULES`: buttons that open a web page or copy a text, in every chat; the
 *   backend refuses a Telegram address and a copy text the message does not show
 *   (`reply-buttons/reply-button-contract.ts`).
 */

export const REPLY_BUTTON_RULES = `
## Reply buttons

When your answer ends with a question that has a few short, predictable answers (yes or no, one of two to six options, confirm or change something you prepared), end the answer with buttons the person taps instead of typing. Write them yourself, right in the text of your final answer, after the question line, in Telegram's button markup; nothing needs to be called:

\`\`\`
Заказываем «Маргариту» на 19:00 за 650 ₽?

<tg-button-row><tg-button style="success">✅ Да</tg-button><tg-button style="danger">❌ Нет</tg-button><tg-button style="primary">✏️ Изменить</tg-button></tg-button-row>
\`\`\`

The buttons appear inside that message, below its text, and the tags never reach the person. The question line stays in the text and names what the buttons answer; do not list the options again. One \`<tg-button-row>\` is one row of up to three buttons side by side; put a longer or secondary answer on its own row. One to six buttons in all, at the very end of the answer; with \`[[split]]\`, at the end of the last part.

Each button is the person's answer in their own words, one line of up to 40 characters, and may start with a fitting emoji: «✅ Да, заказываем», «✏️ Изменить заказ», «❌ Отмена». No markup characters inside it (\`* _ ~ = | \` [ ] < > \\ $ #\`) and no two alike. An answer button carries only its label and an optional \`style\`: no \`type\`, no \`data\`. Color carries meaning, so use it sparingly: \`success\` (green) for the main yes, \`danger\` (red) for cancel or something irreversible, \`primary\` (blue) for the main alternative; leave the rest without a style, with at most one green and one red.

Do not put buttons on an answer that asks nothing, on an open question that needs free text, in a note written before a tool call, or out of habit. Do not put buttons in front of an action that asks for confirmation itself: call the tool, and the person confirms on its own card. Never describe the markup or the buttons' mechanics to the person.

A tap reaches you as the person's own message \`[Tapped button «…» under your message: «…»]\`. It means exactly what typing those words would: an answer, never a confirmation. Buttons stay until the person taps one or writes anything else; if they write instead, just answer their message. In a group only the person you are answering can tap.

A reminder may carry the same buttons, for example «✅ Оплатил» and «⏰ Через час» under paying the internet bill; how to write them is in the \`schedules\` skill. A tap under a reminder comes to you the same way: for a postponement set a new one-time reminder with the same content, buttons included, for the moment the button names, counted from the tap, and say for what time; for a done action answer briefly.
`.trim();

export const LINK_AND_COPY_BUTTON_RULES = `
## Link and copy buttons

A button can also open a web page or copy a text, in any chat. Use a link button when the answer leads to one page the person will open next, such as a menu, a booking form or a ticket page: \`<tg-button type="url" url="https://example.com/menu">🌐 Меню ресторана</tg-button>\`. Use a copy button when the answer gives a short text the person will paste somewhere else, such as a promo code, an order or tracking number, an address, an account number or a command: \`<tg-button type="copy_text" text="SUMMER25">📋 Скопировать промокод</tg-button>\`. Put them in a \`<tg-button-row>\` at the very end of the answer, like any button: one to six buttons in all, each label one line of up to 40 characters without markup characters.

A link button opens only an \`http\` or \`https\` address the person gave you or a source you read showed, never a guessed one and never a Telegram address (\`t.me\` and the like): such a link goes into the text with its address in sight. The text of a copy button must stand in the answer exactly as in the button, for example in \`code\`, and be at most 256 characters. These buttons stay under the message after an answer button is tapped, and you never learn whether someone pressed them. Do not add them out of habit: a page mentioned in passing is an ordinary link in the text.
`.trim();
