/**
 * Ready call examples for the input refusals of tools with several actions.
 *
 * Export:
 * - `withCallExamples`: the tool unchanged, except that an input refusal of its own check reaches the
 *   model with the example call of the action it meant, or of every action when it named none it knows.
 *
 * The descriptor of such a tool states each action in a line; the example arrives only when a call
 * was wrong, so it costs nothing on every turn and spares the model guessing the shape again.
 */
import { defineTool, type ToolDefinition } from "../runtime/tool.js";

import { isAppError } from "./app-error.js";
import { ModelFacingError } from "./model-facing-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

export type CallExamples = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const INPUT_REFUSAL = /_INPUT_INVALID$/u;

function meantAction(input: unknown, examples: CallExamples): string | null {
  const action = typeof input === "object" && input !== null ? (input as { action?: unknown }).action : undefined;
  return typeof action === "string" && Object.hasOwn(examples, action) ? action : null;
}

export function withCallExamples<T extends AnyToolDefinition>(definition: T, examples: CallExamples): T {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      try {
        return await definition.execute(input, ctx);
      } catch (error) {
        if (!isAppError(error) || !INPUT_REFUSAL.test(error.code)) throw error;
        const action = meantAction(input, examples);
        throw new ModelFacingError({
          category: "input",
          code: error.code,
          correction: action === null
            ? "Выбери action и повтори вызов один раз по одному из образцов example, подставив свои значения вместо примеров и заглушек в угловых скобках."
            : `Исправь вызов по образцу example для action=${action}, подставив свои значения вместо примеров и заглушек в угловых скобках, и повтори его один раз.`,
          example: action === null ? examples : examples[action]!,
          reason: error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), ""),
          retryable: true,
          sideEffectStatus: "not_started",
        }, { isExpectedRefusal: true });
      }
    },
  }) as T;
}
