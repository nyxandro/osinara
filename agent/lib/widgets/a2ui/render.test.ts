/**
 * Building widgets from A2UI surfaces.
 *
 * Constructs covered:
 * - Every reference example validates, builds, fits Telegram's size with the project's margin and
 *   carries only the script parts it uses.
 * - The built HTML has no remote resource, no Telegram link, no form control, and asks the bot only
 *   from a tap handler.
 * - Actions, choice slots, bindings and frozen reads are recorded for presses and updates.
 * - Text is escaped; a list template over too many items and a moment without an offset are errors.
 */
import { describe, expect, it } from "vitest";

import { WIDGET_COMPRESSED_MAX_BYTES } from "../widget-config.js";
import { WIDGET_CATALOG_ID } from "./catalog.js";
import { renderWidget, type RenderedWidget } from "./render.js";
import { validateCreateSurface } from "./validate-surface.js";
import { WIDGET_EXAMPLES } from "./widget-examples.js";

function build(message: unknown): RenderedWidget {
  const validated = validateCreateSurface(message);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const rendered = renderWidget(validated.surface);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  return rendered.widget;
}

function failures(message: unknown): string[] {
  const validated = validateCreateSurface(message);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const rendered = renderWidget(validated.surface);
  if (rendered.ok) throw new Error("expected render errors");
  return rendered.errors.map((error) => `${error.path}: ${error.message}`);
}

const one = (components: unknown[], dataModel: Record<string, unknown> = {}) => ({
  createSurface: { catalogId: WIDGET_CATALOG_ID, components, dataModel, surfaceId: "t1" },
  version: "1.0",
});

describe("renderWidget", () => {
  it.each(WIDGET_EXAMPLES.map((example) => [example.name, example] as const))("builds the %s example within Telegram's size", (_, example) => {
    const widget = build(example.message);
    expect(widget.compressedBytes).toBeLessThanOrEqual(WIDGET_COMPRESSED_MAX_BYTES);
    expect(widget.html).not.toMatch(/https?:\/\/(?!example\.com\/booking)/u);
    expect(widget.html).not.toMatch(/t\.me|openTelegramLink|<input|<select|<textarea|<form/u);
  });

  it("asks the bot only inside tap handlers", () => {
    const widget = build(WIDGET_EXAMPLES.find((example) => example.name === "menu")!.message);
    const script = widget.html.slice(widget.html.indexOf("<script>"));
    const calls = [...script.matchAll(/W\.request\(/gu)].length;
    expect(calls).toBe(1);
    expect(script).toMatch(/send=\(b,d\)=>\{if\(!W\|\|b\.dataset\.w\)return;/u);
    expect(script).toMatch(/b\.onclick=\(\)=>send\(b,/u);
  });

  it("records the menu's action, its choice slots and nothing to update", () => {
    const widget = build(WIDGET_EXAMPLES.find((example) => example.name === "menu")!.message);
    expect(widget.actions).toEqual([expect.objectContaining({ label: "Готово", name: "menu_done", quiz: false, sourceComponentId: "done" })]);
    expect(widget.slots).toHaveLength(6);
    expect(widget.slots[0]).toEqual({ bit: 0, kind: "option", path: "/picked", value: "borsch" });
    expect(widget.bindings).toEqual([]);
    expect(widget.html).toContain('data-g="0,6,1"');
  });

  it("carries no script at all when nothing reacts", () => {
    const widget = build(one([{ component: "Text", id: "root", text: "**Важно:** <скоро>" }]));
    expect(widget.html).not.toContain("<script>");
    expect(widget.html).toContain("<b>Важно:</b> &lt;скоро&gt;");
  });

  it("records bound text and progress as updatable, tables and list lengths as frozen", () => {
    const widget = build(WIDGET_EXAMPLES.find((example) => example.name === "spending")!.message);
    expect(widget.bindings.map((binding) => binding.kind).sort()).toEqual(["progress", "text", "text"]);
    expect(widget.baked).toEqual(expect.objectContaining({ v0: "48 300 ₽" }));
    expect(widget.frozen).toEqual(expect.arrayContaining([{ kind: "value", pointer: "/labels" }, { kind: "value", pointer: "/values" }]));
    const schedule = build(WIDGET_EXAMPLES.find((example) => example.name === "schedule")!.message);
    expect(schedule.frozen).toEqual(expect.arrayContaining([{ kind: "length", pointer: "/mon" }, { kind: "length", pointer: "/thu" }]));
    expect(schedule.html).toContain("Шахматы");
  });

  it("refuses a template over too many items and a moment without an offset", () => {
    const items = Array.from({ length: 51 }, (_, position) => ({ title: `#${position}` }));
    expect(failures(one([
      { children: { componentId: "row", path: "/items" }, component: "List", id: "root" },
      { component: "Text", id: "row", text: { "@path": "title" } },
    ], { items }))[0]).toContain("at most 50");
    expect(failures(one([{ component: "Countdown", done: "!", id: "root", target: "2026-12-27T08:40:00" }]))[0]).toContain("offset");
  });
});
