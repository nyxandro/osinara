/**
 * The built-in `todo` tool: the session's structured task list.
 *
 * Exports:
 * - `todo`: the built-in definition the model sees as `todo`.
 * - `executeTodoTool`: replaces the list when `todos` is given, then returns it with counts.
 *
 * Ported from eve 0.40.0 `runtime/framework-tools/todo.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: the list lives in the session tool state (`ctx.state`); texts are verbatim.
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
    "Use this tool to create and manage a structured task list for the current session.",
    "This helps you track progress, organize complex tasks, and demonstrate thoroughness.",
    "",
    "When to use:",
    "- Complex multistep tasks requiring 3 or more distinct steps",
    "- When the user provides multiple tasks or a numbered list",
    "- After receiving new instructions, to capture requirements",
    "- After completing a task, to mark it complete and add follow-ups",
    "",
    "When NOT to use:",
    "- Single, straightforward tasks that need no tracking",
    "- Purely conversational or informational requests",
    "",
    "Usage:",
    "- Call with `todos` to replace the entire list (full replacement write)",
    "- Call without `todos` to read the current list",
    "- Both return the full current list with status counts",
    "- Mark tasks in_progress when you start, completed when done",
    "- Only have ONE task in_progress at a time",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeTodoTool(ctx.state, input ?? {});
  },
  inputSchema: TODO_INPUT_SCHEMA,
  // A repeated full-list write leaves the same list.
  replaySafe: true,
});
