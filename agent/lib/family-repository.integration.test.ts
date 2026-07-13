/**
 * PostgreSQL family invitation integration tests.
 *
 * Constructs covered:
 * - Invitation claim reserves a candidate without granting membership.
 * - Owner approval atomically creates membership and consumes the invitation.
 * - Cross-family approval is rejected at the SQL authorization boundary.
 * - Routine observations are scoped, replay-safe, and suggest on the third occurrence.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { familyRepository } from "./family-repository.js";
import { telegramRepository } from "./telegram-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  const databaseName = new URL(integrationDatabaseUrl).pathname.slice(1);
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

async function createOwner(suffix: string): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2)
     RETURNING id`,
    [`owner-${suffix}`, `Владелец ${suffix}`],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]?.id, owner.rows[0]?.id],
  );
  return { familyId: family.rows[0]!.id, ownerId: owner.rows[0]!.id };
}

describeWithDatabase("familyRepository invitations", () => {
  beforeEach(async () => {
    // Integration tests own the disposable database and reset every domain table between cases.
    await database().query(
      `TRUNCATE invitations, memory_items,
         telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("keeps a claimant pending until the same-family owner approves", async () => {
    const owner = await createOwner("one");
    const invitation = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "create-call-one",
    );

    await expect(
      familyRepository.claimInvitation(invitation.code, {
        displayName: "Анна Кандидат",
        telegramUserId: "candidate-1",
        username: "candidate",
      }),
    ).resolves.toBe("pending");
    await expect(telegramRepository.findIdentity("candidate-1")).resolves.toBeNull();

    const pending = await familyRepository.listPendingInvitations(owner.familyId, owner.ownerId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      displayName: "Анна Кандидат",
      telegramUserId: "candidate-1",
      username: "candidate",
    });

    await expect(
      familyRepository.approveInvitation({
        approvedBy: owner.ownerId,
        candidateDisplayName: pending[0]!.displayName,
        candidateTelegramUserId: pending[0]!.telegramUserId,
        familyId: owner.familyId,
        invitationId: pending[0]!.invitationId,
        operationKey: "approve-call-one",
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      familyRepository.approveInvitation({
        approvedBy: owner.ownerId,
        candidateDisplayName: pending[0]!.displayName,
        candidateTelegramUserId: pending[0]!.telegramUserId,
        familyId: owner.familyId,
        invitationId: pending[0]!.invitationId,
        operationKey: "approve-call-one",
      }),
    ).resolves.toEqual({ approved: true });
    await expect(telegramRepository.findIdentity("candidate-1")).resolves.toMatchObject({
      familyId: owner.familyId,
      role: "member",
    });
    const audit = await database().query<{ event_type: string }>(
      "SELECT event_type FROM audit_events WHERE family_id = $1 ORDER BY created_at, event_type",
      [owner.familyId],
    );
    expect(audit.rows.map((row) => row.event_type).sort()).toEqual([
      "invitation.approved",
      "invitation.claimed",
      "invitation.created",
    ]);
    await expect(
      familyRepository.claimInvitation(invitation.code, {
        displayName: "Другой кандидат",
        telegramUserId: "candidate-2",
      }),
    ).resolves.toBe("invalid");
  });

  it("rejects approval by an owner from another family", async () => {
    const invitingOwner = await createOwner("inviting");
    const otherOwner = await createOwner("other");
    const invitation = await familyRepository.createInvitation(
      invitingOwner.familyId,
      invitingOwner.ownerId,
      "create-call-cross-family",
    );
    await familyRepository.claimInvitation(invitation.code, {
      displayName: "Кандидат",
      telegramUserId: "candidate-cross-family",
    });
    const [pending] = await familyRepository.listPendingInvitations(
      invitingOwner.familyId,
      invitingOwner.ownerId,
    );

    await expect(
      familyRepository.approveInvitation({
        approvedBy: otherOwner.ownerId,
        candidateDisplayName: pending!.displayName,
        candidateTelegramUserId: pending!.telegramUserId,
        familyId: otherOwner.familyId,
        invitationId: pending!.invitationId,
        operationKey: "approve-call-cross-family",
      }),
    ).rejects.toThrowError(/AGENT_INVITATION_NOT_APPROVABLE/);
    await expect(telegramRepository.findIdentity("candidate-cross-family")).resolves.toBeNull();
  });

  it("reuses one invitation for an Eve replay and rejects a stale owner", async () => {
    const owner = await createOwner("replay");
    const first = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "durable-create-call",
    );
    const replay = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "durable-create-call",
    );

    expect(replay).toEqual(first);
    expect(replay.deliveryRequired).toBe(true);
    await familyRepository.markInvitationDelivered({
      createdBy: owner.ownerId,
      familyId: owner.familyId,
      invitationId: first.invitationId,
      operationKey: "durable-create-call",
    });
    await expect(
      familyRepository.createInvitation(
        owner.familyId,
        owner.ownerId,
        "durable-create-call",
      ),
    ).resolves.toMatchObject({ deliveryRequired: false });
    const count = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM invitations WHERE family_id = $1",
      [owner.familyId],
    );
    expect(count.rows[0]?.count).toBe("1");

    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [owner.ownerId]);
    await expect(
      familyRepository.createInvitation(owner.familyId, owner.ownerId, "stale-owner-call"),
    ).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
    await expect(
      familyRepository.listPendingInvitations(owner.familyId, owner.ownerId),
    ).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
  });

  it("allows only one pending claim per candidate and supports candidate deletion", async () => {
    const owner = await createOwner("duplicate");
    const first = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "duplicate-create-one",
    );
    const second = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "duplicate-create-two",
    );
    const profile = { displayName: "Один кандидат", telegramUserId: "duplicate-candidate" };

    await expect(familyRepository.claimInvitation(first.code, profile)).resolves.toBe("pending");
    await expect(familyRepository.claimInvitation(second.code, profile)).resolves.toBe("invalid");
    const [pending] = await familyRepository.listPendingInvitations(owner.familyId, owner.ownerId);
    await familyRepository.approveInvitation({
      approvedBy: owner.ownerId,
      candidateDisplayName: pending!.displayName,
      candidateTelegramUserId: pending!.telegramUserId,
      familyId: owner.familyId,
      invitationId: pending!.invitationId,
      operationKey: "duplicate-approve",
    });

    const candidate = await database().query<{ id: string }>(
      "SELECT id FROM users WHERE telegram_user_id = $1",
      [profile.telegramUserId],
    );
    await expect(
      database().query("DELETE FROM users WHERE id = $1", [candidate.rows[0]?.id]),
    ).resolves.toBeDefined();
  });

  it("expires a stale pending request so the candidate can use a new invitation", async () => {
    const owner = await createOwner("expiry");
    const stale = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "expiry-create-stale",
    );
    const fresh = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "expiry-create-fresh",
    );
    const profile = { displayName: "Кандидат", telegramUserId: "expiry-candidate" };
    await familyRepository.claimInvitation(stale.code, profile);
    await database().query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.invitationId],
    );

    await expect(familyRepository.claimInvitation(fresh.code, profile)).resolves.toBe("pending");
    const state = await database().query<{ status: string }>(
      "SELECT status FROM invitations WHERE id = $1",
      [stale.invitationId],
    );
    expect(state.rows[0]?.status).toBe("expired");
  });

  it("does not deliver an expired invitation when Eve replays its create operation", async () => {
    const owner = await createOwner("expired-replay");
    const invitation = await familyRepository.createInvitation(
      owner.familyId,
      owner.ownerId,
      "expired-replay-create",
    );
    await database().query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [invitation.invitationId],
    );

    await expect(
      familyRepository.createInvitation(
        owner.familyId,
        owner.ownerId,
        "expired-replay-create",
      ),
    ).rejects.toThrowError(/AGENT_INVITATION_EXPIRED/);
  });

});
