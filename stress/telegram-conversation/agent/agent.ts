/** Native Eve turns with a deterministic provider; all Telegram/application boundaries stay real. */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { wrapLanguageModel } from "ai";
import { setTimeout as sleep } from "node:timers/promises";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";
import { database } from "../../../agent/lib/database.js";

const testModel = mockModel(async ({ lastUserMessage, toolResults, tools }) => {
    const marker = [...(lastUserMessage ?? "").matchAll(/conversation-probe-\d+/gu)].at(-1)?.[0];
    if (!marker) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
    await database().query("INSERT INTO telegram_conversation_test_model_calls(marker) VALUES ($1)", [marker]);
    if (marker === `conversation-probe-${SESSION_MAX_COMPLETED_TURNS + 10}`) {
      return { toolCalls: [{ name: "ask_question", input: { prompt: "Продолжить проверку отмены?", allowFreeform: false,
        options: [{ id: "continue", label: "Продолжить" }] } }] };
    }
    const child = lastUserMessage?.includes(`child:${marker}`) === true;
    if (child && tools.some((tool) => tool.name === "agent" || tool.name === "remember")) {
      throw new Error("TEST_CHILD_ROOT_AUTHORITY_LEAK");
    }
    if (marker === `conversation-probe-${SESSION_MAX_COMPLETED_TURNS + 3}`) throw new Error("TEST_MODEL_FAILURE");
    if (toolResults.at(-1)?.isError) throw new Error(`TEST_WORKSPACE_TOOL_FAILED: ${JSON.stringify(toolResults.at(-1))}`);
    if (!child && [1, SESSION_MAX_COMPLETED_TURNS + 1, SESSION_MAX_COMPLETED_TURNS + 5, SESSION_MAX_COMPLETED_TURNS + 6]
      .some((ordinal) => marker === `conversation-probe-${ordinal}`)) {
      if (!toolResults.some((result) => result.name === "load_skill")) {
        return { toolCalls: [{ name: "load_skill", input: { skill: "pohuy" } }] };
      }
      if (!toolResults.some((result) => result.name === "agent" && JSON.stringify(result.output).includes(`child-${marker}`))) {
        return { toolCalls: [{ name: "agent", input: { message: `child:${marker}` } }] };
      }
    }
    if (!toolResults.some((result) => result.name === "bash" && JSON.stringify(result.output).includes(`BASH:${marker}`))) {
      return { toolCalls: [{ name: "bash", input: { command: `printf 'BASH:${marker}\\n'` } }] };
    }
    if (!toolResults.some((result) => result.name === "probe_workspace" && result.output === marker)) {
      return { toolCalls: [{ name: "probe_workspace", input: { marker } }] };
    }
    return `${child ? "child" : "reply"}-${marker}`;
});
if (typeof testModel === "string") throw new Error("TEST_MODEL_IMPLEMENTATION_MISSING");

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: wrapLanguageModel({ model: testModel, middleware: {
    async wrapStream({ doStream, params }) {
      const marker = [...JSON.stringify(params.prompt)
        .matchAll(/conversation-probe-\d+/gu)].at(-1)?.[0];
      const answered = params.prompt.some((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.toolName === "ask_question"));
      if ([8, 9].some((offset) => marker === `conversation-probe-${SESSION_MAX_COMPLETED_TURNS + offset}`) ||
          marker === `conversation-probe-${SESSION_MAX_COMPLETED_TURNS + 10}` && answered) {
        if (!params.abortSignal) throw new Error("TEST_MODEL_ABORT_SIGNAL_MISSING");
        await database().query("INSERT INTO telegram_conversation_test_model_calls(marker) VALUES ($1)", [marker]);
        await sleep(30_000, undefined, { signal: params.abortSignal });
        throw new Error("TEST_NATIVE_CANCELLATION_NOT_OBSERVED");
      }
      return doStream();
    },
  } }),
  modelContextWindowTokens: 1_000_000,
});
