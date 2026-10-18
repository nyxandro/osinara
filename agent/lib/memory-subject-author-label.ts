/**
 * A text label that only names the author of the record's own source message.
 *
 * Exports:
 * - `SourceAuthorNames`: how Telegram named the author of the source message.
 * - `labelNamesSourceAuthor`: whether a model-written label is just that author's name.
 * - `bindSourceAuthorLabel`: replaces such a label with the verified author subject.
 *
 * The model decides whom a fact is about by name, and it writes the name it sees, «Пух (nyxandro)»,
 * into a text label even when that person is the author of the very message it chose. A label is a
 * string, not an identity: from 27.09 to 17.10.2026, after the instructions already explained
 * current_author, the silent review still saved 274 facts about the author that way, and about
 * 1 200 such records were active in all. None of them reached the author's profile, and the
 * duplicate check never compared them with the author's verified records, because it compares one
 * subject at a time.
 *
 * The author of the source message is already verified by Telegram, so naming them adds nothing
 * the server does not know. Only the forms that say nothing else are taken: the username,
 * "display (username)", and the bare display name. A username is unique, so a label carrying the
 * author's username is the author. A bare name is not: when another participant of the chat carries
 * the same name, the label may mean either of them, and it stays a label. So does a label naming
 * someone else, a nickname the message does not carry, or the author plus a topic
 * («Пух (nyxandro) — Mastra»): that is the model's statement about something other than the author,
 * and the server does not guess at it.
 *
 * Of the 524 stored records whose label was only the author's display name, 338 name the author
 * with their username in the text itself, and none was found to mean someone else; 12 came from a
 * chat where another participant carries the same name, which is the case this rule leaves alone.
 *
 * Migration 134 applies the same rule to the records saved before it; keep the two in step.
 */

export interface SourceAuthorNames {
  /** The author's name on the message and on the participant record; empty names are ignored. */
  readonly displayNames: readonly string[];
  /** Another participant of the same chat carries one of these names, so a bare name is ambiguous. */
  readonly displayNameShared: boolean;
  readonly username: string | null;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/gu, " ").trim();
}

export function labelNamesSourceAuthor(label: string, author: SourceAuthorNames): boolean {
  const name = normalizeName(label);
  if (!name) return false;
  const displays = author.displayNames.map(normalizeName).filter(Boolean);
  if (!author.displayNameShared && displays.includes(name)) return true;
  const username = author.username === null ? "" : normalizeName(author.username).replace(/^@/u, "");
  if (!username) return false;
  return name === username || name === `@${username}` || displays.some(
    (display) => name === `${display} (${username})` || name === `${display} (@${username})`,
  );
}

export function bindSourceAuthorLabel<Subject extends { readonly kind: string }>(
  subject: Subject,
  author: SourceAuthorNames,
): Subject | { kind: "current_author" } {
  if (subject.kind !== "label" || !("label" in subject) || typeof subject.label !== "string") return subject;
  return labelNamesSourceAuthor(subject.label, author) ? { kind: "current_author" } : subject;
}
