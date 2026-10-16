/**
 * The built-in `todo` tool: the session's structured task list.
 *
 * Exports:
 * - `todo`: the built-in definition the model sees as `todo`.
 * - `executeTodoTool`: replaces the list when `todos` is given, then returns it with counts.
 *
 * The list lives in the session tool state (`ctx.state`).
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import type { SessionToolState, TodoState } from "../session/tool-state.js";
import { defineTool } from "../tool.js";

const TODO_ITEM_SCHEMA = z.strictObject({
  content: z.string().describe("Brief description of the task."),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task."),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status of the task."),
});

export const TODO_INPUT_SCHEMA = z.strictObject({
  todos: z.array(TODO_ITEM_SCHEMA).describe("The updated todo list. Omit to read the current list without modifying it.").optional(),
});

function formatTodoResult(state: TodoState) {
  const counts = { cancelled: 0, completed: 0, in_progress: 0, pending: 0, total: state.items.length };
  for (const item of state.items) counts[item.status] += 1;
  return { counts, todos: state.items };
}

export async function executeTodoTool(
  state: Pick<SessionToolState, "readTodo" | "writeTodo">,
  input: z.infer<typeof TODO_INPUT_SCHEMA>,
) {
  if (input.todos !== undefined) {
    const next: TodoState = { items: [...input.todos] };
    await state.writeTodo(next);
    return formatTodoResult(next);
  }
  return formatTodoResult((await state.readTodo()) ?? { items: [] });
}

export const todo = defineTool({
  description: [
    "Keep a list of steps of a long task in this conversation: needed when the task has three or more separate steps or the person gave several instructions at once. Not needed for a simple question or a single action.",
    "A call with todos fully replaces the list, a call without todos reads the current one; both return the whole list with counters.",
    "Mark a step in_progress when you start it and completed when it is done; only one step is in progress at a time.",
  ].join(" "),
  async execute(input, ctx) {
    return await executeTodoTool(ctx.state, input ?? {});
  },
  inputSchema: TODO_INPUT_SCHEMA,
  // A repeated full-list write leaves the same list.
  replaySafe: true,
});
