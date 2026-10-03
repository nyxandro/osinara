import type { ModelMessage } from "ai";
import fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../../lib/database.js";
import { appendSessionHistory, createSessionHistory, loadSessionHistory } from "./history-repository.js";
import { createApplicationSession } from "./history.integration-fixtures.js";
import { modelHistoryArbitrary } from "./model-message-arbitraries.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const NO_STATE = { announcedSkills: null, channelState: null, initiatorAuth: null, compaction: { inputTokens: null, promptMessageCount: null }, sandbox: null, todo: null };

async function newSession(sessionId: string, history: readonly ModelMessage[] = []) {
  const { applicationSessionId } = await createApplicationSession(sessionId);
  await createSessionHistory(database(), {
    ...NO_STATE, applicationSessionId, history, parentSessionId: null, sessionId, source: "runtime",
  });
  return applicationSessionId;
}

(enabled ? describe : describe.skip)("runtime session history", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("appends turn messages after the stored ones and loads them in order", async () => {
    await newSession("wrun_HISTORY0000000000000000001", [{ role: "user", content: "первое" }]);
    await appendSessionHistory(database(), {
      sessionId: "wrun_HISTORY0000000000000000001",
      turnId: "turn_01",
      messages: [{ role: "user", content: "второе" }, { role: "assistant", content: [{ type: "text", text: "ответ" }] }],
    });

    expect((await loadSessionHistory(database(), "wrun_HISTORY0000000000000000001")).messages).toEqual([
      { role: "user", content: "первое" },
      { role: "user", content: "второе" },
      { role: "assistant", content: [{ type: "text", text: "ответ" }] },
    ]);
  });

  it("keeps carried-over state next to the history", async () => {
    const { applicationSessionId } = await createApplicationSession("wrun_HISTORY0000000000000000002");
    await createSessionHistory(database(), {
      announcedSkills: [{ name: "pohuy", description: "Режим мата" }],
      applicationSessionId,
      channelState: null,
      compaction: { inputTokens: 153733, promptMessageCount: 424 },
      initiatorAuth: null,
      history: [],
      parentSessionId: null,
      sandbox: null,
      sessionId: "wrun_HISTORY0000000000000000002",
      source: "eve_import",
      todo: { items: [{ content: "проверить", status: "pending" }] },
    });

    expect(await loadSessionHistory(database(), "wrun_HISTORY0000000000000000002")).toEqual({
      announcedSkills: [{ name: "pohuy", description: "Режим мата" }],
      compaction: { inputTokens: 153733, promptMessageCount: 424 },
      generation: 0,
      messages: [],
      todo: { items: [{ content: "проверить", status: "pending" }] },
    });
  });

  it("does not overwrite a session that already exists", async () => {
    const applicationSessionId = await newSession("wrun_HISTORY0000000000000000003", [{ role: "user", content: "исходное" }]);

    expect(await createSessionHistory(database(), {
      ...NO_STATE, applicationSessionId, history: [{ role: "user", content: "чужое" }], parentSessionId: null,
      sessionId: "wrun_HISTORY0000000000000000003", source: "runtime",
    })).toBe(false);
    expect((await loadSessionHistory(database(), "wrun_HISTORY0000000000000000003")).messages).toEqual([{ role: "user", content: "исходное" }]);
  });

  it("rejects a message the json column could not keep and writes nothing", async () => {
    await newSession("wrun_HISTORY0000000000000000004");

    await expect(appendSessionHistory(database(), {
      sessionId: "wrun_HISTORY0000000000000000004",
      turnId: "turn_01",
      messages: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1]) }] }],
    })).rejects.toThrow("AGENT_SESSION_HISTORY_MESSAGE_INVALID");
    expect((await loadSessionHistory(database(), "wrun_HISTORY0000000000000000004")).messages).toEqual([]);
  });

  it("fails on an unknown session instead of starting an empty one", async () => {
    await expect(loadSessionHistory(database(), "wrun_MISSING00000000000000000")).rejects.toThrow("AGENT_SESSION_HISTORY_MISSING");
    await expect(appendSessionHistory(database(), { sessionId: "wrun_MISSING00000000000000000", turnId: "turn_01", messages: [] }))
      .rejects.toThrow("AGENT_SESSION_HISTORY_MISSING");
  });

  it("deletes the history together with its application session", async () => {
    const applicationSessionId = await newSession("wrun_HISTORY0000000000000000005", [{ role: "user", content: "x" }]);
    await database().query("DELETE FROM conversation_sessions WHERE id = $1", [applicationSessionId]);

    expect((await database().query("SELECT 1 FROM agent_session_history WHERE session_id = $1", ["wrun_HISTORY0000000000000000005"])).rowCount).toBe(0);
  });

  it("loads every generated history back unchanged and in key order", async () => {
    let index = 0;
    await fc.assert(fc.asyncProperty(modelHistoryArbitrary, async (history) => {
      index += 1;
      const sessionId = `wrun_PROPERTY${String(index).padStart(16, "0")}`;
      await newSession(sessionId, history.slice(0, 1));
      await appendSessionHistory(database(), { sessionId, turnId: "turn_01", messages: history.slice(1) });
      expect(JSON.stringify((await loadSessionHistory(database(), sessionId)).messages)).toBe(JSON.stringify(history));
    }), { examples: [[[]], [[{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output: { type: "json", value: { b: 1, a: 2 } } }] }]]] });
  });
});
