/**
 * Reply buttons as an inline keyboard under a message that cannot carry them in its text (#480).
 *
 * Exports:
 * - `replyButtonKeyboard`: the keyboard Telegram receives with a widget card.
 * - `settledReplyButtonKeyboard`: what stays under the card after a choice: its link and copy buttons
 *   and the caption as a disabled button.
 *
 * Key constructs:
 * - A widget's caption is an ordinary media caption: Telegram refuses button markup in it
 *   (`Unsupported start tag "tg-button-row"`, live probe of 09.11.2026), so the buttons go under the
 *   card as its keyboard, the way Telegram shows them under any media.
 * - A press carries only the set's token and the button's index, exactly like the buttons written into
 *   a rich message (`reply-button-markup.ts`).
 */
import type { JsonObject } from "../../runtime/json.js";

import {
  REPLY_BUTTON_CALLBACK_PREFIX,
  REPLY_BUTTON_STYLES,
  type ReplyButton,
  type ReplyButtonRows,
} from "./reply-button-contract.js";

function keyboardButton(button: ReplyButton, press: () => string): JsonObject {
  const style: JsonObject = button.color === undefined ? {} : { style: REPLY_BUTTON_STYLES[button.color] };
  if (button.url !== undefined) return { text: button.text, url: button.url, ...style };
  if (button.copyText !== undefined) return { copy_text: { text: button.copyText }, text: button.text, ...style };
  return { callback_data: press(), text: button.text, ...style };
}

export function replyButtonKeyboard(rows: ReplyButtonRows, token: string): JsonObject {
  let index = 0;
  return {
    inline_keyboard: rows.map((row) => row.map((button) => {
      const pressed = index;
      index += 1;
      return keyboardButton(button, () => `${REPLY_BUTTON_CALLBACK_PREFIX}${token}:${pressed}`);
    })),
  };
}

export function settledReplyButtonKeyboard(staying: ReplyButtonRows, caption: string): JsonObject {
  return {
    inline_keyboard: [
      ...staying.map((row) => row.map((button) => keyboardButton(button, () => {
        throw new Error("AGENT_REPLY_BUTTONS_STAYING_ANSWER: only link and copy buttons stay after a choice");
      }))),
      [{ disabled: {}, text: caption }],
    ],
  };
}
