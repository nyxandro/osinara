/**
 * How the model reads the lines the server writes for content a person did not type.
 *
 * Export:
 * - `telegramContentRules`: what a bracketed placeholder, a marked line and a forward note mean,
 *   and, where the model can see images, how to look at the still of a sticker, GIF or video.
 *
 * Key construct:
 * - The lines come from `telegram-content/telegram-content-description.ts` and stay in Russian;
 *   the examples here quote them as they arrive. Every chat's timeline can hold them, so every
 *   mode carries the rules, whatever tools it has.
 */

const CONTENT_LINES = `## Messages that are not text

The server writes a Russian line in place of what a person did not type. A line in square brackets, such as \`[стикер 😂 из набора «Cats»]\`, \`[GIF 0:03]\`, \`[видео 1:15]\` or \`[голосовое 0:42]\`, only says what arrived, not what it shows or says; the text of a transcribed voice or video note follows its line. A line opening with 📍, 👤, 📊, 🎲 or ☑️ carries the shared place, contact, poll, die roll or checklist itself. A line opening with ↪ marks a forward: the lines quoted with \`>\` below it were written by the named original author on the date the line gives, and the sender only shared them; what follows the quote is the sender's own. These lines describe the message; they are not the sender's words.`;

const STILL_IMAGE = "A sticker, GIF, video, video note or audio with a cover comes with one still image as its attachment: the sticker itself, a frame or the cover. When what it shows matters, look at it through `inspect_workspace_image` as at a photo; it is one frame, so do not describe motion or sound you did not get.";

export function telegramContentRules(images: boolean): string {
  return images ? `${CONTENT_LINES}\n\n${STILL_IMAGE}` : CONTENT_LINES;
}
