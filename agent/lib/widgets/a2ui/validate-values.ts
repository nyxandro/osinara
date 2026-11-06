/**
 * Checks of the values inside widget components: bindings, function calls, actions and each catalog prop.
 *
 * Exports:
 * - `ValueChecker`: collects A2UI errors for one surface while the components are checked.
 * - `createValueChecker`: the checker of one surface.
 *
 * Key constructs:
 * - Every error names the JSON Pointer of the offending field in the model's own message, so the model
 *   fixes exactly that field; all errors of a surface are collected before anything is returned.
 * - A relative path is valid only inside a list template, where it resolves against the item.
 * - Functions the catalog marks as tap-only (`openUrl`, `copyText`) are refused inside values: a value
 *   is computed when the widget is built, and these act only on a person's tap.
 * - `openUrl` takes an https page outside Telegram (`reply-button-contract.ts` keeps the same rule for
 *   buttons): a Telegram link opens without a confirmation.
 */
import { isTelegramWebAddress } from "../../telegram-rich-links.js";
import {
  type A2uiError,
  type A2uiErrorCode,
  isFunctionCall,
  isPathBinding,
  isRecord,
  parsePointer,
} from "./a2ui-types.js";
import { type PropSpec, WIDGET_FUNCTIONS } from "./catalog.js";

type ValueType = "string" | "number" | "boolean";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u;
const OPTION_VALUE = /^[A-Za-z0-9_-]{1,24}$/u;
const URL_MAX_LENGTH = 256;
const COPY_TEXT_MAX_LENGTH = 256;
const LABEL_MAX_LENGTH = 120;
const PLACEHOLDER = /(?<!\\)\$\{([^}]*)\}/gu;

export interface ValueChecker {
  readonly errors: A2uiError[];
  fail(code: A2uiErrorCode, path: string, message: string): void;
  dynamic(value: unknown, type: ValueType, path: string, inTemplate: boolean): void;
  prop(spec: PropSpec, value: unknown, path: string, inTemplate: boolean): void;
  action(value: unknown, path: string, inTemplate: boolean, eventOnly: boolean): void;
}

export function createValueChecker(surfaceId: string): ValueChecker {
  const errors: A2uiError[] = [];
  const fail = (code: A2uiErrorCode, path: string, message: string) => {
    errors.push({ code, message, path, surfaceId });
  };

  function pointer(value: string, path: string, inTemplate: boolean): void {
    if (parsePointer(value) === null) {
      fail("VALIDATION_FAILED", path, `"${value}" is not a JSON Pointer such as /tasks/0/title`);
    } else if (!value.startsWith("/") && !inTemplate) {
      fail("VALIDATION_FAILED", path, `relative path "${value}" works only inside a list template; start it with /`);
    }
  }

  function placeholders(text: string, path: string, inTemplate: boolean): void {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const expression = (match[1] ?? "").trim();
      if (expression.includes("(")) {
        fail("VALIDATION_FAILED", path, `\${${expression}}: only data paths go inside formatString here; call functions as separate values`);
      } else {
        pointer(expression, path, inTemplate);
      }
    }
  }

  function call(value: { "@call": string; args?: Record<string, unknown> }, type: ValueType, path: string, inTemplate: boolean): void {
    const name = value["@call"];
    const spec = WIDGET_FUNCTIONS[name];
    if (spec === undefined) {
      fail("VALIDATION_FAILED", `${path}/@call`, `function ${name} is not in the catalog: use ${Object.keys(WIDGET_FUNCTIONS).filter((key) => WIDGET_FUNCTIONS[key]?.onTapOnly !== true).join(", ")}`);
      return;
    }
    if (spec.onTapOnly === true) {
      fail("VALIDATION_FAILED", `${path}/@call`, `${name} runs only on a tap: put it in a Button's action.functionCall`);
      return;
    }
    if (spec.returns !== type) {
      fail("VALIDATION_FAILED", `${path}/@call`, `${name} returns a ${spec.returns}, but a ${type} is expected here`);
      return;
    }
    args(name, value.args, `${path}/args`, inTemplate);
  }

  function args(name: string, given: unknown, path: string, inTemplate: boolean): void {
    const spec = WIDGET_FUNCTIONS[name]!;
    if (!isRecord(given)) {
      fail("VALIDATION_FAILED", path, `${name} needs args: { ${Object.keys(spec.args).join(", ")} }`);
      return;
    }
    for (const key of Object.keys(given)) {
      if (spec.args[key] === undefined) fail("VALIDATION_FAILED", `${path}/${key}`, `${name} has no argument ${key}`);
    }
    for (const [key, arg] of Object.entries(spec.args)) {
      const argValue = given[key];
      if (argValue === undefined) {
        if (arg.required === true) fail("VALIDATION_FAILED", `${path}/${key}`, `${name} needs ${key}: ${arg.description}`);
        continue;
      }
      if (arg.type === "booleanList") {
        if (!Array.isArray(argValue) || argValue.length === 0) fail("VALIDATION_FAILED", `${path}/${key}`, `${key} is a non-empty list of booleans`);
        else argValue.forEach((item, index) => dynamic(item, "boolean", `${path}/${key}/${index}`, inTemplate));
      } else if (arg.type === "value") {
        if (!(typeof argValue === "string" || isPathBinding(argValue) || isFunctionCall(argValue))) {
          fail("VALIDATION_FAILED", `${path}/${key}`, `${key} is a string, a { @path } or a { @call }`);
        } else {
          dynamic(argValue, "string", `${path}/${key}`, inTemplate);
        }
      } else {
        dynamic(argValue, arg.type, `${path}/${key}`, inTemplate);
      }
    }
    if (name === "formatString" && typeof given.value === "string") placeholders(given.value, `${path}/value`, inTemplate);
  }

  function dynamic(value: unknown, type: ValueType, path: string, inTemplate: boolean): void {
    if (typeof value === type) return;
    if (isPathBinding(value)) {
      pointer(value["@path"], `${path}/@path`, inTemplate);
      return;
    }
    if (isFunctionCall(value)) {
      call(value, type, path, inTemplate);
      return;
    }
    fail("VALIDATION_FAILED", path, `expected a ${type}, a { "@path": pointer } or a { "@call": function }`);
  }

  function shortText(value: unknown, path: string, max: number, what: string): boolean {
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
      fail("VALIDATION_FAILED", path, `${what} is a text of 1-${max} characters`);
      return false;
    }
    return true;
  }

  function onTapCall(value: unknown, path: string, inTemplate: boolean): void {
    if (!isFunctionCall(value) || (value["@call"] !== "openUrl" && value["@call"] !== "copyText")) {
      fail("VALIDATION_FAILED", path, "functionCall is { \"@call\": \"openUrl\" | \"copyText\", \"args\": {...} }");
      return;
    }
    const name = value["@call"];
    args(name, value.args, `${path}/args`, inTemplate);
    const given = isRecord(value.args) ? value.args : {};
    if (name === "openUrl" && typeof given.url === "string") {
      const url = given.url;
      if (url.length > URL_MAX_LENGTH || !/^https:\/\//u.test(url) || isTelegramWebAddress(url)) {
        fail("VALIDATION_FAILED", `${path}/args/url`, `openUrl takes an https web page outside Telegram, up to ${URL_MAX_LENGTH} characters`);
      }
    }
    if (name === "copyText" && typeof given.text === "string" && (given.text.length === 0 || given.text.length > COPY_TEXT_MAX_LENGTH)) {
      fail("VALIDATION_FAILED", `${path}/args/text`, `copyText takes 1-${COPY_TEXT_MAX_LENGTH} characters`);
    }
  }

  function action(value: unknown, path: string, inTemplate: boolean, eventOnly: boolean): void {
    if (!isRecord(value) || (value.event === undefined) === (value.functionCall === undefined) || Object.keys(value).length !== 1) {
      fail("VALIDATION_FAILED", path, eventOnly ? "action is { \"event\": { name, userMessage? } }" : "action is exactly one of { \"event\": {...} } or { \"functionCall\": {...} }");
      return;
    }
    if (value.functionCall !== undefined) {
      if (eventOnly) fail("VALIDATION_FAILED", `${path}/functionCall`, "only an event goes here");
      else onTapCall(value.functionCall, `${path}/functionCall`, inTemplate);
      return;
    }
    const event = value.event;
    if (!isRecord(event)) {
      fail("VALIDATION_FAILED", `${path}/event`, "event is { name, context?, userMessage? }");
      return;
    }
    for (const key of Object.keys(event)) {
      if (!["name", "context", "userMessage"].includes(key)) fail("VALIDATION_FAILED", `${path}/event/${key}`, `event has no field ${key}`);
    }
    if (typeof event.name !== "string" || !IDENTIFIER.test(event.name)) {
      fail("VALIDATION_FAILED", `${path}/event/name`, "event name is an identifier of letters, digits and _ such as menu_done");
    }
    if (event.userMessage !== undefined) dynamic(event.userMessage, "string", `${path}/event/userMessage`, inTemplate);
    if (event.context !== undefined) {
      if (eventOnly) {
        fail("VALIDATION_FAILED", `${path}/event/context`, "the quiz sends { score, total } itself; no context here");
      } else if (!isRecord(event.context)) {
        fail("VALIDATION_FAILED", `${path}/event/context`, "context is an object of named values");
      } else {
        for (const [key, item] of Object.entries(event.context)) {
          if (!IDENTIFIER.test(key)) fail("VALIDATION_FAILED", `${path}/event/context/${key}`, "context keys are identifiers");
          else if (!(typeof item === "number" || typeof item === "boolean")) dynamic(item, "string", `${path}/event/context/${key}`, inTemplate);
        }
      }
    }
  }

  function prop(spec: PropSpec, value: unknown, path: string, inTemplate: boolean): void {
    switch (spec.kind) {
      case "string":
        shortText(value, path, spec.max, "this");
        return;
      case "number":
        if (typeof value !== "number" || value < spec.min || value > spec.max || (spec.integer === true && !Number.isInteger(value))) {
          fail("VALIDATION_FAILED", path, `a ${spec.integer === true ? "whole " : ""}number from ${spec.min} to ${spec.max}`);
        }
        return;
      case "dynamicString":
        dynamic(value, "string", path, inTemplate);
        return;
      case "dynamicNumber":
        dynamic(value, "number", path, inTemplate);
        return;
      case "dynamicBoolean":
        dynamic(value, "boolean", path, inTemplate);
        return;
      case "enum":
        if (typeof value !== "string" || !spec.values.includes(value)) fail("VALIDATION_FAILED", path, `one of: ${spec.values.join(", ")}`);
        return;
      case "child":
      case "children":
      case "tabs":
        return; // composition is checked with the whole tree (validate-surface.ts)
      case "inputPath":
        if (!isPathBinding(value) || !value["@path"].startsWith("/")) {
          fail("VALIDATION_FAILED", path, "value is { \"@path\": \"/absolute/pointer\" } to the data model");
        } else {
          pointer(value["@path"], `${path}/@path`, false);
        }
        return;
      case "options":
        if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) {
          fail("VALIDATION_FAILED", path, `${spec.min}-${spec.max} options [{ label, value }]`);
          return;
        }
        value.forEach((option, index) => {
          if (!isRecord(option)) {
            fail("VALIDATION_FAILED", `${path}/${index}`, "an option is { label, value }");
            return;
          }
          shortText(option.label, `${path}/${index}/label`, LABEL_MAX_LENGTH, "label");
          if (typeof option.value !== "string" || !OPTION_VALUE.test(option.value)) {
            fail("VALIDATION_FAILED", `${path}/${index}/value`, "value is a short id of letters, digits, _ or -");
          }
        });
        if (new Set(value.map((option, index) => isRecord(option) ? option.value : `#${index}`)).size !== value.length) {
          fail("VALIDATION_FAILED", path, "option values must differ");
        }
        return;
      case "action":
        action(value, path, inTemplate, false);
        return;
      case "stringList":
        if (isPathBinding(value)) {
          pointer(value["@path"], `${path}/@path`, inTemplate);
        } else if (!Array.isArray(value) || value.length === 0 || value.length > spec.max) {
          fail("VALIDATION_FAILED", path, `1-${spec.max} labels, or { @path } to them`);
        } else {
          value.forEach((item, index) => shortText(item, `${path}/${index}`, LABEL_MAX_LENGTH, "a label"));
        }
        return;
      case "series":
        if (!Array.isArray(value) || value.length === 0 || value.length > spec.max) {
          fail("VALIDATION_FAILED", path, `1-${spec.max} series [{ name, values }]`);
          return;
        }
        value.forEach((series, index) => {
          if (!isRecord(series)) {
            fail("VALIDATION_FAILED", `${path}/${index}`, "a series is { name, values }");
            return;
          }
          shortText(series.name, `${path}/${index}/name`, LABEL_MAX_LENGTH, "name");
          const values = series.values;
          if (isPathBinding(values)) pointer(values["@path"], `${path}/${index}/values/@path`, inTemplate);
          else if (!Array.isArray(values) || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
            fail("VALIDATION_FAILED", `${path}/${index}/values`, "values are numbers, one per label, or { @path }");
          }
        });
        return;
      case "rows":
        if (isPathBinding(value)) {
          pointer(value["@path"], `${path}/@path`, inTemplate);
        } else if (!Array.isArray(value) || value.length === 0 || value.length > spec.maxRows) {
          fail("VALIDATION_FAILED", path, `1-${spec.maxRows} rows, or { @path } to them`);
        } else {
          value.forEach((row, index) => {
            if (!Array.isArray(row) || row.length === 0 || row.length > spec.maxColumns || row.some((cell) => typeof cell !== "string" && typeof cell !== "number")) {
              fail("VALIDATION_FAILED", `${path}/${index}`, `a row is 1-${spec.maxColumns} cells of text or numbers`);
            }
          });
        }
        return;
      case "questions":
        if (!Array.isArray(value) || value.length === 0 || value.length > spec.max) {
          fail("VALIDATION_FAILED", path, `1-${spec.max} questions`);
          return;
        }
        value.forEach((question, index) => {
          const at = `${path}/${index}`;
          if (!isRecord(question)) {
            fail("VALIDATION_FAILED", at, "a question is { question, options, answer }");
            return;
          }
          shortText(question.question, `${at}/question`, 300, "question");
          const options = question.options;
          if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
            fail("VALIDATION_FAILED", `${at}/options`, "2-4 options");
          } else {
            options.forEach((option, optionIndex) => shortText(option, `${at}/options/${optionIndex}`, LABEL_MAX_LENGTH, "an option"));
            if (typeof question.answer !== "number" || !Number.isInteger(question.answer) || question.answer < 0 || question.answer >= options.length) {
              fail("VALIDATION_FAILED", `${at}/answer`, "answer is the index of the right option, from 0");
            }
          }
        });
        return;
    }
  }

  return { action, dynamic, errors, fail, prop };
}
