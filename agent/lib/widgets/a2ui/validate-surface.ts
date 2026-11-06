/**
 * Validation of an A2UI 1.0 `createSurface` message against the Telegram widget catalog.
 *
 * Exports:
 * - `validateCreateSurface`: the checked surface, or every A2UI error found in the message.
 * - `templateScopes`: which components render once per item of a list template.
 *
 * Key constructs:
 * - The message is the protocol's own envelope `{ "version": "1.0", "createSurface": {...} }`: the
 *   model writes standard A2UI, and the catalog is ours (`catalog.ts`).
 * - Composition follows A2UI's adjacency list: a flat list of components linked by id, mounted at the
 *   component `root`. Every component is reachable from `root` through exactly one parent and no
 *   cycle, so the renderer can build the tree without guessing; an unreachable component would
 *   silently never show, so it is an error too.
 * - Inside a list template only components that render plainly per item are allowed: inputs, tabs,
 *   charts, tables and quizzes keep one state for the whole widget.
 */
import { WIDGET_COMPONENTS_MAX } from "../widget-config.js";
import {
  A2UI_VERSION,
  type A2uiError,
  type JsonObject,
  type WidgetComponent,
  type WidgetSurface,
  isRecord,
  parsePointer,
} from "./a2ui-types.js";
import { WIDGET_CATALOG_ID, WIDGET_COMPONENTS } from "./catalog.js";
import { createValueChecker, type ValueChecker } from "./validate-values.js";

const SURFACE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const COMPONENT_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/u;
const DATA_MODEL_MAX_BYTES = 16_384;
const SURFACE_KEYS = new Set(["surfaceId", "catalogId", "components", "dataModel", "sendDataModel", "metadata"]);
const COMPONENT_COMMON_KEYS = new Set(["id", "component", "accessibility"]);
const BUTTON_CHILDREN = new Set(["Text", "Icon"]);
const NOT_IN_TEMPLATE = new Set(["CheckBox", "ChoicePicker", "Tabs", "Chart", "Table", "Quiz", "Countdown"]);

export type ValidationResult =
  | { readonly ok: true; readonly surface: WidgetSurface }
  | { readonly ok: false; readonly errors: readonly A2uiError[] };

interface ChildLink {
  readonly id: string;
  readonly path: string;
  readonly template: boolean;
}

function childLinks(component: WidgetComponent, at: string): ChildLink[] {
  const links: ChildLink[] = [];
  const spec = WIDGET_COMPONENTS[component.component]!;
  for (const [name, definition] of Object.entries(spec.props)) {
    const value = component.props[name];
    if (value === undefined) continue;
    if (definition.spec.kind === "child" && typeof value === "string") links.push({ id: value, path: `${at}/${name}`, template: false });
    if (definition.spec.kind === "children") {
      if (Array.isArray(value)) value.forEach((id, index) => typeof id === "string" && links.push({ id, path: `${at}/${name}/${index}`, template: false }));
      else if (isRecord(value) && typeof value.componentId === "string") links.push({ id: value.componentId, path: `${at}/${name}/componentId`, template: true });
    }
    if (definition.spec.kind === "tabs" && Array.isArray(value)) {
      value.forEach((tab, index) => isRecord(tab) && typeof tab.child === "string" && links.push({ id: tab.child, path: `${at}/${name}/${index}/child`, template: false }));
    }
  }
  return links;
}

function checkStructuralShape(component: WidgetComponent, at: string, checker: ValueChecker): void {
  const spec = WIDGET_COMPONENTS[component.component]!;
  for (const [name, definition] of Object.entries(spec.props)) {
    const value = component.props[name];
    const path = `${at}/${name}`;
    if (value === undefined) continue;
    if (definition.spec.kind === "child" && (typeof value !== "string" || !COMPONENT_ID.test(value))) {
      checker.fail("VALIDATION_FAILED", path, "a component id");
    }
    if (definition.spec.kind === "children") {
      const fixed = Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string");
      const template = isRecord(value) && typeof value.componentId === "string" && typeof value.path === "string"
        && Object.keys(value).length === 2 && parsePointer(value.path) !== null;
      if (!fixed && !template) {
        checker.fail("VALIDATION_FAILED", path, "children is a non-empty list of ids, or { \"componentId\": template id, \"path\": \"/list\" }");
      }
    }
    if (definition.spec.kind === "tabs") {
      if (!Array.isArray(value) || value.length < definition.spec.min || value.length > definition.spec.max) {
        checker.fail("VALIDATION_FAILED", path, `${definition.spec.min}-${definition.spec.max} tabs [{ title, child }]`);
      } else {
        value.forEach((tab, index) => {
          if (!isRecord(tab) || typeof tab.child !== "string" || tab.title === undefined) {
            checker.fail("VALIDATION_FAILED", `${path}/${index}`, "a tab is { title, child }");
          }
        });
      }
    }
  }
}

/** Components under a list template, with the id of their nearest template container. */
export function templateScopes(components: ReadonlyMap<string, WidgetComponent>): ReadonlyMap<string, string> {
  const scopes = new Map<string, string>();
  const visit = (id: string, scope: string | null, seen: Set<string>) => {
    const component = components.get(id);
    if (component === undefined || seen.has(id)) return;
    seen.add(id);
    if (scope !== null) scopes.set(id, scope);
    for (const link of childLinks(component, "")) visit(link.id, link.template ? id : scope, seen);
  };
  visit("root", null, new Set());
  return scopes;
}

function checkComposition(components: Map<string, WidgetComponent>, paths: Map<string, string>, checker: ValueChecker): void {
  if (!components.has("root")) {
    checker.fail("VALIDATION_FAILED", "/createSurface/components", "no component has id \"root\": it is where the widget starts");
    return;
  }
  const parents = new Map<string, { readonly kind: "template" | "child"; readonly parent: string }>();
  for (const [id, component] of components) {
    for (const link of childLinks(component, paths.get(id)!)) {
      const child = components.get(link.id);
      if (child === undefined) {
        checker.fail("VALIDATION_FAILED", link.path, `no component has id "${link.id}"`);
        continue;
      }
      if (link.id === "root") {
        checker.fail("VALIDATION_FAILED", link.path, "root cannot be a child");
        continue;
      }
      // A template is instantiated per item, so several lists may share one; a fixed child has one parent.
      const kind = link.template ? "template" : "child";
      const earlier = parents.get(link.id);
      if (earlier !== undefined && (earlier.kind === "child" || kind === "child")) {
        checker.fail("VALIDATION_FAILED", link.path, `"${link.id}" already belongs to "${earlier.parent}": each component has one parent, only list templates can be shared`);
        continue;
      }
      parents.set(link.id, { kind, parent: id });
      if (component.component === "Button" && !BUTTON_CHILDREN.has(child.component)) {
        checker.fail("UNALLOWED_CHILD", link.path, `a Button shows a Text or an Icon, not a ${child.component}`);
      }
      if (component.component === "Tabs" && child.component === "Tabs") {
        checker.fail("UNALLOWED_CHILD", link.path, "tabs cannot hold tabs");
      }
    }
  }
  const reached = new Set<string>();
  const walk = (id: string, trail: Set<string>) => {
    if (trail.has(id)) {
      checker.fail("VALIDATION_FAILED", paths.get(id)!, `"${id}" contains itself`);
      return;
    }
    if (reached.has(id)) return;
    reached.add(id);
    const component = components.get(id);
    if (component === undefined) return;
    const next = new Set(trail).add(id);
    for (const link of childLinks(component, "")) walk(link.id, next);
  };
  walk("root", new Set());
  for (const [id] of components) {
    if (!reached.has(id)) checker.fail("VALIDATION_FAILED", paths.get(id)!, `"${id}" is not reachable from root, so it would never show`);
  }
  const scopes = templateScopes(components);
  for (const [id, scope] of scopes) {
    const component = components.get(id)!;
    if (NOT_IN_TEMPLATE.has(component.component)) {
      checker.fail("UNALLOWED_PARENT", paths.get(id)!, `a ${component.component} cannot repeat inside the list template of "${scope}"`);
    }
  }
}

function readComponents(raw: unknown, checker: ValueChecker): { components: Map<string, WidgetComponent>; paths: Map<string, string> } {
  const components = new Map<string, WidgetComponent>();
  const paths = new Map<string, string>();
  if (!Array.isArray(raw) || raw.length === 0) {
    checker.fail("VALIDATION_FAILED", "/createSurface/components", "components is a non-empty list");
    return { components, paths };
  }
  if (raw.length > WIDGET_COMPONENTS_MAX) {
    checker.fail("VALIDATION_FAILED", "/createSurface/components", `at most ${WIDGET_COMPONENTS_MAX} components: a widget is small`);
  }
  raw.forEach((item, index) => {
    const at = `/createSurface/components/${index}`;
    if (!isRecord(item)) {
      checker.fail("VALIDATION_FAILED", at, "a component is { id, component, ...props }");
      return;
    }
    const id = item.id;
    const name = item.component;
    if (typeof id !== "string" || !COMPONENT_ID.test(id)) {
      checker.fail("VALIDATION_FAILED", `${at}/id`, "id starts with a letter and has letters, digits, _ or -, up to 40");
      return;
    }
    if (components.has(id)) {
      checker.fail("INTEGRITY_ERROR", `${at}/id`, `id "${id}" is used twice`);
      return;
    }
    const spec = typeof name === "string" ? WIDGET_COMPONENTS[name] : undefined;
    if (spec === undefined) {
      const hint = name === "TextField" || name === "DateTimeInput" ? ": a widget has no keyboard, ask in the chat instead" : "";
      checker.fail("VALIDATION_FAILED", `${at}/component`, `${String(name)} is not in the catalog (${Object.keys(WIDGET_COMPONENTS).join(", ")})${hint}`);
      return;
    }
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (COMPONENT_COMMON_KEYS.has(key)) continue;
      if (spec.props[key] === undefined) checker.fail("VALIDATION_FAILED", `${at}/${key}`, `${name} has no property ${key}`);
      else props[key] = value;
    }
    for (const [key, definition] of Object.entries(spec.props)) {
      if (definition.required === true && props[key] === undefined) checker.fail("VALIDATION_FAILED", `${at}/${key}`, `${name} needs ${key}: ${definition.description}`);
    }
    components.set(id, { component: name as string, id, props });
    paths.set(id, at);
  });
  return { components, paths };
}

export function validateCreateSurface(message: unknown): ValidationResult {
  const envelope = isRecord(message) ? message : {};
  const inner = isRecord(envelope.createSurface) ? envelope.createSurface : null;
  const surfaceId = inner !== null && typeof inner.surfaceId === "string" ? inner.surfaceId : "";
  const checker = createValueChecker(surfaceId);
  if (!isRecord(message) || inner === null || Object.keys(message).some((key) => key !== "version" && key !== "createSurface")) {
    checker.fail("VALIDATION_FAILED", "", "send one A2UI message: { \"version\": \"1.0\", \"createSurface\": {...} }");
    return { errors: checker.errors, ok: false };
  }
  if (message.version !== A2UI_VERSION) checker.fail("VALIDATION_FAILED", "/version", "version is \"1.0\"");
  if (!SURFACE_ID.test(surfaceId)) checker.fail("VALIDATION_FAILED", "/createSurface/surfaceId", "surfaceId is 1-64 letters, digits, _ or -, new for every widget");
  if (inner.catalogId !== WIDGET_CATALOG_ID) checker.fail("VALIDATION_FAILED", "/createSurface/catalogId", `catalogId is "${WIDGET_CATALOG_ID}"`);
  for (const key of Object.keys(inner)) {
    if (key === "theme") checker.fail("VALIDATION_FAILED", "/createSurface/theme", "theme is invalid in A2UI 1.0: colors come from the person's Telegram theme");
    else if (!SURFACE_KEYS.has(key)) checker.fail("VALIDATION_FAILED", `/createSurface/${key}`, `createSurface has no field ${key}`);
  }
  if (inner.sendDataModel !== undefined && typeof inner.sendDataModel !== "boolean") checker.fail("VALIDATION_FAILED", "/createSurface/sendDataModel", "a boolean");
  const dataModel = inner.dataModel ?? {};
  if (!isRecord(dataModel)) checker.fail("VALIDATION_FAILED", "/createSurface/dataModel", "dataModel is a JSON object");
  else if (Buffer.byteLength(JSON.stringify(dataModel), "utf8") > DATA_MODEL_MAX_BYTES) {
    checker.fail("VALIDATION_FAILED", "/createSurface/dataModel", `dataModel is at most ${DATA_MODEL_MAX_BYTES} bytes of JSON`);
  }
  const { components, paths } = readComponents(inner.components, checker);
  for (const [id, component] of components) checkStructuralShape(component, paths.get(id)!, checker);
  if (checker.errors.length === 0) checkComposition(components, paths, checker);
  if (checker.errors.length === 0) {
    const scopes = templateScopes(components);
    for (const [id, component] of components) {
      const spec = WIDGET_COMPONENTS[component.component]!;
      for (const [name, definition] of Object.entries(spec.props)) {
        const value = component.props[name];
        if (value === undefined) continue;
        if (definition.spec.kind === "tabs" && Array.isArray(value)) {
          value.forEach((tab, index) => isRecord(tab) && checker.dynamic(tab.title, "string", `${paths.get(id)}/${name}/${index}/title`, scopes.has(id)));
        } else if (component.component === "Quiz" && name === "finish") {
          checker.action(value, `${paths.get(id)}/${name}`, false, true);
        } else {
          checker.prop(definition.spec, value, `${paths.get(id)}/${name}`, scopes.has(id));
        }
      }
    }
  }
  if (checker.errors.length > 0) return { errors: checker.errors, ok: false };
  return {
    ok: true,
    surface: {
      catalogId: WIDGET_CATALOG_ID,
      components,
      dataModel: dataModel as JsonObject,
      sendDataModel: inner.sendDataModel === true,
      surfaceId,
    },
  };
}
