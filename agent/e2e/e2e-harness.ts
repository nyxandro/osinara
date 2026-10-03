/**
 * The test side of the end-to-end runs: the application as a process, Telegram updates, waiting.
 *
 * Exports:
 * - `startAgent`, `stopAgent`, `killAgent`: runs `application-under-test.ts` as a child process,
 *   waits until it serves `/v1/health`, stops it with SIGTERM or kills it with SIGKILL.
 * - `postUpdate`, `drain`: the webhook and the internal drain, as Telegram and the ingress worker
 *   call them.
 * - `waitForIngress`, `waitUntil`: polling the database until the application got there.
 * - `seedFamily`, `CHATS`: the family, its owner and the three kinds of chat the runs talk in.
 * - `deliveredTexts`, `modelCalls`: what Telegram and the model saw; `diagnose`: the recent journal.
 * - `E2E_APPLICATION_NAME`: the PostgreSQL `application_name` of the application's connections.
 *
 * Test-only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { database } from "../lib/database.js";
import { E2E_TABLES } from "./e2e-tables.js";
import { E2E_EXTERNAL_CHAT_ID } from "./scripted-model.js";

const SECRET = "e2e-webhook-secret";
const START_TIMEOUT_MILLISECONDS = 60_000;
const POLL_MILLISECONDS = 100;

export const CHATS = { external: E2E_EXTERNAL_CHAT_ID, family: -900_000_102, owner: 902 } as const;
export const E2E_APPLICATION_NAME = "osinara-e2e-agent";
export const PEER_BOT_ID = 901;

export interface RunningAgent {
  readonly output: () => string;
  readonly port: number;
  readonly process: ChildProcess;
  readonly sandboxRoot: string;
}

let started = 0;

export async function startAgent(): Promise<RunningAgent> {
  started += 1;
  const sandboxRoot = await mkdtemp(join(tmpdir(), "osinara-e2e-sandbox-"));
  const child = spawn(process.execPath, ["--import", "tsx", "agent/e2e/application-under-test.ts"], {
    env: {
      ...process.env,
      E2E_RUNNER_ID: `e2e-runner-${process.pid}-${started}`,
      E2E_SANDBOX_ROOT: sandboxRoot,
      // node-postgres names the application's connections, so a test can cut exactly them.
      PGAPPNAME: E2E_APPLICATION_NAME,
      MEMORY_EMBEDDING_BASE_URL: "http://memory-test",
      MODEL_API_KEY: "unused-e2e-key",
      TELEGRAM_BOT_TOKEN: "e2e-bot-token",
      TELEGRAM_BOT_USERNAME: "osinara_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  for (;;) {
    const port = /"code":"AGENT_RUNTIME_STARTED","port":(\d+)/u.exec(output)?.[1];
    if (port !== undefined) return { output: () => output, port: Number(port), process: child, sandboxRoot };
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      await rm(sandboxRoot, { force: true, recursive: true });
      throw new Error(`TEST_AGENT_START_FAILED:\n${output}`);
    }
    await sleep(POLL_MILLISECONDS);
  }
}

async function exited(agent: RunningAgent): Promise<void> {
  if (agent.process.exitCode !== null || agent.process.signalCode !== null) return;
  await new Promise((resolve) => agent.process.once("exit", resolve));
}

/** As the deploy stops it: SIGTERM, and the process gets its shutdown grace. */
export async function stopAgent(agent: RunningAgent): Promise<void> {
  agent.process.kill("SIGTERM");
  await exited(agent);
  await rm(agent.sandboxRoot, { force: true, recursive: true });
}

/** As if the process died: nothing it was doing gets to finish. */
export async function killAgent(agent: RunningAgent): Promise<void> {
  agent.process.kill("SIGKILL");
  await exited(agent);
  await rm(agent.sandboxRoot, { force: true, recursive: true });
}

async function post(agent: RunningAgent, path: string, body: unknown): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${agent.port}${path}`, {
    body: JSON.stringify(body), headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, method: "POST",
  });
  await response.arrayBuffer();
  return response.status;
}

export async function postUpdate(agent: RunningAgent, update: Record<string, unknown>): Promise<void> {
  const status = await post(agent, "/v1/telegram", update);
  if (status !== 200) throw new Error(`TEST_WEBHOOK_REJECTED: ${status}`);
}

export async function drain(agent: RunningAgent): Promise<void> {
  const status = await post(agent, "/v1/telegram-drain", {});
  if (status !== 200) throw new Error(`TEST_DRAIN_REJECTED: ${status}`);
}

export async function waitUntil<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMilliseconds = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`TEST_TIMEOUT: ${what}`);
    await sleep(POLL_MILLISECONDS);
  }
}

export interface IngressRow {
  readonly dispatch_session_id: string | null;
  readonly dispatch_turn_id: string | null;
  readonly last_error_code: string | null;
  readonly status: string;
}

/** The update's queue row once it reached `status`; a different terminal status fails the test. */
export async function waitForIngress(updateId: number, status: "completed" | "failed" = "completed"): Promise<IngressRow> {
  return await waitUntil(async () => {
    const row = (await database().query<IngressRow>(
      "SELECT status, last_error_code, dispatch_session_id, dispatch_turn_id FROM telegram_ingress_updates WHERE update_id = $1",
      [updateId],
    )).rows[0];
    if (row !== undefined && row.status !== status && (row.status === "completed" || row.status === "failed")) {
      throw new Error(`TEST_INGRESS_${row.status.toUpperCase()}: update ${updateId} ${row.last_error_code ?? ""}`);
    }
    return row?.status === status ? row : null;
  }, `update ${updateId} ${status}`);
}

/** What the application did recently, for a failure message: turns, tool calls, Telegram, its log. */
export async function diagnose(agent: RunningAgent): Promise<string> {
  const turns = (await database().query(
    "SELECT id, status, error_code, error_message, resumes_turn_id FROM agent_turns ORDER BY created_at DESC LIMIT 4",
  )).rows;
  const calls = (await database().query(
    "SELECT turn_id, tool_name, state, left(output::text, 300) AS output FROM agent_tool_calls ORDER BY created_at DESC LIMIT 4",
  )).rows;
  const telegram = (await database().query(`SELECT method, left(body::text, 300) AS body FROM ${E2E_TABLES.telegramCalls} ORDER BY id DESC LIMIT 4`)).rows;
  return [JSON.stringify(turns), JSON.stringify(calls), JSON.stringify(telegram), agent.output().slice(-4000)].join("\n");
}

export async function seedFamily(): Promise<{ readonly familyId: string; readonly externalGroupId: string; readonly ownerId: string }> {
  const db = database();
  const family = (await db.query<{ id: string }>("INSERT INTO families (name) VALUES ('E2E family') RETURNING id")).rows[0]!;
  const owner = (await db.query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Human') RETURNING id", [String(CHATS.owner)],
  )).rows[0]!;
  await db.query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family.id, owner.id]);
  await db.query(
    "INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode) VALUES ($1, $2, 'E2E family chat', 'family_private', 'all')",
    [family.id, String(CHATS.family)],
  );
  const external = (await db.query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist, tool_allowlist)
     VALUES ($1, $2, 'E2E external chat', 'external', 'all', ARRAY['pohuy'], ARRAY['remember', 'bash']) RETURNING id`,
    [family.id, String(CHATS.external)],
  )).rows[0]!;
  return { externalGroupId: external.id, familyId: family.id, ownerId: owner.id };
}

export async function deliveredTexts(): Promise<Array<{ readonly chatId: number; readonly id: number; readonly replyTo: number | null; readonly text: string }>> {
  return (await database().query<{ body: { chat_id: number; reply_parameters?: { message_id: number }; text?: string }; id: number }>(
    `SELECT id, body FROM ${E2E_TABLES.telegramCalls} WHERE method IN ('sendMessage', 'sendRichMessage') ORDER BY id`,
  )).rows.map((row) => ({
    chatId: Number(row.body.chat_id), id: row.id, replyTo: row.body.reply_parameters?.message_id ?? null, text: row.body.text ?? "",
  }));
}

export async function modelCalls(marker: string): Promise<Array<{ readonly role: string; readonly tool_results: number; readonly tools: string[] }>> {
  return (await database().query<{ role: string; tool_results: number; tools: string[] }>(
    `SELECT role, tool_results, tools FROM ${E2E_TABLES.modelCalls} WHERE marker = $1 ORDER BY id`, [marker],
  )).rows;
}

export function message(input: {
  readonly chatId: number;
  readonly fromId?: number;
  readonly messageId: number;
  readonly replyTo?: Record<string, unknown>;
  readonly rich?: boolean;
  readonly text: string;
}): Record<string, unknown> {
  const fromId = input.fromId ?? CHATS.owner;
  const bot = fromId === PEER_BOT_ID;
  return {
    chat: { id: input.chatId, type: input.chatId > 0 ? "private" : "supergroup", ...(input.chatId > 0 ? {} : { title: "E2E chat" }) },
    date: Math.floor(Date.now() / 1_000),
    from: { first_name: bot ? "Peer bot" : "Human", id: fromId, is_bot: bot },
    message_id: input.messageId,
    ...(input.replyTo === undefined ? {} : { reply_to_message: input.replyTo }),
    ...(input.rich === true ? { rich_message: { blocks: [{ text: input.text, type: "paragraph" }] } } : { text: input.text }),
  };
}
