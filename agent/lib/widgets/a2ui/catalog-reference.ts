/**
 * The catalog as the model reads it in the widgets skill.
 *
 * Exports:
 * - `CATALOG_REFERENCE_START`, `CATALOG_REFERENCE_END`: the markers of the generated block in SKILL.md.
 * - `catalogReference`: the components, their properties, the functions and the icon names, as markdown.
 * - `examplesReference`: two reference widgets with the requests they answer.
 * - `replaceGeneratedBlock`: a markdown text with one generated block put in its place.
 *
 * Key construct:
 * - Generated from `catalog.ts`, the same definitions the validator and the renderer read, so the skill
 *   never offers what the validator refuses; a test compares the block in SKILL.md with this text.
 */
import { WIDGET_CATALOG_ID, WIDGET_COMPONENTS, WIDGET_FUNCTIONS, WIDGET_ICONS } from "./catalog.js";
import { WIDGET_EXAMPLES } from "./widget-examples.js";

export const CATALOG_REFERENCE_START = "<!-- catalog:start (generated from agent/lib/widgets/a2ui/catalog.ts) -->";
export const CATALOG_REFERENCE_END = "<!-- catalog:end -->";
export const EXAMPLES_REFERENCE_START = "<!-- examples:start (generated from agent/lib/widgets/a2ui/widget-examples.ts) -->";
export const EXAMPLES_REFERENCE_END = "<!-- examples:end -->";
const SKILL_EXAMPLES = ["menu", "schedule"];

export function catalogReference(): string {
  const components = Object.entries(WIDGET_COMPONENTS).map(([name, spec]) => {
    const props = Object.entries(spec.props)
      .filter(([prop]) => prop !== "weight")
      .map(([prop, definition]) => `\`${prop}\`${definition.required === true ? "*" : ""} — ${definition.description.replace(/\.$/u, "")}`)
      .join("; ");
    return `- **${name}** — ${spec.description} ${props}.`;
  });
  const functions = Object.entries(WIDGET_FUNCTIONS).map(([name, spec]) => {
    const args = Object.entries(spec.args).map(([arg, definition]) => `${arg}${definition.required === true ? "*" : ""}`).join(", ");
    const notes = Object.entries(spec.args).map(([arg, definition]) => `${arg}: ${definition.description.replace(/\.$/u, "")}`).join("; ");
    return `- \`${name}(${args})\` — ${spec.description}${spec.onTapOnly === true ? " Only as a Button's action.functionCall." : ""} ${notes}.`;
  });
  return [
    CATALOG_REFERENCE_START,
    `catalogId: \`${WIDGET_CATALOG_ID}\`. Every component may also take \`weight\` (1-10, its share of a Row or Column). * marks a required property.`,
    "",
    "Components:",
    ...components,
    "",
    "Functions (`{ \"@call\": name, \"args\": {...} }`):",
    ...functions,
    "",
    `Icon names: ${Object.keys(WIDGET_ICONS).join(", ")}.`,
    CATALOG_REFERENCE_END,
  ].join("\n");
}

export function examplesReference(): string {
  const blocks = SKILL_EXAMPLES.map((name) => {
    const example = WIDGET_EXAMPLES.find((candidate) => candidate.name === name)!;
    return [`Request «${example.request}», caption «${example.caption}»:`, "```json", JSON.stringify(example.message), "```"].join("\n");
  });
  return [EXAMPLES_REFERENCE_START, ...blocks, EXAMPLES_REFERENCE_END].join("\n\n");
}

export function replaceGeneratedBlock(text: string, start: string, end: string, block: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`AGENT_WIDGET_SKILL_MARKERS_MISSING: ${start}`);
  return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
}

