/**
 * The bot's questions about a timezone, against PostgreSQL with a fake Telegram (#451).
 *
 * Constructs covered:
 * - One message per person with the zone buttons, recorded in the chat history, counted before it
 *   is sent and never repeated after a refusal.
 * - No question once the zone is known; words without buttons when Telegram refuses the buttons.
 * - A wait past its time in every zone ends silently, keeping whether its button was pressed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { newReplyButtonToken } from "../reply-buttons/reply-button-contract.js";
import { replyButtonRepository } from "../reply-buttons/reply-button-repository.js";
import { createReminderOrWait } from "./reminder-create.js";
import { createTimezoneFollowups, type TimezoneFollowupDependencies } from "./reminder-timezone-followup.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function createPerson() {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Вопросы') RETURNING id");
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('5550001', 'Борис') RETURNING id",
  );
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family.rows[0]!.id, user.rows[0]!.id]);
  return {
    familyId: family.rows[0]!.id, forumTopicId: null, groupId: null, groupType: null, messageThreadId: null,
    role: "owner" as const, telegramChatId: "5550001", telegramChatType: "private" as const, userId: user.rows[0]!.id,
  };
}

const REQUESTED = new Date("2026-11-03T07:53:00Z");

async function wait(auth: Awaited<ReturnType<typeof createPerson>>, key: string, local: string) {
  const outcome = await createReminderOrWait(auth, {
    content: `Напоминание ${key}`, operationKey: key, recurrence: null, scope: "personal", time: { kind: "local", local },
  }, REQUESTED);
  return outcome.kind === "awaiting" ? outcome.awaiting.id : "";
}

function fakes(answers: Array<{ ok: boolean; status: number }>) {
  const sent: Array<{ body: Record<string, unknown>; method: string }> = [];
  const dependencies: TimezoneFollowupDependencies = {
    buttons: {
      activate: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
      stage: vi.fn(async (input) => ({ id: "00000000-0000-4000-8000-000000000001", markdown: `${input.messageText}\n\n[кнопки]` })),
    },
    recordDelivery: vi.fn(async () => undefined),
    send: vi.fn(async (method, body) => {
      sent.push({ body, method });
      const answer = answers.shift() ?? { ok: true, status: 200 };
      return { ...answer, body: answer.ok ? { result: { message_id: 900 + sent.length } } : { description: "refused" } };
    }),
  };
  return { dependencies, sent };
}

async function row(id: string) {
  const result = await database().query<{
    followup_pressed: boolean; followups_sent: number; last_followup_error_code: string | null;
    last_followup_message_id: string | null; next_followup_at: Date | null; status: string;
  }>("SELECT status, followups_sent, next_followup_at, last_followup_message_id, last_followup_error_code, followup_pressed FROM reminder_timezone_waits WHERE id = $1", [id]);
  return result.rows[0]!;
}

describeWithDatabase("questions about a missing timezone", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE reminder_timezone_waits, telegram_reply_button_sets, user_notification_settings, family_memberships,
                users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it("asks one person once about all their due waits, with the zone buttons, and counts it", async () => {
    const auth = await createPerson();
    const first = await wait(auth, "a", "2026-11-05T12:20:00");
    const second = await wait(auth, "b", "2026-11-06T18:00:00");
    const { dependencies, sent } = fakes([]);

    const result = await createTimezoneFollowups(dependencies).dispatch(new Date("2026-11-03T10:53:30Z"));

    expect(result).toEqual({ expired: 0, failed: 0, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(dependencies.buttons.stage).toHaveBeenCalledWith(expect.objectContaining({
      buttons: [[{ text: "Да, Москва" }, { text: "Другой пояс" }]],
      telegramChatId: "5550001",
    }));
    expect(String(sent[0]!.body.rich_message ? JSON.stringify(sent[0]!.body) : "")).toContain("Пока не поставлены напоминания");
    expect(dependencies.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "reminder_timezone_followup" }));
    expect(await row(first)).toMatchObject({ followups_sent: 1, last_followup_message_id: "901" });
    expect((await row(second)).next_followup_at?.toISOString()).toBe("2026-11-06T06:00:00.000Z");
    await expect(createTimezoneFollowups(dependencies).dispatch(new Date("2026-11-03T10:54:30Z"))).resolves.toMatchObject({ sent: 0 });
  });

  it("does not ask once the zone is known", async () => {
    const auth = await createPerson();
    await wait(auth, "a", "2026-11-05T12:20:00");
    await database().query(
      "INSERT INTO user_notification_settings (user_id, timezone, timezone_source, timezone_set_at) VALUES ($1, 'Europe/Moscow', 'person', now())",
      [auth.userId],
    );
    const { dependencies, sent } = fakes([]);
    await createTimezoneFollowups(dependencies).dispatch(new Date("2026-11-03T10:53:30Z"));
    expect(sent).toHaveLength(0);
  });

  it("sends words without buttons when Telegram refuses them, and never repeats a refused question", async () => {
    const auth = await createPerson();
    const plain = await wait(auth, "a", "2026-11-05T12:20:00");
    const { dependencies, sent } = fakes([{ ok: false, status: 400 }]);
    await createTimezoneFollowups(dependencies).dispatch(new Date("2026-11-03T10:53:30Z"));
    expect(sent.map((call) => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
    expect(dependencies.buttons.discard).toHaveBeenCalled();
    expect(await row(plain)).toMatchObject({ last_followup_error_code: null, last_followup_message_id: "902" });

    await database().query("TRUNCATE reminder_timezone_waits CASCADE");
    const blocked = await wait(auth, "b", "2026-11-05T12:20:00");
    const refused = fakes([{ ok: false, status: 403 }]);
    await expect(createTimezoneFollowups(refused.dependencies).dispatch(new Date("2026-11-03T10:53:30Z")))
      .resolves.toMatchObject({ failed: 1, sent: 0 });
    expect(await row(blocked)).toMatchObject({ followups_sent: 1, last_followup_error_code: "AGENT_REMINDER_TIMEZONE_FOLLOWUP_FAILED" });
    expect(refused.sent).toHaveLength(1);
  });

  it("ends a wait past its time everywhere without a message and keeps whether its button was pressed", async () => {
    const auth = await createPerson();
    const id = await wait(auth, "a", "2026-11-05T12:20:00");
    const set = await replyButtonRepository.stageForReminder({
      addresseeTelegramUserId: "5550001", buttons: [[{ text: "Да, Москва" }]], messageText: "Вопрос",
      reminderId: null, telegramChatId: "5550001", telegramChatType: "private", token: newReplyButtonToken(),
    });
    await database().query(
      `UPDATE telegram_reply_button_sets
       SET status = 'selected', telegram_message_id = 901, activated_at = now(), resolved_at = now(), selected_index = 0,
           selected_by_telegram_user_id = '5550001', callback_query_id = 'press-1'
       WHERE id = $1`,
      [set.id],
    );
    await database().query("UPDATE reminder_timezone_waits SET last_followup_button_id = $2 WHERE id = $1", [id, set.id]);
    const { dependencies, sent } = fakes([]);

    const result = await createTimezoneFollowups(dependencies).dispatch(new Date("2026-11-06T00:21:00Z"));

    expect(result).toMatchObject({ expired: 1, sent: 0 });
    expect(sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({ followup_pressed: true, status: "expired" });
  });
});
