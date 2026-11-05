/**
 * Migration 149 integration tests: where a timezone came from and the shape of a waiting reminder.
 *
 * Constructs covered:
 * - A timezone set by the agent always carries its basis, and the source is never left implicit.
 * - A waiting reminder holds at most two follow-ups and a resolved one keeps its resolution time.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function createPerson(): Promise<{ familyId: string; userId: string }> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Пояс') RETURNING id");
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('tz-person', 'Человек') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, userId: user.rows[0]!.id };
}

const HASH = "a".repeat(64);

describeWithDatabase("migration 149: reminder timezone waits", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE reminder_timezone_waits, user_notification_settings, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("requires an explicit source and a basis for a timezone the agent set", async () => {
    const person = await createPerson();
    await expect(database().query(
      "INSERT INTO user_notification_settings (user_id, timezone, timezone_set_at) VALUES ($1, 'Europe/Moscow', now())",
      [person.userId],
    )).rejects.toThrowError(/timezone_source/);
    await expect(database().query(
      `INSERT INTO user_notification_settings (user_id, timezone, timezone_source, timezone_set_at)
       VALUES ($1, 'Europe/Moscow', 'agent', now())`,
      [person.userId],
    )).rejects.toThrowError(/user_notification_settings_agent_basis/);
    await database().query(
      `INSERT INTO user_notification_settings (user_id, timezone, timezone_source, timezone_basis, timezone_set_at)
       VALUES ($1, 'Europe/Moscow', 'agent', 'город Тула из разговора', now())`,
      [person.userId],
    );
  });

  it("bounds follow-ups and keeps a resolved wait's resolution time", async () => {
    const person = await createPerson();
    const insert = (extra: string, values: unknown[]) => database().query(
      `INSERT INTO reminder_timezone_waits
         (family_id, author_user_id, owner_user_id, scope, content, telegram_chat_id, local_first_run,
          operation_key, input_hash, expires_at${extra ? `, ${extra}` : ""})
       VALUES ($1, $2, $2, 'personal', 'Полить цветы', 'tz-person', '2026-11-05 09:00', $3, '${HASH}',
               '2026-11-05 21:00+00'${values.length ? `, ${values.map((_, index) => `$${index + 4}`).join(", ")}` : ""})`,
      [person.familyId, person.userId, `key-${extra}-${values.length}`, ...values],
    );
    await expect(insert("followups_sent", [3])).rejects.toThrowError(/followups_sent/);
    await expect(insert("status", ["expired"])).rejects.toThrowError(/check constraint/);
    await insert("status, resolved_at", ["expired", new Date("2026-11-05T21:00:00Z")]);
    await insert("", []);
  });
});
