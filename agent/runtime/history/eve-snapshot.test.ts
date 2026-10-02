import { encode } from "cbor-x";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decodeEveTurnStepOutput } from "./eve-snapshot.js";
import { storeLikeWorkflow, turnStepOutput as snapshotOutput, type WorkflowCodec as Codec } from "./eve-snapshot-fixtures.js";
import { modelHistoryArbitrary } from "./model-message-arbitraries.js";

const SESSION_ID = "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR";

const turnStepOutput = (session: Record<string, unknown>, context: Record<string, unknown> = {}) =>
  snapshotOutput(SESSION_ID, session, context);

const HISTORY = [
  { role: "user", content: "<telegram_context>\nchat_id: 912\n</telegram_context>" },
  { role: "user", content: "Привет" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "думаю", providerOptions: { openaiCompatible: { reasoning: "x" } } },
      { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls", timeout: 5 }, providerExecuted: undefined },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "json", value: { stdout: "a" } } }] },
  { role: "assistant", content: [{ type: "text", text: "Готово" }] },
];

describe("Eve turn step snapshot decoding", () => {
  it.each(["zstd", "gzip", "none"] as const)("reads history, compaction counters and announced skills (%s)", (codec) => {
    const stored = storeLikeWorkflow(turnStepOutput({
      sessionId: SESSION_ID,
      history: HISTORY,
      compaction: { lastKnownInputTokens: 153733, lastKnownPromptMessageCount: 424 },
      state: { "eve.todo": { items: [{ content: "проверить", status: "pending" }] } },
    }, { "eve.dynamicSkillManifest": { scoped: [{ name: "pohuy", description: "Режим мата" }] } }), codec);

    expect(decodeEveTurnStepOutput(stored)).toEqual({
      sessionId: SESSION_ID,
      history: HISTORY,
      compaction: { lastKnownInputTokens: 153733, lastKnownPromptMessageCount: 424 },
      todo: { items: [{ content: "проверить", status: "pending" }] },
      announcedSkills: [{ name: "pohuy", description: "Режим мата" }],
    });
  });

  it("keeps the key order of tool-call arguments, which providers receive verbatim", () => {
    const decoded = decodeEveTurnStepOutput(storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history: HISTORY }), "zstd"));

    expect(JSON.stringify(decoded.history)).toBe(JSON.stringify(HISTORY));
  });

  it("reports absent optional state as null, not as invented values", () => {
    const decoded = decodeEveTurnStepOutput(storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history: [] }), "zstd"));

    expect(decoded).toEqual({ sessionId: SESSION_ID, history: [], compaction: null, todo: null, announcedSkills: null });
  });

  it.each([
    ["an encrypted payload", () => encode(new Uint8Array(Buffer.from("encrsecret")))],
    ["an unknown format prefix", () => encode(new Uint8Array(Buffer.from("abcdpayload")))],
    ["a corrupted zstd frame", () => encode(new Uint8Array(Buffer.concat([Buffer.from("zstd"), Buffer.from("not zstd")])))],
    ["a value that is not bytes", () => encode({ output: "x" })],
    ["a snapshot of another format version", () => storeLikeWorkflow({ ...turnStepOutput({ sessionId: SESSION_ID, history: [] }), sessionState: { sessionId: SESSION_ID, version: 1, snapshot: { version: 2, session: {} } } }, "zstd")],
    ["a step output without a session snapshot", () => storeLikeWorkflow({ action: "complete" }, "zstd")],
    ["a history entry that is not a message", () => storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history: [{ role: "robot", content: "x" }] }), "zstd")],
    ["a custom serialized type such as bytes", () => storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1, 2]) }] }] }), "zstd")],
    ["a skill manifest from an unexpected resolver", () => storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history: [] }, { "eve.dynamicSkillManifest": { other: [] } }), "zstd")],
  ])("fails with the import error code on %s", (_case, stored) => {
    expect(() => decodeEveTurnStepOutput(stored())).toThrow("AGENT_EVE_HISTORY_IMPORT_FAILED");
  });

  it("returns every generated history unchanged and in key order", () => {
    fc.assert(fc.property(modelHistoryArbitrary, fc.constantFrom<Codec>("zstd", "gzip", "none"), (history, codec) => {
      const decoded = decodeEveTurnStepOutput(storeLikeWorkflow(turnStepOutput({ sessionId: SESSION_ID, history }), codec));
      expect(JSON.stringify(decoded.history)).toBe(JSON.stringify(history));
    }), { examples: [[[], "none"], [[{ role: "user", content: "" }], "zstd"]] });
  });
});
