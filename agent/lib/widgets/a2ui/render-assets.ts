/**
 * The style sheet and the script of one widget, assembled from the parts its components use.
 *
 * Exports:
 * - `WidgetFeature`: a part of the widget's behaviour or look that only some widgets need.
 * - `widgetStyles`: the CSS for the features used.
 * - `widgetScript`: the `<script>` with the widget's data and the runtime parts used, or nothing.
 *
 * Key constructs:
 * - Telegram's 4 KB counts every byte of style and script, so a widget carries only the rules and
 *   script parts of the components it has (`render-runtime.ts` holds the parts).
 * - The widget's data is JSON inside the script; every `<` is escaped so a value can never close the tag.
 */
import { RUNTIME_PARTS, STYLE_PARTS } from "./render-runtime.js";

export type WidgetFeature =
  | "actions" | "badge" | "chart" | "countdown" | "inputs" | "links" | "progress" | "quiz" | "table" | "tabs" | "updates";

const STYLE_ORDER: readonly (keyof typeof STYLE_PARTS)[] = [
  "base", "inputs", "tabs", "table", "progress", "badge", "countdown", "quiz", "chart",
];

export function widgetStyles(features: ReadonlySet<WidgetFeature>): string {
  return STYLE_ORDER.filter((part) => part === "base" || features.has(part as WidgetFeature)).map((part) => STYLE_PARTS[part]).join("");
}

export function widgetScript(features: ReadonlySet<WidgetFeature>, data: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  const stateful = features.has("actions") || features.has("inputs") || features.has("quiz") || features.has("updates");
  if (stateful) parts.push(RUNTIME_PARTS.core);
  if (features.has("actions") || features.has("quiz")) parts.push(RUNTIME_PARTS.send);
  if (features.has("inputs")) parts.push(RUNTIME_PARTS.inputs);
  if (features.has("actions")) parts.push(RUNTIME_PARTS.actions);
  if (features.has("tabs")) parts.push(RUNTIME_PARTS.tabs);
  if (features.has("links")) parts.push(RUNTIME_PARTS.links);
  if (features.has("countdown")) parts.push(RUNTIME_PARTS.countdown);
  if (features.has("quiz")) parts.push(RUNTIME_PARTS.quiz);
  if (features.has("updates")) parts.push(RUNTIME_PARTS.updates);
  if (features.has("inputs")) parts.push("paint();");
  if (parts.length === 0) return "";
  // Every "<" escaped: neither "</script>" nor "<!--" in a value can change how the tag is parsed.
  const json = JSON.stringify(data).replace(/</gu, "\\u003c");
  return `<script>${stateful ? `const D=${json};` : ""}${RUNTIME_PARTS.helpers}${parts.join("")}</script>`;
}
