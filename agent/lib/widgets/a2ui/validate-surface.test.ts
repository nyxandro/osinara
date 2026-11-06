/**
 * Validation of A2UI `createSurface` messages against the Telegram widget catalog.
 *
 * Constructs covered:
 * - A well-formed menu with a choice picker, a button event and a list template passes and keeps its
 *   components and data model.
 * - Every error is reported at once, in the protocol's format, at the JSON Pointer of the field.
 * - Composition: root, missing children, cycles, two parents, unreachable components, button content,
 *   components that cannot repeat in a template.
 * - Values: relative paths outside templates, unknown functions, tap-only functions inside values,
 *   Telegram links in openUrl, formatString placeholders.
 */
import { describe, expect, it } from "vitest";

import { WIDGET_CATALOG_ID } from "./catalog.js";
import { validateCreateSurface } from "./validate-surface.js";

function message(components: unknown[], dataModel: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { createSurface: { catalogId: WIDGET_CATALOG_ID, components, dataModel, surfaceId: "menu_week", ...extra }, version: "1.0" };
}

const MENU = [
  { children: ["title", "dishes", "done"], component: "Column", id: "root" },
  { component: "Text", id: "title", text: "Меню на неделю", variant: "title" },
  {
    component: "ChoicePicker",
    id: "dishes",
    options: [{ label: "Борщ", value: "borsch" }, { label: "Плов", value: "plov" }, { label: "Сырники", value: "syrniki" }],
    value: { "@path": "/picked" },
    variant: "multipleSelection",
  },
  { action: { event: { context: { picked: { "@path": "/picked" } }, name: "menu_done", userMessage: "Готово" } }, child: "done_label", component: "Button", id: "done", variant: "primary" },
  { component: "Text", id: "done_label", text: "Готово" },
];

function errors(input: unknown) {
  const result = validateCreateSurface(input);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map((error) => `${error.code} ${error.path}`);
}

describe("validateCreateSurface", () => {
  it("accepts a menu with a choice picker, a button event and keeps its data", () => {
    const result = validateCreateSurface(message(MENU, { picked: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.surface.surfaceId).toBe("menu_week");
    expect([...result.surface.components.keys()]).toEqual(["root", "title", "dishes", "done", "done_label"]);
    expect(result.surface.dataModel).toEqual({ picked: [] });
  });

  it("accepts a list template whose items use relative paths", () => {
    const result = validateCreateSurface(message([
      { children: { componentId: "task", path: "/tasks" }, component: "List", id: "root" },
      { children: ["task_title", "task_badge"], component: "Row", id: "task", justify: "spaceBetween" },
      { component: "Text", id: "task_title", text: { "@path": "title" } },
      { component: "Badge", id: "task_badge", text: { "@call": "formatString", args: { value: "до ${due}" } }, tone: "accent" },
    ], { tasks: [{ due: "пт", title: "Купить подарок" }] }));
    expect(result.ok).toBe(true);
  });

  it("refuses a message that is not one createSurface envelope", () => {
    expect(errors({ updateComponents: {} })).toEqual(["VALIDATION_FAILED "]);
    expect(errors({ ...message(MENU), version: "0.9" })).toContain("VALIDATION_FAILED /version");
  });

  it("reports every envelope error at once, at its pointer", () => {
    const found = errors({ createSurface: { catalogId: "basic", components: MENU, surfaceId: "bad id!", theme: { primary: "#f00" } }, version: "1.0" });
    expect(found).toEqual(expect.arrayContaining([
      "VALIDATION_FAILED /createSurface/surfaceId",
      "VALIDATION_FAILED /createSurface/catalogId",
      "VALIDATION_FAILED /createSurface/theme",
    ]));
  });

  it("refuses components outside the catalog and explains a missing keyboard", () => {
    const result = validateCreateSurface(message([
      { children: ["name"], component: "Column", id: "root" },
      { component: "TextField", id: "name", label: "Имя" },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: "VALIDATION_FAILED", path: "/createSurface/components/1/component", surfaceId: "menu_week" });
    expect(result.errors[0]?.message).toContain("no keyboard");
  });

  it("refuses unknown and missing properties", () => {
    expect(errors(message([{ color: "red", component: "Text", id: "root" }]))).toEqual([
      "VALIDATION_FAILED /createSurface/components/0/color",
      "VALIDATION_FAILED /createSurface/components/0/text",
    ]);
  });

  it("needs a root, existing children, one parent each and no cycles", () => {
    expect(errors(message([{ component: "Text", id: "title", text: "x" }]))).toEqual(["VALIDATION_FAILED /createSurface/components"]);
    expect(errors(message([{ children: ["ghost"], component: "Column", id: "root" }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/children/0"]);
    expect(errors(message([
      { children: ["a", "b"], component: "Column", id: "root" },
      { child: "c", component: "Card", id: "a" },
      { child: "c", component: "Card", id: "b" },
      { component: "Text", id: "c", text: "x" },
    ]))).toEqual(["VALIDATION_FAILED /createSurface/components/2/child"]);
    expect(errors(message([
      { children: ["a"], component: "Column", id: "root" },
      { child: "b", component: "Card", id: "a" },
      { child: "a", component: "Card", id: "b" },
    ]))).toEqual(expect.arrayContaining(["VALIDATION_FAILED /createSurface/components/2/child"]));
  });

  it("refuses a component that is never shown", () => {
    expect(errors(message([
      { component: "Text", id: "root", text: "x" },
      { component: "Text", id: "lost", text: "y" },
    ]))).toEqual(["VALIDATION_FAILED /createSurface/components/1"]);
  });

  it("keeps a button to a text or an icon and inputs out of templates", () => {
    expect(errors(message([
      { action: { event: { name: "go" } }, child: "inner", component: "Button", id: "root" },
      { child: "deep", component: "Card", id: "inner" },
      { component: "Text", id: "deep", text: "x" },
    ]))).toEqual(["UNALLOWED_CHILD /createSurface/components/0/child"]);
    expect(errors(message([
      { children: { componentId: "row", path: "/items" }, component: "List", id: "root" },
      { component: "CheckBox", id: "row", label: { "@path": "title" }, value: { "@path": "/done" } },
    ]))).toEqual(["UNALLOWED_PARENT /createSurface/components/1"]);
  });

  it("refuses relative paths outside a template and bad pointers", () => {
    expect(errors(message([{ component: "Text", id: "root", text: { "@path": "title" } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/@path"]);
    expect(errors(message([{ component: "Text", id: "root", text: { "@path": "/a//b" } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/@path"]);
  });

  it("checks function calls: catalog, return type, arguments and tap-only functions", () => {
    expect(errors(message([{ component: "Text", id: "root", text: { "@call": "now" } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/@call"]);
    expect(errors(message([{ component: "Text", id: "root", text: { "@call": "not", args: { value: true } } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/@call"]);
    expect(errors(message([{ component: "Text", id: "root", text: { "@call": "formatCurrency", args: { value: 10 } } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/args/currency"]);
    expect(errors(message([{ component: "Text", id: "root", text: { "@call": "openUrl", args: { url: "https://example.com" } } }]))).toEqual(["VALIDATION_FAILED /createSurface/components/0/text/@call"]);
    expect(errors(message([{ component: "Text", id: "root", text: { "@call": "formatString", args: { value: "${now()} и ${title}" } } }]))).toEqual([
      "VALIDATION_FAILED /createSurface/components/0/text/args/value",
      "VALIDATION_FAILED /createSurface/components/0/text/args/value",
    ]);
  });

  it("lets openUrl open web pages but never Telegram", () => {
    const button = (url: string) => message([
      { action: { functionCall: { "@call": "openUrl", args: { url } } }, child: "label", component: "Button", id: "root" },
      { component: "Text", id: "label", text: "Открыть" },
    ]);
    expect(validateCreateSurface(button("https://example.com/recipe")).ok).toBe(true);
    expect(errors(button("https://t.me/somebot"))).toEqual(["VALIDATION_FAILED /createSurface/components/0/action/functionCall/args/url"]);
    expect(errors(button("http://example.com"))).toEqual(["VALIDATION_FAILED /createSurface/components/0/action/functionCall/args/url"]);
  });

  it("checks quiz questions and its finish event", () => {
    expect(validateCreateSurface(message([
      { component: "Quiz", finish: { event: { name: "quiz_done" } }, id: "root", questions: [{ answer: 1, options: ["5", "6"], question: "2 × 3?" }] },
    ])).ok).toBe(true);
    expect(errors(message([
      { component: "Quiz", finish: { event: { context: { a: 1 }, name: "quiz_done" } }, id: "root", questions: [{ answer: 2, options: ["5", "6"], question: "2 × 3?" }] },
    ])).sort()).toEqual([
      "VALIDATION_FAILED /createSurface/components/0/finish/event/context",
      "VALIDATION_FAILED /createSurface/components/0/questions/0/answer",
    ]);
  });
});
