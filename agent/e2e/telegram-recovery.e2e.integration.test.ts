/**
 * Deliberate failures of the application process, its approvals and its database.
 *
 * Constructs covered:
 * - The process dies in the middle of a turn: the next process continues the turn from the
 *   journal; the recorded model step is not requested again, the interrupted command is not run
 *   again (the model is told its outcome is unknown), and the reply reaches Telegram once.
 * - An approval card survives a restart; the owner's button, pressed twice, executes the action once.
 * - The application's database connections are cut in the middle of a turn: the turn still ends
 *   with one reply and nothing runs twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { database } from "../lib/database.js";
import { createE2eTables, dropE2eTables, E2E_TABLES } from "./e2e-tables.js";
import {
  CHATS, deliveredTexts, drain, E2E_APPLICATION_NAME, killAgent, message, modelCalls, postUpdate, seedFamily, startAgent,
  stopAgent, waitForIngress, waitUntil, type RunningAgent,
} from "./e2e-harness.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

const UPDATE_BASE = 920_000_000;
// A queue item keeps its lease this long after its process died (`TELEGRAM_INGRESS_LEASE_MS`).
const LEASE_EXPIRY_MILLISECONDS = 75_000;

let agent: RunningAgent;
let externalGroupId: string;

async function send(messageId: number, chatId: number, text: string): Promise<number> {
  await postUpdate(agent, { message: message({ chatId, messageId, text }), update_id: UPDATE_BASE + messageId });
  return UPDATE_BASE + messageId;
}

async function processes(marker: string): Promise<Array<{ readonly finished: boolean }>> {
  return (await database().query<{ finished: boolean }>(
    `SELECT finished FROM ${E2E_TABLES.sandboxProcesses} WHERE command LIKE $1 ORDER BY id`, [`%BASH:${marker}%`],
  )).rows;
}

async function replies(marker: string) {
  return (await deliveredTexts()).filter((item) => item.text === `reply-${marker}`);
}

(enabled ? describe : describe.skip)("Telegram conversation under failures", () => {
  beforeAll(async () => {
    await database().query("TRUNCATE users, families, operational_incidents CASCADE");
    await createE2eTables(database());
    ({ externalGroupId } = await seedFamily());
    agent = await startAgent();
  }, 90_000);
  afterAll(async () => {
    if (agent !== undefined) await stopAgent(agent);
    await dropE2eTables(database());
  });

  it("continues a turn after the process died in the middle of a command, without repeating anything", async () => {
    const marker = "e2e-1-k";
    const updateId = await send(1, CHATS.owner, marker);
    await waitUntil(async () => (await processes(marker)).length === 1, "the command started");
    await killAgent(agent);
    agent = await startAgent();

    await waitUntil(async () => (await replies(marker)).length > 0, "the recovered turn answers", 60_000);
    // The queue item waits out its dead owner's lease, then finds its turn already finished.
    await waitUntil(async () => {
      await drain(agent);
      return (await database().query("SELECT 1 FROM telegram_ingress_updates WHERE update_id = $1 AND status = 'completed'", [updateId])).rowCount === 1;
    }, "the queue item completes", LEASE_EXPIRY_MILLISECONDS + 30_000);

    expect(await processes(marker)).toEqual([{ finished: false }]);
    expect((await modelCalls(marker)).map((call) => call.tool_results)).toEqual([0, 1]);
    expect(await replies(marker)).toHaveLength(1);
  }, LEASE_EXPIRY_MILLISECONDS + 120_000);

  it("executes an approval once when its button is pressed twice after a restart", async () => {
    const marker = "e2e-2-p";
    const updateId = await send(2, CHATS.owner, marker);
    await waitForIngress(updateId);
    // The card is a placeholder message edited into the prompt with its buttons.
    const card = await waitUntil(async () => (await database().query<{ body: { message_id?: number; reply_markup: { inline_keyboard: Array<Array<{ callback_data: string; text: string }>> } }; id: number }>(
      `SELECT id, body FROM ${E2E_TABLES.telegramCalls} WHERE body->'reply_markup'->'inline_keyboard' IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )).rows[0], "the approval card");
    const cardMessageId = card.body.message_id ?? card.id;
    const approve = card.body.reply_markup.inline_keyboard.flat().find((button) => button.text === "Включить перенос")!;
    expect(approve).toBeDefined();
    await stopAgent(agent);
    agent = await startAgent();

    for (const offset of [1, 2]) {
      await postUpdate(agent, { callback_query: {
        chat_instance: "e2e-private", data: approve.callback_data, from: { first_name: "Human", id: CHATS.owner, is_bot: false },
        id: `e2e-approval-${offset}`, message: { chat: { id: CHATS.owner, type: "private" }, date: Math.floor(Date.now() / 1_000), message_id: cardMessageId },
      }, update_id: updateId + offset * 100 });
      await waitForIngress(updateId + offset * 100);
    }

    await waitUntil(async () => (await replies(marker)).length > 0, "the approved turn answers").catch(async (error: unknown) => {
      const turns = (await database().query("SELECT id, status, error_code, error_message, resumes_turn_id FROM agent_turns ORDER BY created_at DESC LIMIT 4")).rows;
      const calls = (await database().query(`SELECT method, body FROM ${E2E_TABLES.telegramCalls} ORDER BY id DESC LIMIT 4`)).rows;
      throw new Error(`${String(error)}\n${JSON.stringify(turns)}\n${JSON.stringify(calls)}\n${agent.output().slice(-3000)}`);
    });
    expect((await database().query("SELECT enabled FROM external_profile_projection_policies WHERE group_id = $1", [externalGroupId])).rows)
      .toEqual([{ enabled: true }]);
    expect((await database().query("SELECT 1 FROM external_profile_projection_policy_operations WHERE group_id = $1", [externalGroupId])).rowCount)
      .toBe(1);
    expect(await replies(marker)).toHaveLength(1);
  }, 120_000);

  it("ends a turn with one reply when its database connections are cut in the middle", async () => {
    const marker = "e2e-3-h";
    const updateId = await send(3, CHATS.family, `@osinara_bot ${marker}`);
    await waitUntil(async () => (await processes(marker)).length === 1, "the command started");
    const cut = await database().query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [E2E_APPLICATION_NAME],
    );
    expect(cut.rowCount).toBeGreaterThan(0);
    await database().query(`INSERT INTO ${E2E_TABLES.releases} (marker) VALUES ($1)`, [marker]);

    await waitForIngress(updateId);
    await waitUntil(async () => (await replies(marker)).length > 0, "the turn answers");
    expect(await processes(marker)).toEqual([{ finished: true }]);
    expect(await replies(marker)).toHaveLength(1);
  }, 120_000);
});
