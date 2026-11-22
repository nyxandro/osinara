/**
 * A record bound to one participant whose text names another one instead (#556).
 *
 * Exports:
 * - `mentionedUsernames`: the Telegram usernames a text names, lower-cased.
 * - `subjectNameMismatch`: the other participants a record names while it does not name its own.
 *
 * The model is told to write a person as «Имя (username)», and from 18.10 to 20.11.2026 it did so in
 * nearly every record. In six of 1 200 records bound to the author of the message, the text named
 * another participant and not the author: «Олег» had passed on what «Нина» thinks, and it was stored
 * as Oleg's view. The server knows both usernames, so it can tell that the text and the binding
 * disagree; it cannot tell which of them is right, so it only refuses and lets the model decide.
 *
 * Only the forms the rule asks for count as naming someone: «@handle», «(handle)», «(@handle)», also
 * when the bracket goes on after a comma — «Нина (nina_s, сестра Олега)». A bare
 * word is often a product or a nickname, and an e-mail address is not a mention. A handle nobody in
 * the chat carries is not a reason to refuse: by measurement more than half of those are real people
 * and channels who were mentioned but never wrote (owner's decision, 20.11.2026).
 */

// Telegram usernames are 5–32 characters today; older and collectible ones may be four.
const USERNAME_MENTION =
  /(?<![\p{L}\p{N}_@.])@([A-Za-z0-9_]{4,32})(?![A-Za-z0-9_])|\(\s*@?([A-Za-z0-9_]{4,32})\s*[),;]/gu;

export function mentionedUsernames(content: string): Set<string> {
  const found = new Set<string>();
  for (const match of content.matchAll(USERNAME_MENTION)) {
    found.add((match[1] ?? match[2]!).toLowerCase());
  }
  return found;
}

/**
 * The other participants the text names, or null when there is nothing to refuse: the bound person
 * is named, or nobody of the chat is. Usernames are compared without case, as Telegram does.
 */
export function subjectNameMismatch(
  content: string,
  boundUsername: string,
  otherUsernames: readonly string[],
): string[] | null {
  const mentioned = mentionedUsernames(content);
  const bound = boundUsername.toLowerCase();
  if (mentioned.has(bound)) return null;
  const others = [...new Set(otherUsernames.map((username) => username.toLowerCase()))]
    .filter((username) => username !== bound && mentioned.has(username));
  return others.length === 0 ? null : others;
}
