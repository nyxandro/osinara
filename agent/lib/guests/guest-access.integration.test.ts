/**
 * Guest access in PostgreSQL (#471).
 *
 * Constructs covered:
 * - A guest link admits its first claimant at once into a one-person family of their own, never the owner's.
 * - The same link admits nobody else; a family member is never made a guest.
 * - The owner lists guests, turns tools and skills off, and removes a guest; removal closes access.
 * - A removed guest who opens a new link comes back into the family their records were sealed in.
 * - The guest is refused in the owner's family group, as anyone outside the family.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { evaluateConversationAccess } from "../family-access.js";
import { familyRepository } from "../family-repository.js";
import { telegramRepository } from "../telegram-repository.js";
import { guestRepository, loadGuestAccessPolicy } from "./guest-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const BUILT_IN_SKILLS = new Set(["pdf", "docx"]);

async function createOwner(): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Семья') RETURNING id");
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('owner-1', 'Анна') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, ownerId: owner.rows[0]!.id };
}

async function guestLink(owner: { familyId: string; ownerId: string }, operationKey: string): Promise<string> {
  const invitation = await familyRepository.createInvitation(owner.familyId, owner.ownerId, operationKey, "guest");
  return invitation.code;
}

const PETR = { displayName: "Пётр", telegramUserId: "guest-1", username: "petr" };

describeWithDatabase("guest access", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE guest_accounts, invitations, audit_events, reminders, agent_schedules, telegram_groups, family_memberships, users, families CASCADE",
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("admits the first claimant of a guest link into a family of their own", async () => {
    const owner = await createOwner();
    const code = await guestLink(owner, "guest-call-1");

    await expect(familyRepository.claimInvitation(code, PETR)).resolves.toEqual({
      guest: "joined",
      hostOwnerTelegramUserId: "owner-1",
    });

    const identity = await telegramRepository.findIdentity("guest-1");
    expect(identity).toMatchObject({ role: "member" });
    expect(identity!.familyId).not.toBe(owner.familyId);
    const policy = await loadGuestAccessPolicy(identity!.familyId);
    expect(policy).toMatchObject({ active: true, guestUserId: identity!.userId });
    expect(policy!.disabledTools.size).toBe(0);
    // The owner's own family is nobody's guest family.
    await expect(loadGuestAccessPolicy(owner.familyId)).resolves.toBeNull();

    const invitation = await database().query<{ status: string }>("SELECT status FROM invitations");
    expect(invitation.rows[0]?.status).toBe("approved");
    // The link is spent: a second person opening it gets nothing.
    await expect(familyRepository.claimInvitation(code, { ...PETR, telegramUserId: "guest-2" })).resolves.toBe("invalid");
    await expect(telegramRepository.findIdentity("guest-2")).resolves.toBeNull();
  });

  it("never makes a family member a guest", async () => {
    const owner = await createOwner();
    const code = await guestLink(owner, "guest-call-member");

    await expect(familyRepository.claimInvitation(code, { displayName: "Анна", telegramUserId: "owner-1" }))
      .resolves.toBe("invalid");
    const open = await database().query<{ status: string }>("SELECT status FROM invitations");
    expect(open.rows[0]?.status).toBe("open");
  });

  it("refuses the guest in the owner's family group", async () => {
    const owner = await createOwner();
    await familyRepository.claimInvitation(await guestLink(owner, "guest-call-group"), PETR);
    const identity = await telegramRepository.findIdentity("guest-1");

    const decision = evaluateConversationAccess({
      actorKind: "telegram_user",
      chat: { id: "-100200", type: "supergroup" },
      identity,
      registeredGroup: {
        familyId: owner.familyId,
        groupId: "00000000-0000-4000-8000-000000000001",
        messageMode: "all",
        skillAllowlist: [],
        telegramChatId: "-100200",
        toolAllowlist: [],
        type: "family_private",
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it("lets the owner turn things off, remove the guest and bring them back", async () => {
    const owner = await createOwner();
    await familyRepository.claimInvitation(await guestLink(owner, "guest-call-a"), PETR);
    const identity = (await telegramRepository.findIdentity("guest-1"))!;

    await expect(guestRepository.configureGuest({
      builtInSkills: BUILT_IN_SKILLS,
      disabledSkills: ["pdf"],
      disabledTools: ["bash", "bash"],
      guestDisplayName: "Пётр",
      guestUserId: identity.userId,
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).resolves.toEqual({ disabledSkills: ["pdf"], disabledTools: ["bash"] });
    await expect(guestRepository.configureGuest({
      builtInSkills: BUILT_IN_SKILLS,
      disabledSkills: ["no-such-skill"],
      disabledTools: [],
      guestDisplayName: "Пётр",
      guestUserId: identity.userId,
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).rejects.toThrow(/AGENT_GUEST_SKILL_UNKNOWN/);

    const listed = await guestRepository.listGuests({ hostFamilyId: owner.familyId, ownerUserId: owner.ownerId });
    expect(listed.guests).toEqual([expect.objectContaining({
      disabledSkills: ["pdf"],
      disabledTools: ["bash"],
      displayName: "Пётр",
      guestUserId: identity.userId,
      ownSkills: [],
      status: "active",
      username: "petr",
    })]);

    // The guest's live reminder and scenario are paused with the removal, so no dispatcher fails them later.
    await database().query(
      `INSERT INTO reminders
         (family_id, scope, owner_user_id, author_user_id, content, timezone, telegram_chat_id,
          recurrence_unit, recurrence_interval, recurrence_anchor_local, due_at, available_at)
       VALUES ($1, 'personal', $2, $2, 'Позвонить врачу', 'UTC', 'guest-1', 'daily', 1, timestamp '2026-11-08 09:00:00',
               now() + interval '1 day', now() + interval '1 day')`,
      [identity.familyId, identity.userId],
    );
    await database().query(
      `INSERT INTO agent_schedules
         (family_id, author_user_id, owner_user_id, scope, title, user_request, scenario_prompt, timezone,
          recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at, telegram_chat_id, telegram_chat_type)
       VALUES ($1, $2, $2, 'personal', 'Сводка', 'Запрос', 'Сценарий', 'UTC', 'daily', 1,
               timestamp '2026-11-01 09:00:00', now() + interval '1 day', 'guest-1', 'private')`,
      [identity.familyId, identity.userId],
    );

    // A card confirmed for a name that no longer matches the guest changes nothing.
    await expect(guestRepository.revokeGuest({
      guestDisplayName: "Пётр Иванов",
      guestUserId: identity.userId,
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).rejects.toThrow(/AGENT_GUEST_NOT_FOUND/);
    await expect(guestRepository.revokeGuest({
      guestDisplayName: "Пётр",
      guestUserId: identity.userId,
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).resolves.toEqual({ revoked: true });
    await expect(telegramRepository.findIdentity("guest-1")).resolves.toBeNull();
    expect((await loadGuestAccessPolicy(identity.familyId))?.active).toBe(false);
    const paused = await database().query<{ status: string }>(
      "SELECT status::text FROM reminders WHERE family_id = $1 UNION ALL SELECT status::text FROM agent_schedules WHERE family_id = $1",
      [identity.familyId],
    );
    expect(paused.rows.map((row) => row.status)).toEqual(["paused", "paused"]);
    // Removing twice changes nothing and is not an error.
    await expect(guestRepository.revokeGuest({
      guestDisplayName: "Пётр",
      guestUserId: identity.userId,
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).resolves.toEqual({ revoked: true });

    await expect(familyRepository.claimInvitation(await guestLink(owner, "guest-call-b"), PETR)).resolves.toEqual({
      guest: "returned",
      hostOwnerTelegramUserId: "owner-1",
    });
    const back = await telegramRepository.findIdentity("guest-1");
    expect(back?.familyId).toBe(identity.familyId);
    const policy = await loadGuestAccessPolicy(identity.familyId);
    expect(policy?.active).toBe(true);
    expect([...policy!.disabledTools]).toEqual(["bash"]);
  });

  it("refuses a family invitation to a former guest instead of failing on their private chat", async () => {
    const owner = await createOwner();
    // A family claim made before the person became a guest, approved after they were removed.
    const family = await familyRepository.createInvitation(owner.familyId, owner.ownerId, "family-call-early", "member");
    await expect(familyRepository.claimInvitation(family.code, PETR)).resolves.toBe("pending");
    await familyRepository.claimInvitation(await guestLink(owner, "guest-call-c"), PETR);
    const identity = (await telegramRepository.findIdentity("guest-1"))!;
    await guestRepository.revokeGuest({ guestDisplayName: "Пётр", guestUserId: identity.userId, hostFamilyId: owner.familyId, ownerUserId: owner.ownerId });

    const later = await familyRepository.createInvitation(owner.familyId, owner.ownerId, "family-call-late", "member");
    await expect(familyRepository.claimInvitation(later.code, PETR)).resolves.toBe("former_guest");
    const [pending] = await familyRepository.listPendingInvitations(owner.familyId, owner.ownerId);
    await expect(familyRepository.approveInvitation({
      approvedBy: owner.ownerId,
      candidateDisplayName: "Пётр",
      candidateTelegramUserId: "guest-1",
      familyId: owner.familyId,
      invitationId: pending!.invitationId,
      operationKey: "approve-call",
    })).rejects.toThrow(/AGENT_INVITATION_FORMER_GUEST/);
    await expect(telegramRepository.findIdentity("guest-1")).resolves.toBeNull();
  });

  it("refuses an unknown guest and anyone but the live owner", async () => {
    const owner = await createOwner();
    await expect(guestRepository.revokeGuest({
      guestDisplayName: "Пётр",
      guestUserId: "00000000-0000-4000-8000-000000000009",
      hostFamilyId: owner.familyId,
      ownerUserId: owner.ownerId,
    })).rejects.toThrow(/AGENT_GUEST_NOT_FOUND/);

    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [owner.ownerId]);
    await expect(guestRepository.listGuests({ hostFamilyId: owner.familyId, ownerUserId: owner.ownerId }))
      .rejects.toThrow(/AGENT_OWNER_REQUIRED/);
  });

  it("admits nobody through a link whose creator is no longer the owner", async () => {
    const owner = await createOwner();
    const code = await guestLink(owner, "guest-call-stale");
    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [owner.ownerId]);

    await expect(familyRepository.claimInvitation(code, PETR)).resolves.toBe("invalid");
    await expect(telegramRepository.findIdentity("guest-1")).resolves.toBeNull();
  });
});
