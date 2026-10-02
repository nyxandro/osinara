/**
 * Golden model requests of native Eve 0.40.0 for the own agent runtime.
 *
 * Drives every typical turn kind through the real webhook, queue, channel, tool surface,
 * instructions and schedules: a private chat (skill, subagent, Bash, workspace, memory), a second
 * private turn, a family group, an external group from the owner, from a bot and from a person
 * outside the family, a confirmed, a refused and an expired approval, a question answered with a
 * button, an isolated and an in-conversation scheduled run, a silent background memory review, a
 * message shown to a running turn and recovery from an empty answer. Every model request of these
 * turns is written, normalized, to `agent/runtime/testing/eve-0.40-requests/<scenario>.json`.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineEval } from "eve/evals";

import { agentScheduleRepository } from "../../../agent/lib/agent-schedules/agent-schedule-repository.js";
import type { AgentScheduleAuthorization } from "../../../agent/lib/agent-schedules/agent-schedule-context.js";
import { closeDatabase, database } from "../../../agent/lib/database.js";
import {
  normalizeReferenceCalls,
  packReferenceFile,
  type ReferenceCall,
  unpackReferenceFile,
} from "../../../agent/runtime/testing/model-request-reference.js";
import {
  REFERENCE_EXTERNAL_CHAT_ID,
  REFERENCE_FAMILY_CHAT_ID,
  REFERENCE_OWNER_TELEGRAM_ID,
  REFERENCE_PEER_BOT_TELEGRAM_ID,
  REFERENCE_SCENARIOS,
  REFERENCE_STRANGER_TELEGRAM_ID,
  type ReferenceScenario,
  referenceMarker,
} from "../agent/lib/reference-scenarios.js";

const FIXTURE_DIRECTORY = resolve("../../agent/runtime/testing/eve-0.40-requests");
const WEBHOOK_HEADERS = { "x-telegram-bot-api-secret-token": "conversation-test-secret" };
const UPDATE_ID_BASE = 910_000_000;
const UPDATE_ID_LIMIT = UPDATE_ID_BASE + 1_000;
const POLL_INTERVAL_MILLISECONDS = 100;
const POLL_ATTEMPTS = 600;
const OWNER = { id: REFERENCE_OWNER_TELEGRAM_ID, first_name: "Owner", is_bot: false };
const PEER_BOT = { id: REFERENCE_PEER_BOT_TELEGRAM_ID, first_name: "Peer bot", is_bot: true, username: "peer_bot" };
const STRANGER = { id: REFERENCE_STRANGER_TELEGRAM_ID, first_name: "Stranger", is_bot: false, username: "stranger" };
const APPROVAL_TIMEOUT_ROUTE = "/internal/hitl-approval-timeout";
const APPROVAL_TIMEOUT_TOKEN_HEADER = "x-osinara-internal-token";
// One model call per scripted step plus the answer; a subagent and Eve's empty-reply recovery add theirs.
const EXPECTED_CALLS: Readonly<Record<ReferenceScenario, number>> = {
  "private-first": 8, "private-second": 1, "family-group": 2, "external-human": 2, "external-bot": 1,
  approval: 2, question: 2, "scheduled-isolated": 2, "scheduled-conversation": 1, "memory-review": 2,
  "external-stranger": 1, "approval-denied": 2, "approval-timeout": 2, interjection: 2,
  "interjection-followup": 1, "empty-reply": 2,
};

interface Delivery {
  id: number;
  body: { text: string; reply_markup?: { inline_keyboard?: { callback_data: string; text: string }[][] } };
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MILLISECONDS));
  }
  throw new Error(`TEST_REFERENCE_STALLED: ${label}`);
}

function chat(chatId: number) {
  return chatId > 0
    ? { id: chatId, type: "private", first_name: "Owner" }
    : { id: chatId, type: "supergroup", title: chatId === REFERENCE_FAMILY_CHAT_ID ? "Family reference" : "External reference" };
}

export default defineEval({
  timeoutMs: 240_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    const db = database();
    let updates = 0;
    let messages = 0;

    async function post(update: Record<string, unknown>): Promise<number> {
      updates += 1;
      const updateId = UPDATE_ID_BASE + updates;
      const response = await t.target.fetch("/eve/v1/telegram", {
        method: "POST", headers: WEBHOOK_HEADERS, body: JSON.stringify({ update_id: updateId, ...update }),
      });
      assert.equal(response.status, 200);
      return updateId;
    }
    function sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<number> {
      messages += 1;
      return post({ message: {
        message_id: messages, date: Math.floor(Date.now() / 1_000), chat: chat(chatId), from: OWNER, text, ...extra,
      } });
    }
    async function waitForIngress(updateId: number): Promise<void> {
      await waitFor(`ingress ${updateId}`, async () => {
        const row = (await db.query<{ status: string; last_error_code: string | null }>(
          "SELECT status, last_error_code FROM telegram_ingress_updates WHERE update_id = $1", [updateId],
        )).rows[0];
        if (row?.status === "failed") throw new Error(`TEST_REFERENCE_INGRESS_FAILED: ${row.last_error_code}`);
        return row?.status === "completed" ? true : undefined;
      });
    }
    async function waitForReply(scenario: ReferenceScenario): Promise<void> {
      await waitFor(`reply ${scenario}`, async () => (await db.query(
        "SELECT 1 FROM telegram_conversation_test_deliveries WHERE body->>'text' = $1", [`reply-${referenceMarker(scenario)}`],
      )).rowCount === 1 ? true : undefined);
    }
    async function latestKeyboard(chatId: number): Promise<Delivery> {
      return waitFor(`keyboard in ${chatId}`, async () => (await db.query<Delivery>(
        `SELECT id, body FROM telegram_conversation_test_deliveries
          WHERE body->>'chat_id' = $1 AND body->'reply_markup'->'inline_keyboard' IS NOT NULL
          ORDER BY id DESC LIMIT 1`, [String(chatId)],
      )).rows[0]);
    }
    function press(chatId: number, prompt: Delivery, buttonText: string | { not: string }): Promise<number> {
      const button = prompt.body.reply_markup?.inline_keyboard?.flat().find((candidate) =>
        typeof buttonText === "string" ? candidate.text === buttonText : candidate.text !== buttonText.not);
      assert.ok(button, `Button ${JSON.stringify(buttonText)} was not delivered`);
      return post({ callback_query: {
        id: `reference-${prompt.id}`, chat_instance: `reference-${chatId}`, data: button.callback_data, from: OWNER,
        message: { message_id: prompt.id, date: Math.floor(Date.now() / 1_000), chat: chat(chatId) },
      } });
    }

    await db.query("TRUNCATE users, families, operational_incidents CASCADE");
    await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [UPDATE_ID_BASE, UPDATE_ID_LIMIT]);
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      await db.query(`CREATE TABLE telegram_conversation_test_model_requests (
        id integer GENERATED ALWAYS AS IDENTITY, scenario text NOT NULL, child boolean NOT NULL,
        call_kind text NOT NULL, request json NOT NULL)`);
      const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ('Reference family') RETURNING id")).rows[0]!;
      const owner = (await db.query<{ id: string }>(
        "INSERT INTO users(telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id", [String(REFERENCE_OWNER_TELEGRAM_ID)],
      )).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id, user_id, role) VALUES ($1, $2, 'owner')", [family.id, owner.id]);
      await db.query(
        `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, $2, 'Family reference', 'family_private', 'all')`, [family.id, String(REFERENCE_FAMILY_CHAT_ID)],
      );
      const externalGroup = (await db.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist, tool_allowlist)
         VALUES ($1, $2, 'External reference', 'external', 'all', ARRAY['pohuy'], ARRAY['remember','bash']) RETURNING id`,
        [family.id, String(REFERENCE_EXTERNAL_CHAT_ID)],
      )).rows[0]!;

      await waitForIngress(await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("private-first")));
      await waitForReply("private-first");
      const privateUpdateId = await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("private-second"));
      await waitForIngress(privateUpdateId);
      await waitForReply("private-second");

      await waitForIngress(await sendMessage(REFERENCE_FAMILY_CHAT_ID, `@osinara_bot ${referenceMarker("family-group")}`));
      await waitForReply("family-group");
      await waitForIngress(await sendMessage(REFERENCE_EXTERNAL_CHAT_ID, `@osinara_bot ${referenceMarker("external-human")}`));
      await waitForReply("external-human");
      await waitForIngress(await sendMessage(REFERENCE_EXTERNAL_CHAT_ID, `@osinara_bot ${referenceMarker("external-bot")}`, {
        from: PEER_BOT,
        reply_to_message: {
          message_id: 9_000, date: Math.floor(Date.now() / 1_000), chat: chat(REFERENCE_EXTERNAL_CHAT_ID),
          from: { id: 913, first_name: "Other bot", is_bot: true, username: "other_bot" }, text: "Previous participant message",
        },
      }));
      await waitForReply("external-bot");
      t.log("verified private, family, external human and external bot turns");

      await waitForIngress(await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("approval")));
      await waitForIngress(await press(REFERENCE_OWNER_TELEGRAM_ID, await latestKeyboard(REFERENCE_OWNER_TELEGRAM_ID), "Включить перенос"));
      await waitForReply("approval");
      assert.equal((await db.query<{ enabled: boolean }>(
        "SELECT enabled FROM external_profile_projection_policies WHERE group_id = $1", [externalGroup.id],
      )).rows[0]?.enabled, true);
      await waitForIngress(await sendMessage(REFERENCE_FAMILY_CHAT_ID, `@osinara_bot ${referenceMarker("question")}`));
      await waitForIngress(await press(REFERENCE_FAMILY_CHAT_ID, await latestKeyboard(REFERENCE_FAMILY_CHAT_ID), "Продолжить"));
      await waitForReply("question");
      t.log("verified approval and question continuations");

      const privateSession = (await db.query<{ id: string }>(
        `SELECT id FROM conversation_sessions
          WHERE owner_user_id = $1 AND scope = 'personal' AND kind = 'canonical' AND retired_at IS NULL`, [owner.id],
      )).rows[0]!;
      const scheduleAuth: AgentScheduleAuthorization = {
        applicationSessionId: privateSession.id,
        familyId: family.id,
        forumTopicId: null,
        groupId: null,
        groupType: null,
        messageThreadId: null,
        role: "owner",
        telegramChatId: String(REFERENCE_OWNER_TELEGRAM_ID),
        telegramChatType: "private",
        telegramUpdateId: String(privateUpdateId),
        telegramUserId: String(REFERENCE_OWNER_TELEGRAM_ID),
        userId: owner.id,
      };
      for (const [scenario, executionContext] of [
        ["scheduled-isolated", "isolated"], ["scheduled-conversation", "conversation"],
      ] as const) {
        const schedule = await agentScheduleRepository.create(scheduleAuth, {
          executionContext,
          firstRunAt: new Date(Date.now() + 60 * 60 * 1_000),
          maxRuns: 1,
          operationKey: `${scenario}-create`,
          recurrence: { kind: "once" },
          scenarioPrompt: `Проверь эталонный сценарий ${referenceMarker(scenario)}`,
          scope: "personal",
          timezone: "Europe/Moscow",
          title: "Эталонный сценарий",
          userRequest: "Проверяй эталонный сценарий",
        });
        await agentScheduleRepository.runNow(scheduleAuth, schedule.id, `${scenario}-run`);
        await t.target.dispatchSchedule("agent-schedule-dispatch");
        if (executionContext === "conversation") {
          // The occurrence waits in the chat queue; the internal drain is what the ingress worker pings.
          const drained = await t.target.fetch("/eve/v1/telegram-drain", { method: "POST", headers: WEBHOOK_HEADERS, body: "{}" });
          assert.equal(drained.status, 200);
        }
        await waitForReply(scenario);
      }
      t.log("verified isolated and in-conversation scheduled runs");

      // A plain participant message wakes no turn, so no inline review takes it; once it is older
      // than the release limit, the background dispatcher reviews it as a short batch.
      await waitForIngress(await sendMessage(REFERENCE_EXTERNAL_CHAT_ID,
        `Обычная реплика участника для ${referenceMarker("memory-review")}`));
      await db.query(
        `UPDATE telegram_group_messages SET sent_at = sent_at - interval '13 hours'
          WHERE conversation_id IN (SELECT id FROM application_conversations WHERE telegram_group_id = $1)`,
        [externalGroup.id],
      );
      await t.target.dispatchSchedule("memory-review-dispatch");
      // Group turns also review their own delta inline; only the background batch is this scenario.
      await waitFor("memory review", async () => {
        const batch = (await db.query<{ status: string }>(
          `SELECT batch.status::text FROM memory_review_batches batch
             JOIN application_conversations conversation ON conversation.id = batch.conversation_id
            WHERE conversation.telegram_group_id = $1 AND batch.batch_kind = 'background'`, [externalGroup.id],
        )).rows[0];
        if (batch && ["ambiguous", "failed", "skipped"].includes(batch.status)) {
          throw new Error(`TEST_REFERENCE_MEMORY_REVIEW_FAILED: ${batch.status}`);
        }
        return batch?.status === "completed" ? true : undefined;
      });
      t.log("verified silent memory review");

      await waitForIngress(await sendMessage(REFERENCE_EXTERNAL_CHAT_ID, `@osinara_bot ${referenceMarker("external-stranger")}`, { from: STRANGER }));
      await waitForReply("external-stranger");
      await waitForIngress(await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("approval-denied")));
      await waitForIngress(await press(REFERENCE_OWNER_TELEGRAM_ID, await latestKeyboard(REFERENCE_OWNER_TELEGRAM_ID), { not: "Отключить перенос" }));
      await waitForReply("approval-denied");
      assert.equal((await db.query<{ enabled: boolean }>(
        "SELECT enabled FROM external_profile_projection_policies WHERE group_id = $1", [externalGroup.id],
      )).rows[0]?.enabled, true, "A refused approval must not change the policy");
      await waitForIngress(await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("approval-timeout")));
      await latestKeyboard(REFERENCE_OWNER_TELEGRAM_ID);
      // Age the unanswered prompt past the timeout, then run the sweep the minute schedule would run.
      await db.query("UPDATE telegram_hitl_approvals SET created_at = created_at - interval '1 hour' WHERE consumed_at IS NULL");
      const swept = await t.target.fetch(APPROVAL_TIMEOUT_ROUTE, { method: "POST", headers: { [APPROVAL_TIMEOUT_TOKEN_HEADER]: "conversation-test-secret" } });
      assert.equal(swept.status, 200);
      await waitForReply("approval-timeout");
      t.log("verified external stranger, refused and expired approvals");

      const interjectionUpdate = await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("interjection"));
      // The next message is sent while the turn's command still runs, so the turn sees it in the result.
      await waitFor("interjection command", async () => (await db.query(
        "SELECT 1 FROM telegram_conversation_test_model_requests WHERE scenario = 'interjection'",
      )).rowCount === 1 ? true : undefined);
      await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("interjection-followup"));
      await waitForIngress(interjectionUpdate);
      await waitForReply("interjection");
      await waitForReply("interjection-followup");
      await waitForIngress(await sendMessage(REFERENCE_OWNER_TELEGRAM_ID, referenceMarker("empty-reply")));
      await waitForReply("empty-reply");
      t.log("verified a message shown to a running turn and recovery from an empty answer");

      const rows = (await db.query<{ call_kind: ReferenceCall["kind"]; child: boolean; request: string; scenario: ReferenceScenario }>(
        "SELECT scenario, child, call_kind, request::text AS request FROM telegram_conversation_test_model_requests ORDER BY id",
      )).rows;
      await mkdir(FIXTURE_DIRECTORY, { recursive: true });
      for (const file of await readdir(FIXTURE_DIRECTORY)) {
        if (file.endsWith(".json")) await rm(resolve(FIXTURE_DIRECTORY, file));
      }
      for (const scenario of REFERENCE_SCENARIOS) {
        const calls: ReferenceCall[] = rows.filter((row) => row.scenario === scenario).map((row) => ({
          agent: row.child ? "child" : "root", kind: row.call_kind, request: JSON.parse(row.request) as unknown,
        }));
        assert.equal(calls.length, EXPECTED_CALLS[scenario], `Model requests recorded for ${scenario}`);
        const normalized = normalizeReferenceCalls(calls);
        const file = JSON.stringify(packReferenceFile(scenario, normalized), null, 2);
        assert.equal(JSON.stringify(unpackReferenceFile(JSON.parse(file))), JSON.stringify(normalized),
          `Stored ${scenario} file does not restore the recorded requests`);
        await writeFile(resolve(FIXTURE_DIRECTORY, `${scenario}.json`), `${file}\n`);
      }
      t.log(`recorded ${rows.length} model requests in ${REFERENCE_SCENARIOS.length} scenarios`);
    } finally {
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [UPDATE_ID_BASE, UPDATE_ID_LIMIT]);
      await db.query(`DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes,
        telegram_conversation_test_model_requests`);
      await closeDatabase();
    }
  },
});
