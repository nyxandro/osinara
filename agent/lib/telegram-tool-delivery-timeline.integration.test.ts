/**
 * PostgreSQL integration tests of what a tool sends in a scenario run (#480).
 *
 * Constructs covered:
 * - A voice note or a card a scenario run sent is recorded as one of the scenario's messages, once
 *   per Telegram message, so the chat's conversation reads it and the list shows the run delivered.
 * - No reply is routed to the run's own session, which closes with the run.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ToolContext } from "../runtime/tool.js";

import { closeDatabase, database } from "./database.js";
import { recordToolDeliveryInTimeline } from "./telegram-tool-delivery-timeline.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("tool deliveries of a scenario run (#480)", () => {
  let familyId: string;
  let userId: string;

  function scenarioContext(runId: string): ToolContext {
    return {
      callId: "call-1",
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: randomUUID(),
              familyId,
              memoryScopes: ["personal"],
              scheduleScheduledFor: "2026-11-09T04:30:00.000Z",
              scheduleTitle: "Утренние задачи",
              scheduledRunId: runId,
              telegramChatId: "101",
              telegramChatType: "private",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: userId,
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun-scenario",
        turn: { id: "turn-scenario", sequence: 1 },
      },
    } as unknown as ToolContext;
  }

  beforeEach(async () => {
    await database().query("TRUNCATE proactive_deliveries, conversation_session_routes, family_memberships, users, families CASCADE");
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Задачи') RETURNING id")).rows[0]!.id;
    userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Гость') RETURNING id",
    )).rows[0]!.id;
  });
  afterAll(closeDatabase);

  it("records a voice note of the run as the scenario's message once, without a reply route", async () => {
    const runId = randomUUID();
    const target = { chatId: "101", conversationId: null, groupId: null };
    const input = { contentText: "Голосовое сообщение: доброе утро, задачи на сегодня", failureCode: "AGENT_TEST_PROJECTION_FAILED", telegramMessageId: "91" };

    await expect(recordToolDeliveryInTimeline(scenarioContext(runId), target, input)).resolves.toBe(true);
    await expect(recordToolDeliveryInTimeline(scenarioContext(runId), target, input)).resolves.toBe(true);

    const rows = (await database().query(
      `SELECT scope::text, source_kind::text, source_id::text, title, content_text, telegram_message_id::text, owner_user_id::text
         FROM proactive_deliveries`,
    )).rows;
    expect(rows).toEqual([{
      content_text: "Голосовое сообщение: доброе утро, задачи на сегодня", owner_user_id: userId, scope: "personal",
      source_id: runId, source_kind: "agent_schedule", telegram_message_id: "91", title: "Утренние задачи",
    }]);
    expect((await database().query("SELECT 1 FROM conversation_session_routes")).rowCount).toBe(0);
  });
});
