/**
 * Whether an interrupted turn may be finished by recovery (#542).
 *
 * Constructs covered:
 * - A person's turn in a private chat or a family group resumes only while the person is still in the family
 *   (a guest: while the guest is not revoked) and the family group is still connected.
 * - An external group's turn resumes while the group is connected, whoever wrote in it.
 * - A turn outside Telegram (memory review, private question) is not this check's to stop.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "../runtime/context.js";
import { closeDatabase, database } from "./database.js";
import { turnResumeAccess } from "./turn-resume-access.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture { readonly familyId: string; readonly familyGroupId: string; readonly externalGroupId: string; readonly memberId: string }

async function fixture(): Promise<Fixture> {
  const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Resume') RETURNING id")).rows[0]!.id;
  const memberId = (await database().query<{ id: string }>("INSERT INTO users (telegram_user_id, display_name) VALUES ('7001', 'Член') RETURNING id")).rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')", [familyId, memberId]);
  const group = async (chatId: string, type: string) => (await database().query<{ id: string }>(
    "INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode) VALUES ($1, $2, 'Группа', $3, 'all') RETURNING id",
    [familyId, chatId, type],
  )).rows[0]!.id;
  return { externalGroupId: await group("-1002", "external"), familyGroupId: await group("-1001", "family_private"), familyId, memberId };
}

function auth(principalId: string, attributes: Record<string, string>, authenticator = "telegram"): { current: SessionAuthContext; initiator: null } {
  return { current: { attributes, authenticator, principalId, principalType: "user" }, initiator: null };
}

describeWithDatabase("resuming an interrupted turn (#542)", () => {
  beforeEach(async () => { await database().query("TRUNCATE guest_accounts, telegram_groups, family_memberships, users, families CASCADE"); });
  afterAll(closeDatabase);

  it("resumes a member's private chat turn, and not once the member left the family", async () => {
    const f = await fixture();
    const turn = auth(f.memberId, { familyId: f.familyId, telegramChatType: "private" });
    expect(await turnResumeAccess(turn)).toBe("allowed");
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [f.memberId]);
    expect(await turnResumeAccess(turn)).toBe("revoked");
  });

  it("resumes a family group's turn only while the group is connected", async () => {
    const f = await fixture();
    const turn = auth(f.memberId, { familyId: f.familyId, groupId: f.familyGroupId, groupType: "family_private" });
    expect(await turnResumeAccess(turn)).toBe("allowed");
    await database().query("UPDATE telegram_groups SET disconnected_at = now() WHERE id = $1", [f.familyGroupId]);
    expect(await turnResumeAccess(turn)).toBe("revoked");
  });

  it("resumes an external group's turn while the group is connected, whoever wrote", async () => {
    const f = await fixture();
    // A participant outside the family has no user record: the principal is the Telegram actor.
    const turn = { current: { attributes: { familyId: f.familyId, groupId: f.externalGroupId, groupType: "external" }, authenticator: "telegram",
      principalId: "telegram_user:5555", principalType: "user" }, initiator: null } as const;
    expect(await turnResumeAccess(turn)).toBe("allowed");
    await database().query("UPDATE telegram_groups SET disconnected_at = now() WHERE id = $1", [f.externalGroupId]);
    expect(await turnResumeAccess(turn)).toBe("revoked");
  });

  it("does not resume the turn of a guest the owner revoked", async () => {
    const f = await fixture();
    const guestFamilyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Гость') RETURNING id")).rows[0]!.id;
    const guestId = (await database().query<{ id: string }>("INSERT INTO users (telegram_user_id, display_name) VALUES ('7002', 'Гость') RETURNING id")).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [guestFamilyId, guestId]);
    await database().query(
      "INSERT INTO guest_accounts (user_id, guest_family_id, host_family_id, status) VALUES ($1, $2, $3, 'active')", [guestId, guestFamilyId, f.familyId],
    );
    const turn = auth(guestId, { familyId: guestFamilyId, telegramChatType: "private" });
    expect(await turnResumeAccess(turn)).toBe("allowed");
    await database().query("UPDATE guest_accounts SET status = 'revoked', revoked_at = now() WHERE user_id = $1", [guestId]);
    expect(await turnResumeAccess(turn)).toBe("revoked");
  });

  it("leaves turns outside Telegram to their own checks", async () => {
    const f = await fixture();
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [f.memberId]);
    expect(await turnResumeAccess(auth(f.memberId, { familyId: f.familyId }, "memory-review"))).toBe("allowed");
    expect(await turnResumeAccess({ current: null, initiator: null })).toBe("allowed");
  });
});
