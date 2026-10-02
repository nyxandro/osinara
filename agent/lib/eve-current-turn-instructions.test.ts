/** Dynamic memory must see this turn's input without persisting a second copy in history. */
import { readFile } from "node:fs/promises";
import type { ModelMessage, UserContent } from "ai";
import type { SessionAuth } from "../runtime/context.js";
import { describe, expect, it } from "vitest";
import { memoryRetrievalQuery } from "./memory-retrieval.js";

const TOOL_LOOP = "node_modules/eve/dist/src/harness/tool-loop.js";

async function preview() {
  const source = await readFile(TOOL_LOOP, "utf8");
  const definition = source.match(
    /function osinaraInstructionTurnMessages\(e,t\)\{[\s\S]*?\}(?=function buildHarnessToolsWithDynamicSubagents)/u,
  )?.[0];
  if (!definition) throw new Error("TEST_CURRENT_TURN_PREVIEW_MISSING");
  const messages = await readFile("node_modules/eve/dist/src/harness/messages.js", "utf8");
  const normalize = messages.match(/function normalizeUserContent\(e\)\{[\s\S]*?\}(?=function resolveAssistantStepText)/u)?.[0];
  if (!normalize) throw new Error("TEST_NATIVE_MESSAGE_NORMALIZER_MISSING");
  return {
    source,
    build: new Function(`${normalize};${definition};return osinaraInstructionTurnMessages;`)() as (
      history: readonly ModelMessage[], input?: { message?: UserContent; context?: readonly string[] },
    ) => readonly ModelMessage[],
  };
}

describe("Eve current-turn instruction preview", () => {
  it("uses the new verified Telegram question, not a previous plain-text message", async () => {
    const { build, source } = await preview();
    const history: ModelMessage[] = [{ role: "user", content: "предыдущая служебная реплика" }];
    const message = '<current_telegram_message>{"text":"текущий вопрос","sourceSequence":"123"}</current_telegram_message>';
    const current = build(history, { message, context: ["контекст канала"] });
    const auth = { current: { attributes: { telegramTimelineSequence: "123" } } } as unknown as SessionAuth;
    expect(memoryRetrievalQuery(auth, current)).toBe("текущий вопрос");
    expect(history).toEqual([{ role: "user", content: "предыдущая служебная реплика" }]);
    expect(current).toHaveLength(3);
    expect(source).toContain("prepareDynamicInstructionPreamble(k,osinaraInstructionTurnMessages(B.session.history,I))");
    expect(source).toContain("prepareDynamicInstructionPreamble(k,osinaraInstructionTurnMessages(e.history,I))");
  });

  it("uses the current native-child task and preserves structured message parts", async () => {
    const { build } = await preview();
    const message: UserContent = [{ type: "text", text: "задача ребёнка" }];
    const history: ModelMessage[] = [{ role: "user", content: "вопрос родителя" }];
    const auth = { current: { attributes: { telegramTimelineSequence: "123" } } } as unknown as SessionAuth;
    const current = build(history, { message });
    expect(memoryRetrievalQuery(auth, current, true)).toBe("задача ребёнка");
    expect(current.at(-1)?.content).toEqual(message);
  });

  it("does not invent a user message for input responses or context-only wakes", async () => {
    const { build } = await preview();
    const history: ModelMessage[] = [{ role: "user", content: "исходный вопрос" }];
    expect(build(history)).toBe(history);
    expect(build(history, { context: ["причина отмены"] })).toBe(history);
    expect(build(history, { message: "   " })).toBe(history);
  });

  it("releases FIFO after a partial HITL response without completing another turn", async () => {
    const source = await readFile(TOOL_LOOP, "utf8");
    const guard = source.match(/if\(B.outcome===`unresolved`\)\{(if\(M&&[\s\S]*?createSessionWaitingEvent\(\)\);)let e=/u)?.[1];
    if (!guard) throw new Error("TEST_PARTIAL_HITL_BOUNDARY_MISSING");
    const execute = new Function("M", "t", "I", "P", "createSessionWaitingEvent",
      `return (async()=>{${guard}})();`) as (...args: unknown[]) => Promise<void>;
    for (const [mode, input, runtimeOutcome, expected] of [
      ["conversation", { inputResponses: [{ requestId: "first", optionId: "approve" }] }, "continue", 1],
      ["conversation", { inputResponses: [] }, "continue", 0],
      ["conversation", { inputResponses: [{ requestId: "first", optionId: "cancel" }] }, "resolved", 0],
      ["task", { inputResponses: [{ requestId: "first", optionId: "approve" }] }, "continue", 0],
    ] as const) {
      const events: unknown[] = [];
      await execute((event: unknown) => { events.push(event); }, { mode }, input,
        { outcome: runtimeOutcome }, () => ({ type: "session.waiting" }));
      expect(events).toEqual(expected ? [{ type: "session.waiting" }] : []);
    }
  });
});
