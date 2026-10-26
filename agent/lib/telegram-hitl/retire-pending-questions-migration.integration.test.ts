/**
 * `142_retire_pending_questions.sql`: a question still waiting when `ask_question` was removed.
 *
 * Constructs covered:
 * - A waiting question, own or a subagent's copy, becomes an approval the timeout sweep cancels.
 * - Calls of finished turns and every approval stay as they were.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const TEST_SCHEMA = "retire_pending_questions_test";
const APPROVE_CANCEL = [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }];

describeWithDatabase("142 retire pending questions migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("turns only waiting questions into approvals", async () => {
    const migration = await readFile(resolve("migrations/142_retire_pending_questions.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE agent_turns (id text PRIMARY KEY, status text NOT NULL);
        CREATE TABLE agent_tool_calls (
          turn_id text NOT NULL, call_id text NOT NULL, state text NOT NULL, input_request json,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE telegram_hitl_approvals (id text PRIMARY KEY, request_kind text, consumed_at timestamptz);
        INSERT INTO agent_turns VALUES ('waiting', 'waiting_input'), ('parent', 'waiting_input'), ('failed', 'failed');
        INSERT INTO agent_tool_calls (turn_id, call_id, state, input_request) VALUES
          ('waiting', 'free', 'awaiting_input', '{"kind":"question","prompt":"Как назвать?","requestId":"free"}'),
          ('waiting', 'approval', 'awaiting_input', '{"kind":"tool-approval","options":[{"id":"approve","label":"Approve"}],"requestId":"a"}'),
          ('parent', 'delegate', 'awaiting_input', '{"kind":"subagent","childSessionId":"child","requests":[{"kind":"question","requestId":"q"},{"kind":"tool-approval","requestId":"b","options":[]}]}'),
          ('failed', 'old', 'awaiting_input', '{"kind":"question","prompt":"Пароль?","requestId":"old"}');
        INSERT INTO telegram_hitl_approvals VALUES ('open', 'question', NULL), ('answered', 'question', now()), ('card', 'tool-approval', NULL);
      `);

      await client.query(migration);

      const calls = await client.query<{ call_id: string; input_request: Record<string, unknown> }>(
        "SELECT call_id, input_request FROM agent_tool_calls ORDER BY call_id");
      const byId = Object.fromEntries(calls.rows.map((row) => [row.call_id, row.input_request]));
      expect(byId.free).toEqual({ kind: "tool-approval", options: APPROVE_CANCEL, prompt: "Как назвать?", requestId: "free" });
      expect(byId.approval).toEqual({ kind: "tool-approval", options: [{ id: "approve", label: "Approve" }], requestId: "a" });
      expect(byId.delegate).toEqual({ childSessionId: "child", kind: "subagent", requests: [
        { kind: "tool-approval", options: APPROVE_CANCEL, requestId: "q" },
        { kind: "tool-approval", options: [], requestId: "b" },
      ] });
      expect(byId.old).toEqual({ kind: "question", prompt: "Пароль?", requestId: "old" });
      const approvals = await client.query<{ id: string; request_kind: string }>(
        "SELECT id, request_kind FROM telegram_hitl_approvals ORDER BY id");
      expect(approvals.rows).toEqual([
        { id: "answered", request_kind: "question" },
        { id: "card", request_kind: "tool-approval" },
        { id: "open", request_kind: "tool-approval" },
      ]);
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  });
});
