/**
 * A saved skill must run from its own copy, never from the draft folder it was saved from.
 *
 * Export:
 * - `requireNoDraftPathReference`: refuses a package whose instructions or text files name the draft
 *   folder `skills/<name>/` anywhere but under `$HOME/.agents/skills/`.
 *
 * The draft stays in one person's workspace after saving: a skill pointing there would run what was
 * never saved, and would find nothing in a family group or in another member's chat.
 */
import { AppError } from "../app-error.js";

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function requireNoDraftPathReference(skill: {
  readonly files: ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }>;
  readonly markdown: string;
  readonly name: string;
}): void {
  const draft = new RegExp(`(?<!\\.agents/)skills/${escaped(skill.name)}/`, "u");
  const texts = [
    { path: "SKILL.md", text: skill.markdown },
    ...skill.files.map((file) => ({ path: file.path, text: Buffer.from(file.content).toString("utf8") })),
  ];
  const found = texts.find((entry) => draft.test(entry.text));
  if (found === undefined) return;
  throw new AppError("AGENT_SKILL_DRAFT_PATH_REFERENCE",
    `${found.path} ссылается на черновик skills/${skill.name}/. Сохранённый скилл лежит в $HOME/.agents/skills/${skill.name}/: ` +
    "укажите путь оттуда и сохраните снова", { details: { file: found.path, name: skill.name } });
}
