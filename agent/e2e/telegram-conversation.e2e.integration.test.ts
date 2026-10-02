/**
 * A conversation from the webhook to the Telegram reply, through the real application process.
 *
 * Constructs covered:
 * - Many turns in a row in every kind of chat — the owner's private chat, the family group and an
 *   external group with bots — with a granted skill, Bash in the sandbox and subagents; each reply
 *   reaches Telegram exactly once, each chat keeps one session, sandboxes mount what the chat may.
 * - A failing model call ends its turn without a reply and records an incident.
 * - A repeated webhook of the same update runs nothing twice.
 * - An ingress item whose completion was lost is finished from its binding, not run again.
 * - A failing turn preparation stops the turn before the model.
 * - A silent turn in a group delivers nothing and keeps why the agent woke up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { database } from "../lib/database.js";
import { createE2eTables, dropE2eTables, E2E_TABLES } from "./e2e-tables.js";
import {
  CHATS, deliveredTexts, drain, message, modelCalls, PEER_BOT_ID, postUpdate, seedFamily, startAgent, stopAgent,
  waitForIngress, waitUntil, type RunningAgent,
} from "./e2e-harness.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const UPDATE_BASE = 910_000_000;
const PREVIOUS_PARTICIPANT = {
  chat: { id: CHATS.external, type: "supergroup" }, date: Math.floor(Date.now() / 1_000),
  from: { first_name: "Other bot", id: 903, is_bot: true, username: "other_bot" }, message_id: 9000, text: "Previous participant message",
};

interface Turn {
  readonly chatId: number;
  readonly flags: string;
  readonly fromId?: number;
  readonly rich?: boolean;
}

// External group turns are addressed by @mention and alternate between a peer bot and a person.
const TURNS: readonly Turn[] = [
  ...Array.from({ length: 8 }, (_unused, index): Turn => ({
    chatId: CHATS.external, flags: index === 0 ? "msd" : index === 5 ? "mf" : "m",
    fromId: index % 2 === 0 ? PEER_BOT_ID : CHATS.owner, rich: index % 3 === 2,
  })),
  { chatId: CHATS.owner, flags: "sd" },
  { chatId: CHATS.owner, flags: "" },
  { chatId: CHATS.family, flags: "sd" },
  { chatId: CHATS.family, flags: "" },
];

let agent: RunningAgent;
let ordinal = 0;

function markerOf(flags: string): { readonly marker: string; readonly ordinal: number } {
  ordinal += 1;
  return { marker: `e2e-${ordinal}-${flags}`, ordinal };
}

async function send(turn: Turn, text?: string): Promise<{ readonly marker: string; readonly updateId: number }> {
  const { marker, ordinal: messageId } = markerOf(turn.flags);
  const body = text ?? (turn.chatId === CHATS.owner ? marker : `@osinara_bot ${marker}`);
  await postUpdate(agent, { message: message({
    chatId: turn.chatId, fromId: turn.fromId, messageId, rich: turn.rich, text: body,
    ...(turn.chatId === CHATS.external ? { replyTo: PREVIOUS_PARTICIPANT } : {}),
  }), update_id: UPDATE_BASE + messageId });
  return { marker, updateId: UPDATE_BASE + messageId };
}

(enabled ? describe : describe.skip)("Telegram conversation end-to-end", () => {
  beforeAll(async () => {
    await database().query("TRUNCATE users, families, operational_incidents CASCADE");
    await createE2eTables(database());
    await seedFamily();
    agent = await startAgent();
  }, 90_000);
  afterAll(async () => {
    if (agent !== undefined) await stopAgent(agent);
    await dropE2eTables(database());
  });

  it("answers every turn of every kind of chat once, with skills, Bash and subagents", async () => {
    const sent: Array<{ readonly marker: string; readonly turn: Turn }> = [];
    for (const turn of TURNS) {
      const { marker, updateId } = await send(turn);
      await waitForIngress(updateId);
      sent.push({ marker, turn });
    }

    const delivered = await deliveredTexts();
    for (const { marker, turn } of sent) {
      const replies = delivered.filter((item) => item.text === `reply-${marker}`);
      expect(replies.map((item) => item.chatId), marker).toEqual(turn.flags.includes("f") ? [] : [turn.chatId]);
      if (turn.flags.includes("d")) {
        const child = (await modelCalls(marker)).filter((call) => call.role === "child");
        expect(child, `${marker} delegated`).toHaveLength(1);
        expect(child[0]!.tools).not.toContain("agent");
      }
    }
    const failed = sent.find(({ turn }) => turn.flags.includes("f"))!;
    expect((await database().query("SELECT 1 FROM operational_incidents WHERE operation_key LIKE 'telegram:%'")).rowCount).toBe(1);
    expect(delivered.filter((item) => item.text.includes(failed.marker))).toEqual([]);

    const sessions = (await database().query<{ chat: string }>(
      `SELECT coalesce(g.telegram_chat_id, 'private') AS chat FROM conversation_sessions s
         LEFT JOIN telegram_groups g ON g.id = s.group_id WHERE s.retired_at IS NULL AND s.kind = 'canonical' ORDER BY chat`,
    )).rows.map((row) => row.chat);
    expect(sessions).toEqual([String(CHATS.external), String(CHATS.family), "private"].sort());
    // Each chat's sandbox mounts exactly what that chat may reach; the external group runs its
    // granted Bash in a group-only sandbox.
    const mounts = (await database().query<{ access: string; chat: string; points: string }>(
      `SELECT DISTINCT coalesce(g.telegram_chat_id, 'private') AS chat, e.access,
              (SELECT string_agg(m->>'mountPoint', ',' ORDER BY m->>'mountPoint') FROM jsonb_array_elements(e.mounts) m) AS points
         FROM ${E2E_TABLES.sandboxSessions} e
         JOIN conversation_sessions s ON s.thread_id::text = e.sandbox_session_id
         LEFT JOIN telegram_groups g ON g.id = s.group_id
        ORDER BY chat`,
    )).rows;
    expect(mounts).toEqual([
      { access: "group-tools", chat: String(CHATS.external), points: "group" },
      { access: "trusted", chat: String(CHATS.family), points: "family" },
      { access: "trusted", chat: "private", points: "family,personal" },
    ]);
  }, 240_000);

  it("runs a repeated webhook of the same update once", async () => {
    const { marker, updateId } = await send({ chatId: CHATS.owner, flags: "" });
    const update = (await database().query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM telegram_ingress_updates WHERE update_id = $1", [updateId],
    )).rows[0]!;
    await postUpdate(agent, update.payload);
    await waitForIngress(updateId);
    await postUpdate(agent, update.payload);
    await drain(agent);

    await waitUntil(async () => (await deliveredTexts()).some((item) => item.text === `reply-${marker}`), "reply");
    expect((await deliveredTexts()).filter((item) => item.text === `reply-${marker}`)).toHaveLength(1);
    expect(await modelCalls(marker)).toHaveLength(2);
  }, 60_000);

  it("finishes an item whose completion was lost from its binding, without running it again", async () => {
    const { marker, updateId } = await send({ chatId: CHATS.family, flags: "" });
    const bound = await waitForIngress(updateId);
    expect(bound.dispatch_turn_id).not.toBeNull();
    const calls = (await modelCalls(marker)).length;
    // The state a crash between the reply and the queue's own completion left behind under Eve.
    await database().query(
      `UPDATE telegram_ingress_updates SET status = 'failed', last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED',
              last_error_message = 'TEST_LOST_COMPLETION' WHERE update_id = $1`,
      [updateId],
    );
    await drain(agent);

    await waitUntil(async () => (await database().query(
      "SELECT 1 FROM telegram_ingress_updates WHERE update_id = $1 AND status = 'completed'", [updateId],
    )).rowCount === 1, "the recovered item completes");
    expect(await modelCalls(marker)).toHaveLength(calls);
    expect((await deliveredTexts()).filter((item) => item.text === `reply-${marker}`)).toHaveLength(1);
  }, 60_000);

  it("stops a turn whose preparation fails before the model is called", async () => {
    await database().query(`CREATE FUNCTION e2e_reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_REQUIRED_PREPARATION_FAILED'; END $$`);
    await database().query(`CREATE TRIGGER e2e_reject_binding BEFORE UPDATE OF eve_session_id ON conversation_sessions
      FOR EACH ROW EXECUTE FUNCTION e2e_reject_binding()`);
    try {
      const { marker, updateId } = await send({ chatId: CHATS.family, flags: "" });
      await waitUntil(async () => {
        const row = (await database().query<{ status: string }>("SELECT status FROM telegram_ingress_updates WHERE update_id = $1", [updateId])).rows[0];
        return row !== undefined && (row.status === "completed" || row.status === "failed");
      }, "preparation failure settles");
      expect(await modelCalls(marker)).toEqual([]);
      expect((await deliveredTexts()).filter((item) => item.text === `reply-${marker}`)).toEqual([]);
      expect(agent.output()).toContain("TEST_REQUIRED_PREPARATION_FAILED");
    } finally {
      await database().query("DROP TRIGGER IF EXISTS e2e_reject_binding ON conversation_sessions");
      await database().query("DROP FUNCTION IF EXISTS e2e_reject_binding()");
    }
  }, 60_000);

  it("stays silent in a group when its name was only mentioned, and keeps why it woke up", async () => {
    const silent = markerOf("x");
    const id = UPDATE_BASE + silent.ordinal;
    const before = (await database().query<{ last: number }>(`SELECT coalesce(max(id), 0) AS last FROM ${E2E_TABLES.telegramCalls}`)).rows[0]!.last;
    await postUpdate(agent, { message: message({
      chatId: CHATS.family, messageId: silent.ordinal, text: `Осинара вчера уже разбирала ${silent.marker}, не трогаем`,
    }), update_id: id });
    const row = await waitForIngress(id);

    // The model checks that the message says it woke up by name; a turn without it would fail.
    expect((await database().query<{ final_text: string | null; status: string }>(
      "SELECT status, final_text FROM agent_turns WHERE id = $1", [row.dispatch_turn_id],
    )).rows).toEqual([{ final_text: null, status: "completed" }]);
    expect(await modelCalls(silent.marker)).toHaveLength(1);
    // Nothing reached the chat: no message, no reaction (a typing status may precede the model).
    expect((await database().query<{ method: string }>(
      `SELECT method FROM ${E2E_TABLES.telegramCalls} WHERE id > $1 AND body->>'chat_id' = $2 AND method <> 'sendChatAction'`,
      [before, String(CHATS.family)],
    )).rows).toEqual([]);
  }, 60_000);
});
