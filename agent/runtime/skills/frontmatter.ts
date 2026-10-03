/**
 * The frontmatter of a `SKILL.md`: the top-level `name`, `description` and `license` scalars.
 *
 * Export:
 * - `parseSkillFrontmatter`: the scalars and the Markdown body, or `null` when the file has no
 *   frontmatter. Values may be plain, quoted, or block scalars (`>`, `>-`, `|`, `|-`, with `+`
 *   keeping trailing newlines); nested maps such as `metadata:` are skipped.
 *
 * Not a YAML parser: only what skill packages use. A block scalar follows YAML 1.2 folding — lines
 * of a paragraph join with a space, an empty line becomes a line break, more-indented lines stay
 * as they are.
 */

export interface SkillFrontmatter {
  readonly body: string;
  readonly fields: Readonly<Record<string, string>>;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;
const KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/u;
const BLOCK_HEADER_PATTERN = /^([>|])([+-]?)$/u;

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function foldLines(lines: readonly string[]): string {
  let text = "";
  let previous: "empty" | "more" | "text" | null = null;
  for (const line of lines) {
    if (line === "") {
      text += "\n";
      previous = "empty";
      continue;
    }
    const moreIndented = line.startsWith(" ") || line.startsWith("\t");
    if (previous === "text" && !moreIndented) text += " ";
    else if (previous === "more" || (previous === "text" && moreIndented)) text += "\n";
    text += line;
    previous = moreIndented ? "more" : "text";
  }
  return text;
}

/** Chomping: `-` strips the final line break, `+` keeps the trailing empty lines, none keeps one break. */
function blockScalar(lines: readonly string[], style: string, indicator: string): string {
  const meaningful = lines.filter((line) => line.trim() !== "");
  if (meaningful.length === 0) return "";
  const indent = Math.min(...meaningful.map(indentation));
  const content = lines.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
  if (indicator !== "+") while (content.length > 0 && content.at(-1) === "") content.pop();
  const text = style === "|" ? content.join("\n") : foldLines(content);
  return indicator === "-" ? text : `${text}\n`;
}

export function parseSkillFrontmatter(source: string): SkillFrontmatter | null {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/u);
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#") || indentation(line) > 0) continue;
    const key = KEY_PATTERN.exec(line);
    if (!key) continue;
    const value = key[2] ?? "";
    // The value's lines: everything indented under the key, up to the next top-level line.
    const nested: string[] = [];
    while (index + 1 < lines.length && (lines[index + 1]!.trim() === "" || indentation(lines[index + 1]!) > 0)) {
      nested.push(lines[index + 1]!);
      index += 1;
    }
    const block = BLOCK_HEADER_PATTERN.exec(value);
    if (block) {
      fields[key[1]!] = blockScalar(nested, block[1]!, block[2]!);
      continue;
    }
    // A nested map or list is not a scalar the catalog reads.
    if (value === "") continue;
    const continuation = nested.filter((entry) => entry.trim() !== "").map((entry) => entry.trim());
    fields[key[1]!] = unquote([value, ...continuation].join(" "));
  }
  return { body: match[2]!, fields };
}
