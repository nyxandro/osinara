/**
 * Building a Telegram widget's HTML from a validated A2UI surface.
 *
 * Exports:
 * - `WidgetAction`, `ChoiceSlot`, `WidgetBinding`, `FrozenRead`: what the widget remembers about itself,
 *   stored with it so presses and updates are understood later.
 * - `RenderedWidget`, `RenderResult`: the HTML with its sizes, or the A2UI errors that stopped it.
 * - `renderWidget`: one surface into one widget.
 *
 * Key constructs:
 * - Values are computed here, against the initial data model (`evaluate.ts`); the widget gets ready
 *   text. A value bound to data gets an element id and a binding, so a later `updateDataModel` can
 *   change exactly that text through the widget's shared state (`update.ts`).
 * - What cannot change later is recorded as a frozen read: a table, a chart, a list's length, an
 *   input's initial state. An update touching one is refused, because the HTML never changes after
 *   sending and the widget would silently keep the old picture.
 * - A press carries the action's number, the revision and the choice bits; the meaning stays here, in
 *   `actions` and `slots`, so the client never says what a button means.
 * - All text is escaped; the only markup a model writes is **bold** and *italic* in literal Text.
 */
import { deflateSync } from "node:zlib";

import { isTelegramWebAddress } from "../../telegram-rich-links.js";
import { WIDGET_ACTIONS_MAX, WIDGET_CHOICE_BITS_MAX } from "../widget-config.js";
import { type A2uiError, type JsonValue, type WidgetSurface, isPathBinding, isRecord } from "./a2ui-types.js";
import { WIDGET_ICONS } from "./catalog.js";
import {
  type EvaluationScope,
  WidgetEvaluationError,
  evaluateNumber,
  evaluateString,
  resolvePointer,
} from "./evaluate.js";
import { renderChartSvg } from "./render-chart.js";
import { progressPercent } from "./update.js";
import { widgetScript, widgetStyles, type WidgetFeature } from "./render-assets.js";

const TEMPLATE_ITEMS_MAX = 50;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
const ALIGN: Record<string, string> = { center: "ac", end: "ae", start: "as", stretch: "ax" };
const JUSTIFY: Record<string, string> = { center: "jc", end: "je", spaceAround: "ja", spaceBetween: "jb", start: "js" };
const TEXT_CLASS: Record<string, string> = { caption: "cp", subtitle: "t2", title: "t1" };
const BADGE_CLASS: Record<string, string> = { accent: "ta", danger: "tx", success: "tg", warning: "tw" };

export interface WidgetAction {
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly item: readonly string[] | null;
  readonly label: string;
  readonly name: string;
  readonly quiz: boolean;
  readonly sourceComponentId: string;
  /** The number of questions of a quiz's finish action; null for a button. */
  readonly total: number | null;
  readonly userMessage: unknown;
}

export interface ChoiceSlot {
  readonly bit: number;
  readonly kind: "boolean" | "option";
  /** Absolute pointer of the input's value in the data model. */
  readonly path: string;
  readonly value: string | null;
}

export interface WidgetBinding {
  readonly field: string;
  readonly item: readonly string[] | null;
  readonly kind: "text" | "progress";
  readonly max: unknown;
  readonly node: string;
  readonly value: unknown;
}

export interface FrozenRead {
  readonly kind: "value" | "length";
  readonly pointer: string;
}

export interface RenderedWidget {
  readonly actions: readonly WidgetAction[];
  readonly baked: Readonly<Record<string, string | number>>;
  readonly bindings: readonly WidgetBinding[];
  readonly compressedBytes: number;
  readonly frozen: readonly FrozenRead[];
  readonly html: string;
  readonly htmlBytes: number;
  readonly slots: readonly ChoiceSlot[];
}

export type RenderResult =
  | { readonly ok: true; readonly widget: RenderedWidget }
  | { readonly ok: false; readonly errors: readonly A2uiError[] };

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function inlineMarkup(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/gu, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/gu, "<i>$1</i>")
    .replace(/\n/gu, "<br>");
}

function pointerText(tokens: readonly string[]): string {
  return `/${tokens.map((token) => token.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}

function classes(...names: (string | undefined | false)[]): string {
  const present = names.filter((name): name is string => typeof name === "string" && name !== "");
  return present.length === 0 ? "" : ` class="${present.join(" ")}"`;
}

export function renderWidget(surface: WidgetSurface): RenderResult {
  const index = new Map([...surface.components.keys()].map((id, position) => [id, position]));
  const errors: A2uiError[] = [];
  const actions: WidgetAction[] = [];
  const slots: ChoiceSlot[] = [];
  const bindings: WidgetBinding[] = [];
  const frozen: FrozenRead[] = [];
  const baked: Record<string, string | number> = {};
  const features = new Set<WidgetFeature>();
  let nodes = 0;
  let quiz: { questions: unknown; finish: number | null } | null = null;

  const fieldOf = (id: string, prop: string) => `/createSurface/components/${index.get(id)}/${prop}`;
  const fail = (path: string, message: string) => errors.push({ code: "VALIDATION_FAILED", message, path, surfaceId: surface.surfaceId });

  function scope(item: readonly string[] | null): EvaluationScope {
    return { dataModel: surface.dataModel, item, reads: new Set() };
  }

  function freezeReads(reads: Set<string>): void {
    for (const pointer of reads) frozen.push({ kind: "value", pointer });
  }

  /** A text that is either literal or recorded as a binding the agent can update later. */
  function text(id: string, prop: string, value: unknown, item: readonly string[] | null, markup: boolean): string {
    const evaluation = scope(item);
    const shown = evaluateString(value, evaluation, fieldOf(id, prop));
    if (typeof value === "string") return markup ? inlineMarkup(shown) : escapeHtml(shown);
    const node = `v${nodes++}`;
    bindings.push({ field: fieldOf(id, prop), item, kind: "text", max: null, node, value });
    baked[node] = shown;
    features.add("updates");
    return `<span id="${node}">${escapeHtml(shown)}</span>`;
  }

  /** A text computed once: tab titles, labels of inputs, cells; their reads are frozen. */
  function fixedText(id: string, prop: string, value: unknown, item: readonly string[] | null): string {
    const evaluation = scope(item);
    const shown = evaluateString(value, evaluation, fieldOf(id, prop));
    freezeReads(evaluation.reads);
    return shown;
  }

  function weightStyle(props: Readonly<Record<string, unknown>>): string {
    return typeof props.weight === "number" ? ` style="flex:${props.weight}"` : "";
  }

  function children(id: string, value: unknown, item: readonly string[] | null): string {
    if (Array.isArray(value)) return value.map((child) => render(child as string, item)).join("");
    const template = value as { componentId: string; path: string };
    const evaluation = scope(item);
    const tokens = resolvePointer(template.path, evaluation, fieldOf(id, "children/path"));
    const list = readList(tokens);
    if (list === null) {
      fail(fieldOf(id, "children/path"), `no list at ${template.path} in the data model`);
      return "";
    }
    if (list.length > TEMPLATE_ITEMS_MAX) {
      fail(fieldOf(id, "children/path"), `${list.length} items at ${template.path}: at most ${TEMPLATE_ITEMS_MAX}`);
      return "";
    }
    frozen.push({ kind: "length", pointer: pointerText(tokens) });
    return list.map((_, position) => render(template.componentId, [...tokens, String(position)])).join("");
  }

  function readList(tokens: readonly string[]): readonly JsonValue[] | null {
    let current: JsonValue | undefined = surface.dataModel;
    for (const token of tokens) current = Array.isArray(current) ? (current as readonly JsonValue[])[Number(token)] : isRecord(current) ? (current as Record<string, JsonValue>)[token] : undefined;
    return Array.isArray(current) ? current as readonly JsonValue[] : null;
  }

  /** A button's label as stored for its presses; what it read is frozen, since presses keep this label. */
  function plainLabel(childId: string, item: readonly string[] | null): string {
    const child = surface.components.get(childId)!;
    if (child.component === "Icon") return WIDGET_ICONS[child.props.name as string] ?? "";
    return fixedText(childId, "text", child.props.text, item);
  }

  function button(id: string, props: Readonly<Record<string, unknown>>, item: readonly string[] | null): string {
    const inner = render(props.child as string, item);
    const variant = props.variant === "primary" ? "bp" : props.variant === "borderless" ? "bb" : undefined;
    const action = props.action as Record<string, Record<string, unknown>>;
    if (action.event !== undefined) {
      const event = action.event;
      actions.push({
        context: isRecord(event.context) ? event.context : null,
        item,
        label: plainLabel(props.child as string, item),
        name: event.name as string,
        quiz: false,
        sourceComponentId: id,
        total: null,
        userMessage: event.userMessage ?? null,
      });
      features.add("actions");
      return `<button${classes(variant)} data-a="${actions.length - 1}"${weightStyle(props)}>${inner}</button>`;
    }
    const call = action.functionCall as { "@call": string; args: Record<string, unknown> };
    if (call["@call"] === "openUrl") {
      const url = fixedText(id, "action/functionCall/args/url", call.args.url, item);
      if (!/^https:\/\//u.test(url) || url.length > 256 || isTelegramWebAddress(url)) {
        fail(fieldOf(id, "action/functionCall/args/url"), "openUrl takes an https web page outside Telegram");
      }
      features.add("links");
      return `<button${classes(variant)} data-u="${escapeHtml(url)}"${weightStyle(props)}>${inner}</button>`;
    }
    const copied = fixedText(id, "action/functionCall/args/text", call.args.text, item);
    if (copied.length === 0 || copied.length > 256) fail(fieldOf(id, "action/functionCall/args/text"), "copyText takes 1-256 characters");
    features.add("links");
    return `<button${classes(variant)} data-c="${escapeHtml(copied)}"${weightStyle(props)}>${inner}</button>`;
  }

  function inputState(id: string, props: Readonly<Record<string, unknown>>): { pointer: string; value: JsonValue | undefined } {
    const evaluation = scope(null);
    const tokens = resolvePointer((props.value as { "@path": string })["@path"], evaluation, fieldOf(id, "value"));
    const pointer = pointerText(tokens);
    frozen.push({ kind: "value", pointer });
    return { pointer, value: readListValue(tokens) };
  }

  function readListValue(tokens: readonly string[]): JsonValue | undefined {
    let current: JsonValue | undefined = surface.dataModel;
    for (const token of tokens) current = Array.isArray(current) ? (current as readonly JsonValue[])[Number(token)] : isRecord(current) ? (current as Record<string, JsonValue>)[token] : undefined;
    return current;
  }

  function render(id: string, item: readonly string[] | null): string {
    const component = surface.components.get(id)!;
    const props = component.props;
    const style = weightStyle(props);
    switch (component.component) {
      case "Text":
        return `<div${classes(TEXT_CLASS[props.variant as string])}${style}>${text(id, "text", props.text, item, true)}</div>`;
      case "Icon":
        return `<span${style}>${WIDGET_ICONS[props.name as string]}</span>`;
      case "Row":
      case "Column":
      case "List": {
        const base = component.component === "Row" ? "r" : component.component === "Column" ? "c" : props.direction === "horizontal" ? "l lh" : "l";
        return `<div${classes(base, ALIGN[props.align as string], JUSTIFY[props.justify as string])}${style}>${children(id, props.children, item)}</div>`;
      }
      case "Card":
        return `<div class="k"${style}>${render(props.child as string, item)}</div>`;
      case "Divider":
        return `<div class="${props.axis === "vertical" ? "dvv" : "dv"}"></div>`;
      case "Button":
        return button(id, props, item);
      case "Tabs": {
        features.add("tabs");
        const tabs = props.tabs as { title: unknown; child: string }[];
        const bar = `t${nodes++}`;
        const panels = tabs.map((_, position) => `${bar}p${position}`);
        const heads = tabs.map((tab, position) => `<button data-t="${position}"${classes(position === 0 && "on")}>${escapeHtml(fixedText(id, `tabs/${position}/title`, tab.title, item))}</button>`).join("");
        const bodies = tabs.map((tab, position) => `<div id="${panels[position]}"${classes(position > 0 && "hd")}>${render(tab.child, item)}</div>`).join("");
        return `<div class="c"${style}><div class="tb" id="${bar}" data-p="${panels.join(",")}">${heads}</div>${bodies}</div>`;
      }
      case "CheckBox": {
        features.add("inputs");
        const { pointer, value } = inputState(id, props);
        slots.push({ bit: slots.length, kind: "boolean", path: pointer, value: value === true ? "1" : "0" });
        return `<button class="x" data-i="${slots.length - 1}"${style}>${escapeHtml(fixedText(id, "label", props.label, item))}</button>`;
      }
      case "ChoicePicker": {
        features.add("inputs");
        const { pointer, value } = inputState(id, props);
        const picked = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
        const options = props.options as { label: string; value: string }[];
        const multiple = props.variant === "multipleSelection";
        const start = slots.length;
        let chosen = 0;
        const buttons = options.map((option) => {
          const on = picked.includes(option.value) && (multiple || chosen++ === 0);
          slots.push({ bit: slots.length, kind: "option", path: pointer, value: on ? `1:${option.value}` : `0:${option.value}` });
          return `<button data-i="${slots.length - 1}">${escapeHtml(option.label)}</button>`;
        }).join("");
        const label = props.label === undefined ? "" : `<div class="cp">${escapeHtml(fixedText(id, "label", props.label, item))}</div>`;
        return `<div class="c"${style}>${label}<div class="r" data-g="${start},${options.length},${multiple ? 1 : 0}">${buttons}</div></div>`;
      }
      case "Table": {
        features.add("table");
        const columns = (props.columns as string[]).map((column) => `<th>${escapeHtml(column)}</th>`).join("");
        const evaluation = scope(item);
        const rows = isPathBinding(props.rows) ? readListValue(resolvePointer(props.rows["@path"], evaluation, fieldOf(id, "rows"))) : props.rows;
        if (isPathBinding(props.rows)) for (const read of [pointerText(resolvePointer(props.rows["@path"], evaluation, fieldOf(id, "rows")))]) frozen.push({ kind: "value", pointer: read });
        if (!Array.isArray(rows) || rows.length > 20 || rows.some((row) => !Array.isArray(row) || row.length > 6)) {
          fail(fieldOf(id, "rows"), "rows are up to 20 lists of up to 6 cells");
          return "";
        }
        const body = rows.map((row) => `<tr>${(row as JsonValue[]).map((cell) => `<td>${escapeHtml(typeof cell === "string" || typeof cell === "number" ? String(cell) : "")}</td>`).join("")}</tr>`).join("");
        return `<table${style}><tr>${columns}</tr>${body}</table>`;
      }
      case "Chart":
        features.add("chart");
        return chart(id, props, item);
      case "Progress": {
        features.add("progress");
        const evaluation = scope(item);
        const value = evaluateNumber(props.value, evaluation, fieldOf(id, "value"));
        const max = props.max === undefined ? 100 : evaluateNumber(props.max, evaluation, fieldOf(id, "max"));
        const percent = progressPercent(value, max);
        let bar = `<i style="width:${percent}%"></i>`;
        if (typeof props.value !== "number" || (props.max !== undefined && typeof props.max !== "number")) {
          const node = `v${nodes++}`;
          bindings.push({ field: fieldOf(id, "value"), item, kind: "progress", max: props.max ?? 100, node, value: props.value });
          baked[node] = percent;
          features.add("updates");
          bar = `<i id="${node}" style="width:${percent}%"></i>`;
        }
        const label = props.label === undefined ? "" : `<div class="cp">${text(id, "label", props.label, item, false)}</div>`;
        return `<div class="c"${style}>${label}<div class="pg">${bar}</div></div>`;
      }
      case "Badge":
        features.add("badge");
        return `<span${classes("bd", BADGE_CLASS[props.tone as string])}${style}>${text(id, "text", props.text, item, false)}</span>`;
      case "Countdown": {
        features.add("countdown");
        const target = fixedText(id, "target", props.target, item);
        if (!MOMENT.test(target)) {
          fail(fieldOf(id, "target"), `"${target}" is not an ISO moment with its offset, such as 2026-12-31T23:59:00+03:00`);
          return "";
        }
        const label = props.label === undefined ? "" : `<div class="cp">${escapeHtml(fixedText(id, "label", props.label, item))}</div>`;
        return `<div class="c"${style}>${label}<div class="cd" data-e="${Date.parse(target)}" data-d="${escapeHtml(fixedText(id, "done", props.done, item))}"></div></div>`;
      }
      case "Quiz": {
        if (quiz !== null) {
          fail(fieldOf(id, "questions"), "one Quiz per widget");
          return "";
        }
        features.add("quiz");
        let finish: number | null = null;
        if (isRecord(props.finish)) {
          const event = (props.finish as Record<string, Record<string, unknown>>).event!;
          actions.push({ context: null, item, label: "Результат викторины", name: event.name as string, quiz: true, sourceComponentId: id, total: (props.questions as unknown[]).length, userMessage: event.userMessage ?? null });
          finish = actions.length - 1;
          features.add("actions");
        }
        quiz = { finish, questions: (props.questions as { question: string; options: string[]; answer: number }[]).map((entry) => ({ a: entry.answer, o: entry.options, q: entry.question })) };
        return `<div id="qz"${style}></div>`;
      }
      default:
        throw new Error(`AGENT_WIDGET_RENDER_UNKNOWN_COMPONENT: ${component.component}`);
    }
  }

  function chart(id: string, props: Readonly<Record<string, unknown>>, item: readonly string[] | null): string {
    const evaluation = scope(item);
    const list = (value: unknown, field: string): unknown => isPathBinding(value)
      ? readListValue(resolvePointer(value["@path"], evaluation, fieldOf(id, field)))
      : value;
    const labels = list(props.labels, "labels");
    const series = (props.series as { name: string; values: unknown }[]).map((entry, position) => ({ name: entry.name, values: list(entry.values, `series/${position}/values`) }));
    freezeReads(evaluation.reads);
    for (const value of [props.labels, ...(props.series as { values: unknown }[]).map((entry) => entry.values)]) {
      if (isPathBinding(value)) frozen.push({ kind: "value", pointer: pointerText(resolvePointer(value["@path"], evaluation, fieldOf(id, "series"))) });
    }
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > 24 || labels.some((label) => typeof label !== "string")) {
      fail(fieldOf(id, "labels"), "1-24 labels of text");
      return "";
    }
    for (const [position, entry] of series.entries()) {
      if (!Array.isArray(entry.values) || entry.values.length !== labels.length || entry.values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        fail(fieldOf(id, `series/${position}/values`), `${labels.length} numbers, one per label`);
        return "";
      }
    }
    if (props.kind === "pie" && series.length !== 1) {
      fail(fieldOf(id, "series"), "a pie chart takes one series");
      return "";
    }
    const title = props.title === undefined ? null : fixedText(id, "title", props.title, item);
    return `<div${weightStyle(props)}>${renderChartSvg({
      kind: props.kind as "bar" | "line" | "pie",
      labels: labels as string[],
      series: series as { name: string; values: number[] }[],
      unit: typeof props.unit === "string" ? props.unit : "",
    }, title)}</div>`;
  }

  let body = "";
  try {
    body = render("root", null);
  } catch (error) {
    if (!(error instanceof WidgetEvaluationError)) throw error;
    fail(error.field, error.message);
  }
  if (actions.length > WIDGET_ACTIONS_MAX) fail("/createSurface/components", `${actions.length} buttons reach the agent: at most ${WIDGET_ACTIONS_MAX}`);
  if (slots.length > WIDGET_CHOICE_BITS_MAX) fail("/createSurface/components", `${slots.length} check marks and options: at most ${WIDGET_CHOICE_BITS_MAX}`);
  if (errors.length > 0) return { errors, ok: false };

  const choiceBits = slots.map((slot) => (slot.value ?? "0").startsWith("1") ? "1" : "0").join("");
  const finalQuiz = quiz as { questions: unknown; finish: number | null } | null;
  const data = { n: choiceBits, r: 0, ...(finalQuiz === null ? {} : { q: finalQuiz.questions, ...(finalQuiz.finish === null ? {} : { f: finalQuiz.finish }) }) };
  const html = `<style>${widgetStyles(features)}</style>${body}${widgetScript(features, data)}`;
  const buffer = Buffer.from(html, "utf8");
  return {
    ok: true,
    widget: {
      actions,
      baked,
      bindings,
      compressedBytes: deflateSync(buffer, { level: 9 }).length,
      frozen,
      html,
      htmlBytes: buffer.length,
      slots: slots.map((slot) => ({ ...slot, value: slot.kind === "option" ? slot.value!.slice(2) : null })),
    },
  };
}
