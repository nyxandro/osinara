/**
 * One tool of several actions, shown in a place with only some of them.
 *
 * Export:
 * - `actionView`: the same tool under the same name, described and accepted only for `actions`.
 *
 * Key constructs:
 * - A tool that lists and changes one object (reminders, schedules, memory, threads) is offered whole
 *   where both are allowed, and as a view where only reading is: a delegated task, the silent review
 *   of a group, an external group without the right to change. The descriptor names only the view's
 *   actions, so the model does not plan a call the place must refuse.
 * - The view still refuses any other action before the tool, its approval or a right check runs: a
 *   model may send an action it read about elsewhere, for example in older history.
 * - `authorize` checks the right of the requested action, for a place whose rights are per action.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../../runtime/tool.js";

import { AppError } from "../app-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

export interface ActionPresentation {
  readonly description: string;
  readonly inputSchema: AnyToolDefinition["inputSchema"];
}

function requestedAction(input: unknown): unknown {
  return typeof input === "object" && input !== null ? (input as { action?: unknown }).action : undefined;
}

export function actionView<const Action extends string>(input: {
  readonly actions: readonly Action[];
  readonly authorize?: (ctx: ToolContext, action: Action) => Promise<void>;
  readonly definition: AnyToolDefinition;
  readonly presentation: ActionPresentation;
  readonly toolName: string;
}): AnyToolDefinition {
  const { actions, authorize, definition, presentation, toolName } = input;
  if (actions.length === 0) throw new Error(`ACTION_VIEW_EMPTY: ${toolName} needs at least one action`);
  const allowed = (action: unknown): action is Action => (actions as readonly unknown[]).includes(action);
  const approval = definition.approval;
  return defineTool({
    ...definition,
    ...presentation,
    ...(approval === undefined ? {} : {
      // The person is never asked to confirm a call this view refuses anyway.
      async approval(ctx) {
        return allowed(requestedAction(ctx.toolInput)) ? await approval.call(definition, ctx) : "not-applicable";
      },
    }),
    async execute(toolInput, ctx) {
      const action = requestedAction(toolInput);
      if (!allowed(action)) {
        // An authorization refusal: the model hears that this place does not allow it, nothing started.
        throw new AppError(
          "AGENT_TOOL_ACTION_FORBIDDEN",
          `Действие ${String(action)} инструмента ${toolName} здесь недоступно; доступны: ${actions.join(", ")}`,
        );
      }
      if (authorize !== undefined) await authorize(ctx, action);
      return await definition.execute(toolInput, ctx);
    },
  });
}
