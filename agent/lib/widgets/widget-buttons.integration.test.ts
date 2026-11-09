/**
 * PostgreSQL integration tests of buttons under a widget card and of read buttons' targets (#480).
 *
 * Constructs covered:
 * - A caption's read button for a scenario of this chat stages a widget set and becomes the card's
 *   keyboard, the caption without its markup.
 * - A read button naming an unknown scenario, answer buttons in a chat without a verified person, a
 *   caption of buttons alone and a caption over 300 characters are correctable errors before sending.
 * - In a final answer a read button naming a scenario the person cannot read becomes a plain answer.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ToolContext } from "../../runtime/tool.js";

import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import { closeDatabase, database } from "../database.js";
import { withCheckedSkipTargets } from "../reply-buttons/reply-button-delivery.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { prepareWidgetButtons } from "./widget-buttons.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

function context(attributes: Record<string, string>): ToolContext {
  return {
    callId: "call-widget",
    session: {
      auth: {
        current: { attributes, authenticator: "telegram", principalId: "user", principalType: "user" },
        initiator: null,
      },
      id: "wrun-widget",
      turn: { id: "turn-widget", sequence: 1 },
    },
  } as unknown as ToolContext;
}

const PRIVATE = { familyId: "family", role: "member", telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" };

describeWithDatabase("buttons under a widget card (#480)", () => {
  let scheduleId: string;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_reply_button_sets, agent_schedule_runs, agent_schedule_operations, agent_schedules,
         conversation_session_routes, conversation_sessions, conversation_route_generations, application_conversations,
         family_memberships, users, families CASCADE`,
    );
    const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Задачи') RETURNING id")).rows[0]!.id;
    const userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Гость') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId,
    });
    scheduleId = (await agentScheduleRepository.create({
      applicationSessionId: session.id, familyId, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, role: "owner", telegramChatId: "101", telegramChatType: "private",
      telegramUpdateId: "1000", telegramUserId: "101", userId,
    }, {
      executionContext: "isolated", firstRunAt: new Date(Date.now() + 30 * 60_000), operationKey: "create",
      recurrence: { interval: 1, kind: "hourly" }, scenarioPrompt: "Повтори задачи, если не подтверждены",
      scope: "personal", timezone: "Europe/Moscow", title: "Контроль задач", userRequest: "Повторяй каждый час",
    })).id;
  });
  afterAll(closeDatabase);

  it("stages the caption's read button and sends it as the card's keyboard", async () => {
    const buttons = await prepareWidgetButtons(
      `Задачи на сегодня: 4 <tg-button-row><tg-button type="read" schedule="${scheduleId}" style="success">✅ Задачи на день услышаны</tg-button></tg-button-row>`,
      context(PRIVATE),
      "101",
    );

    expect(buttons.caption).toBe("Задачи на сегодня: 4");
    expect(buttons.labels).toEqual(["✅ Задачи на день услышаны"]);
    expect(buttons.replyMarkup).toEqual({ inline_keyboard: [[{
      callback_data: expect.stringMatching(/^rb:[A-Za-z0-9_-]{22}:0$/u), style: "success", text: "✅ Задачи на день услышаны",
    }]] });
    const stored = (await database().query("SELECT origin, message_format, status, message_text FROM telegram_reply_button_sets")).rows;
    expect(stored).toEqual([{ message_format: "widget", message_text: "Задачи на сегодня: 4", origin: "widget", status: "staged" }]);
  });

  it.each([
    ["an unknown scenario", `Задачи <tg-button type="read" schedule="${UNKNOWN}">✅ Услышал</tg-button>`, PRIVATE],
    ["answers in a chat without a verified person", "Задачи <tg-button>✅ Да</tg-button>", { ...PRIVATE, telegramChatType: "supergroup" }],
    ["a caption of buttons alone", "<tg-button>✅ Да</tg-button>", PRIVATE],
    ["a caption over 300 characters", `${"а".repeat(301)} <tg-button>✅ Да</tg-button>`, PRIVATE],
  ])("refuses %s before sending", async (_case, caption, attributes) => {
    await expect(prepareWidgetButtons(caption, context(attributes), "101")).rejects.toThrow(/AGENT_WIDGET_INPUT_INVALID/u);
    expect((await database().query("SELECT 1 FROM telegram_reply_button_sets")).rowCount).toBe(0);
  });

  it("turns a final answer's read button for a scenario the person cannot read into a plain answer", async () => {
    const rows = await withCheckedSkipTargets([[
      { skipScheduleId: scheduleId, text: "✅ Задачи услышаны" },
      { skipScheduleId: UNKNOWN, text: "✅ Другое" },
    ]], { addresseeTelegramUserId: "101", telegramChatId: "101" }, "turn-1");

    expect(rows).toEqual([[{ skipScheduleId: scheduleId, text: "✅ Задачи услышаны" }, { text: "✅ Другое" }]]);
  });
});
