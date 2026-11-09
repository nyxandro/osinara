/**
 * PostgreSQL integration tests of the scenario a widget press names (#480).
 *
 * Constructs covered:
 * - A widget sent by an isolated scenario run is found by the run's turn, with the run's moment in the
 *   scenario's own timezone.
 * - A widget of a wake-up (a conversation run sharing the chat's session) or of a live turn names no
 *   scenario.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { AgentScheduleAuthorization } from "../agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { widgetRepository } from "./widget-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

const SURFACE = { actions: [], baked: {}, bindings: [], frozen: [], sendDataModel: false, slots: [] };

describeWithDatabase("the scenario a widget press names (#480)", () => {
  let auth: AgentScheduleAuthorization;

  async function scheduleWithRun(executionContext: "conversation" | "isolated", agentTurnId: string) {
    const schedule = await agentScheduleRepository.create(auth, {
      executionContext: "isolated",
      firstRunAt: new Date(Date.now() + 30 * 60_000),
      operationKey: `create-${agentTurnId}`,
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Озвучь задачи и пришли карточку с кнопкой",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Утренние задачи",
      userRequest: "Каждое утро озвучивай задачи",
    });
    // A wake-up is set only in answer to a chat message; its stored shape is what the press sees.
    if (executionContext === "conversation") {
      await database().query("UPDATE agent_schedules SET execution_context = 'conversation', max_runs = 3 WHERE id = $1", [schedule.id]);
    }
    await database().query(
      `INSERT INTO agent_schedule_runs (schedule_id, family_id, scheduled_for, status, lease_token, agent_turn_id)
       VALUES ($1, $2, '2026-11-09T04:30:00Z', 'completed', gen_random_uuid(), $3)`,
      [schedule.id, auth.familyId, agentTurnId],
    );
    return schedule;
  }

  async function widgetOf(agentTurnId: string, messageId: string) {
    return await widgetRepository.save({
      agentSessionId: "wrun_1", agentTurnId, caption: "Задачи на сегодня", dataModel: {},
      surface: SURFACE, surfaceId: `tasks_${messageId}`, telegramChatId: "101", telegramMessageId: messageId,
    });
  }

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_widget_queries, telegram_widgets, agent_schedule_runs, agent_schedule_operations, agent_schedules,
         conversation_session_routes, conversation_sessions, conversation_route_generations, application_conversations,
         telegram_ingress_updates, telegram_ingress_queues, family_memberships, users, families CASCADE`,
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
    auth = {
      applicationSessionId: session.id, familyId, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, role: "owner", telegramChatId: "101", telegramChatType: "private",
      telegramUpdateId: "1000", telegramUserId: "101", userId,
    };
  });
  afterAll(closeDatabase);

  it("finds the isolated scenario run that sent the widget, at its local moment", async () => {
    const schedule = await scheduleWithRun("isolated", "turn_scenario");
    const widget = await widgetOf("turn_scenario", "7600");

    expect(await widgetRepository.scenarioOf(widget.id)).toEqual({
      id: schedule.id, scheduledForLocal: "09.11.2026 07:30", title: "Утренние задачи",
    });
  });

  it("names no scenario for a wake-up's or a live turn's widget", async () => {
    await scheduleWithRun("conversation", "turn_wakeup");
    const wakeup = await widgetOf("turn_wakeup", "7601");
    const live = await widgetOf("turn_live", "7602");

    expect(await widgetRepository.scenarioOf(wakeup.id)).toBeNull();
    expect(await widgetRepository.scenarioOf(live.id)).toBeNull();
  });
});
