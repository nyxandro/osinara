/**
 * Call examples on input refusals of multi-action tools.
 *
 * Constructs covered:
 * - An input refusal reaches the model with the example of the action it meant, or of every action
 *   when it named none; any other failure passes through unchanged.
 */
import { describe, expect, it } from "vitest";

import { defineTool } from "../runtime/tool.js";
import { AppError } from "./app-error.js";
import { ModelFacingError } from "./model-facing-error.js";
import { withCallExamples } from "./tool-call-examples.js";

const EXAMPLES = {
  create: { action: "create", content: "Пора позвонить врачу" },
  delete: { action: "delete", id: "<id из list_reminders>" },
};

function tool(failure: Error) {
  return withCallExamples(defineTool({
    description: "test",
    execute: async () => { throw failure; },
    inputSchema: { type: "object" },
  } as never), EXAMPLES);
}

async function refusal(failure: Error, input: unknown): Promise<unknown> {
  return await Promise.resolve(tool(failure).execute(input, {} as never)).then(() => null, (error: unknown) => error);
}

describe("call examples", () => {
  it("answers an input refusal with the example of the action the model meant", async () => {
    const error = await refusal(new AppError("AGENT_REMINDER_INPUT_INVALID", "Поле firstRunAt обязательно"), { action: "create" });

    expect(error).toBeInstanceOf(ModelFacingError);
    expect((error as ModelFacingError).contract).toMatchObject({
      category: "input",
      code: "AGENT_REMINDER_INPUT_INVALID",
      example: EXAMPLES.create,
      reason: "Поле firstRunAt обязательно",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect((error as ModelFacingError).contract.correction).toContain("action=create");
  });

  it("shows every action when the call named none it knows", async () => {
    const error = await refusal(new AppError("AGENT_REMINDER_INPUT_INVALID", "Неизвестное действие"), { action: "move" });

    expect((error as ModelFacingError).contract.example).toEqual(EXAMPLES);
  });

  it("passes any other failure through unchanged", async () => {
    const failure = new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");

    expect(await refusal(failure, { action: "delete" })).toBe(failure);
  });
});
