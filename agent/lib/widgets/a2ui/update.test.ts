/**
 * The agent's A2UI updates of a widget already in the chat.
 *
 * Constructs covered:
 * - A bound text and a bound progress bar change through the shared state, with the next revision and
 *   only the values that differ from the HTML.
 * - Frozen parts — a list's length, an input's state, a chart's data — refuse the update as a whole.
 * - Malformed messages and another surface's messages are refused with what to fix.
 */
import { describe, expect, it } from "vitest";

import type { StoredWidget } from "../widget-repository.js";
import { WIDGET_CATALOG_ID } from "./catalog.js";
import { renderWidget } from "./render.js";
import { applyWidgetUpdates } from "./update.js";
import { validateCreateSurface } from "./validate-surface.js";

function stored(components: unknown[], dataModel: Record<string, unknown>): StoredWidget {
  const validated = validateCreateSurface({ createSurface: { catalogId: WIDGET_CATALOG_ID, components, dataModel, surfaceId: "trip" }, version: "1.0" });
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const rendered = renderWidget(validated.surface);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  const { actions, baked, bindings, frozen, slots } = rendered.widget;
  return {
    agentSessionId: "s", caption: "c", dataModel: validated.surface.dataModel, id: "w", revision: 0,
    surface: { actions, baked, bindings, frozen, sendDataModel: false, slots }, surfaceId: "trip", telegramChatId: "1", telegramMessageId: "2",
  };
}

const update = (path: string, value: unknown) => ({ updateDataModel: { path, surfaceId: "trip", value }, version: "1.0" });

const GOING = [
  { children: ["going", "bar", "names", "pick"], component: "Column", id: "root" },
  { component: "Text", id: "going", text: { "@call": "formatString", args: { value: "Идут: ${/count} из ${/total}" } } },
  { component: "Progress", id: "bar", max: { "@path": "/total" }, value: { "@path": "/count" } },
  { children: { componentId: "name", path: "/names" }, component: "List", id: "names" },
  { component: "Text", id: "name", text: { "@path": "name" } },
  { component: "CheckBox", id: "pick", label: "Иду", value: { "@path": "/me" } },
];
const DATA = { count: 1, me: false, names: [{ name: "Петя" }], total: 6 };

describe("applyWidgetUpdates", () => {
  it("changes bound texts and bars through the shared state", () => {
    const widget = stored(GOING, DATA);
    const result = applyWidgetUpdates(widget, [update("/count", 3), update("/names/0/name", "Петя П.")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataModel).toEqual({ ...DATA, count: 3, names: [{ name: "Петя П." }] });
    expect(JSON.parse(result.publicData!)).toEqual({ p: { v1: 50 }, r: 1, v: { v0: "Идут: 3 из 6", v2: "Петя П." } });
    expect(result.visibleChanges).toBe(3);
  });

  it("sends nothing when no shown value changes, and the full state once the widget was updated", () => {
    const widget = stored(GOING, DATA);
    expect(applyWidgetUpdates(widget, [update("/note", "x")])).toEqual(expect.objectContaining({ ok: true, publicData: null, visibleChanges: 0 }));
    const back = applyWidgetUpdates({ ...widget, revision: 2 }, [update("/note", "x")]);
    expect(back.ok && JSON.parse(back.publicData!)).toEqual({ p: {}, r: 3, v: {} });
  });

  it("refuses to change a list's length, an input's state or a chart's data", () => {
    const widget = stored(GOING, DATA);
    expect(applyWidgetUpdates(widget, [update("/names/1", { name: "Маша" })])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_NOT_UPDATABLE", ok: false }));
    expect(applyWidgetUpdates(widget, [update("/me", true)])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_NOT_UPDATABLE", ok: false }));
    const chart = stored([{ component: "Chart", id: "root", kind: "bar", labels: ["a", "b"], series: [{ name: "x", values: { "@path": "/v" } }] }], { v: [1, 2] });
    expect(applyWidgetUpdates(chart, [update("/v", [2, 3])])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_NOT_UPDATABLE", ok: false }));
  });

  it("refuses malformed messages and another surface", () => {
    const widget = stored(GOING, DATA);
    expect(applyWidgetUpdates(widget, [])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_UPDATE_INVALID" }));
    expect(applyWidgetUpdates(widget, [{ updateDataModel: { path: "/count", surfaceId: "other", value: 2 }, version: "1.0" }])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_UPDATE_INVALID" }));
    expect(applyWidgetUpdates(widget, [update("count", 2)])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_UPDATE_INVALID" }));
    expect(applyWidgetUpdates(widget, [update("/count", "три")])).toEqual(expect.objectContaining({ code: "AGENT_WIDGET_UPDATE_INVALID" }));
  });
});
