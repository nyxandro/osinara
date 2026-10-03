/**
 * The built-in `ask_question` tool: a question with options that waits for the person's answer.
 *
 * Export:
 * - `askQuestion`: the definition the model sees as `ask_question`. The runtime parks the turn on
 *   its call (`hitl/input-requests.ts`) and the answer becomes its result; it never executes.
 *
 * Ported from eve 0.40.0 `runtime/framework-tools/ask-question.ts` and the option and request
 * schemas of `runtime/input/types.ts` (Apache-2.0, see NOTICE-eve). Texts are verbatim.
 */
import { z } from "zod";

import { defineTool } from "../tool.js";

const INPUT_OPTION_SCHEMA = z.strictObject({
  description: z.string().describe("Optional additional context for this option.").optional(),
  id: z.string().describe("Stable identifier for the option."),
  label: z.string().describe("User-facing label for the option."),
  style: z.enum(["primary", "danger", "default"]).describe("Visual treatment hint for the option.").optional(),
});

export const ASK_QUESTION_INPUT_SCHEMA = z.strictObject({
  allowFreeform: z.boolean()
    .describe("Whether the user may answer with freeform text instead of selecting one of the provided options.")
    .optional(),
  options: z.array(INPUT_OPTION_SCHEMA).describe("Selectable answer options to present to the user.").optional(),
  prompt: z.string().describe("The prompt to present to the user."),
});

export const askQuestion = defineTool({
  description: "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
  async execute(): Promise<unknown> {
    throw new Error("AGENT_ASK_QUESTION_EXECUTED: ask_question is answered by a person; the runtime never executes it");
  },
  inputSchema: ASK_QUESTION_INPUT_SCHEMA,
});
