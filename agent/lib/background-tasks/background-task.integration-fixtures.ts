/**
 * Shared records for background task integration tests (#519).
 *
 * Exports:
 * - `BackgroundTaskFixture`, `createBackgroundTaskFixture`: a family with its owner and the owner's private chat.
 * - `createTestTask`: a queued task of that chat, created as the tool creates one.
 * - `truncateBackgroundTaskTables`: a clean slate for each test.
 *
 * Test-only: imported by `*.integration.test.ts` files, never by runtime code.
 */
import { database } from "../database.js";
import { backgroundTaskRepository } from "./background-task-repository.js";
import type { BackgroundTask } from "./background-task-records.js";

export interface BackgroundTaskFixture {
  readonly familyId: string;
  readonly telegramChatId: string;
  readonly userId: string;
}

let counter = 0;

export async function truncateBackgroundTaskTables(): Promise<void> {
  await database().query(
    `TRUNCATE background_task_events, background_task_messages, background_tasks, agent_turns,
      conversation_session_routes, conversation_sessions, application_conversations, family_memberships, families, users CASCADE`,
  );
}

export async function createBackgroundTaskFixture(): Promise<BackgroundTaskFixture> {
  counter += 1;
  const telegramUserId = String(700_000 + counter);
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Background tasks') RETURNING id");
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id", [telegramUserId],
  );
  const familyId = family.rows[0]!.id;
  const userId = user.rows[0]!.id;
  // The membership's trigger opens the person's private conversation (migration 051).
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
  return { familyId, telegramChatId: telegramUserId, userId };
}

export async function createTestTask(
  fixture: BackgroundTaskFixture,
  overrides: { readonly callId?: string; readonly task?: string; readonly turnId?: string } = {},
): Promise<BackgroundTask> {
  counter += 1;
  const { task } = await backgroundTaskRepository.create({
    authorUserId: fixture.userId,
    createdByCallId: overrides.callId ?? `call-${counter}`,
    createdByTurnId: overrides.turnId ?? `turn-${counter}`,
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    ingressQueueId: null,
    messageThreadId: null,
    sandboxSessionId: `sandbox-${fixture.telegramChatId}`,
    task: overrides.task ?? "Сведи сроки из всех договоров в таблицу",
    telegramChatId: fixture.telegramChatId,
    telegramChatType: "private",
    title: "Сводка договоров",
  });
  return task;
}
