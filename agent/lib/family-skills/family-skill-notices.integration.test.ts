/**
 * Family skill notices from the change's transaction to Telegram.
 *
 * Constructs covered:
 * - `enqueueFamilySkillNotice`: one notice per operation key, even when the call is replayed.
 * - `dispatchFamilySkillNotices`: a member gets theirs in their private chat and a family group in the
 *   group; someone who left the family gets nothing; a send Telegram rejected is failed, one with an
 *   unknown outcome is ambiguous and, like a send that never reported back, is not repeated.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { closeDatabase, database } from "../database.js";
import { dispatchFamilySkillNotices, enqueueFamilySkillNotice } from "./family-skill-notices.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}

async function family() {
  const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Notices') RETURNING id")).rows[0]!.id;
  const user = async (telegramId: string) => {
    const id = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $1) RETURNING id", [telegramId],
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')", [familyId, id]);
    return id;
  };
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, '-2009', 'Семья', 'family_private', 'all', '{}') RETURNING id`, [familyId],
  )).rows[0]!.id;
  return { familyId, groupId, member: await user("901"), leaver: await user("902") };
}

async function statuses(): Promise<Record<string, string>> {
  const rows = (await database().query<{ operation_key: string; status: string }>("SELECT operation_key, status FROM family_skill_notices")).rows;
  return Object.fromEntries(rows.map((row) => [row.operation_key, row.status]));
}

(enabled ? describe : describe.skip)("family skill notices", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE family_skill_notices, telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("delivers to the member's private chat and to the family group, and to nobody who left", async () => {
    const f = await family();
    await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: "a", recipient: { userId: f.member }, text: "Тебе" });
    await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: "a", recipient: { userId: f.member }, text: "Повтор" });
    await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: "b", recipient: { groupId: f.groupId }, text: "Чату" });
    await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: "c", recipient: { userId: f.leaver }, text: "Ушедшему" });
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [f.leaver]);
    const send = vi.fn(async (_input: { chatId: string; text: string }) => undefined);

    await expect(dispatchFamilySkillNotices(send)).resolves.toBe(3);

    expect(send.mock.calls.map(([input]) => input)).toEqual([{ chatId: "901", text: "Тебе" }, { chatId: "-2009", text: "Чату" }]);
    expect(await statuses()).toEqual({ a: "delivered", b: "delivered", c: "failed" });
    await expect(dispatchFamilySkillNotices(send)).resolves.toBe(0);
  });

  it("returns the unsent notices to the queue when a recipient lookup fails", async () => {
    const f = await family();
    for (const key of ["first", "second"]) {
      await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: key, recipient: { userId: f.member }, text: key });
    }
    const query = database().query.bind(database());
    const lookup = vi.spyOn(database(), "query").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).includes("JOIN family_memberships membership")) throw new Error("connection reset");
      return await (query as (...rest: unknown[]) => Promise<unknown>)(...args);
    }) as never);
    const send = vi.fn(async (_input: { chatId: string; text: string }) => undefined);

    await expect(dispatchFamilySkillNotices(send)).rejects.toThrow("connection reset");
    lookup.mockRestore();

    expect(send).not.toHaveBeenCalled();
    expect(await statuses()).toEqual({ first: "pending", second: "pending" });
    await expect(dispatchFamilySkillNotices(send)).resolves.toBe(2);
    expect(await statuses()).toEqual({ first: "delivered", second: "delivered" });
  });

  it("never repeats a send whose outcome is unknown", async () => {
    const f = await family();
    for (const key of ["rejected", "unknown", "stale"]) {
      await enqueueFamilySkillNotice(database(), { familyId: f.familyId, operationKey: key, recipient: { userId: f.member }, text: key });
    }
    await database().query(
      `UPDATE family_skill_notices SET status = 'delivering', delivery_token = gen_random_uuid(),
              delivery_started_at = now() - interval '5 minutes' WHERE operation_key = 'stale'`,
    );
    const send = vi.fn(async ({ text }: { text: string }) => {
      if (text === "rejected") throw new AppError("AGENT_SKILL_NOTICE_TELEGRAM_REJECTED", "Отклонено");
      throw new Error("socket hang up");
    });

    await dispatchFamilySkillNotices(send);
    await dispatchFamilySkillNotices(send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(await statuses()).toEqual({ rejected: "failed", stale: "ambiguous", unknown: "ambiguous" });
  });
});
