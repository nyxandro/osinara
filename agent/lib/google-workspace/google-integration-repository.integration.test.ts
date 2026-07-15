/**
 * Google Workspace OAuth persistence tests.
 *
 * Constructs covered:
 * - One-time expiring OAuth state claims.
 * - Existing and new credentials are bound to a workspace rather than a Telegram session.
 * - Family profile management is owner-only while active members may use the profile.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const encryptionKey = Buffer.alloc(32, 9).toString("base64");

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Google Workspace') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('google-owner', 'Владелец') RETURNING id`,
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const workspace = await database().query<{ id: string }>(
    `INSERT INTO workspaces (family_id, owner_user_id, scope)
     VALUES ($1, $2, 'personal') RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    role: "owner" as const,
    scope: "personal" as const,
    telegramUserId: "google-owner",
    userId: user.rows[0]!.id,
    workspaceId: workspace.rows[0]!.id,
  };
}

async function connectedAccount(
  auth: GoogleIntegrationAuthorization,
  input: { externalAccountId?: string; state?: string } = {},
) {
  const state = input.state ?? "complete-state-with-at-least-32-bytes";
  await googleIntegrationRepository.createAuthorization(auth, {
    expiresAt: new Date("2026-07-12T12:10:00.000Z"),
    rawState: state,
  });
  const claim = await googleIntegrationRepository.claimAuthorization(
    state,
    new Date("2026-07-12T12:05:00.000Z"),
  );
  return await googleIntegrationRepository.completeAuthorization(claim, {
    accessToken: "access-secret",
    accessTokenExpiresAt: new Date("2026-07-12T13:05:00.000Z"),
    displayName: "owner@example.com",
    encryptionKey,
    externalAccountId: input.externalAccountId ?? "google-subject-123",
    refreshToken: "refresh-secret",
    scopes: ["scope-a", "scope-b"],
  });
}

describeWithDatabase("google integration repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE oauth_authorizations, integration_credentials, integration_accounts, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("claims an unexpired Workspace OAuth state exactly once", async () => {
    const auth = await fixture();
    await googleIntegrationRepository.createAuthorization(auth, {
      expiresAt: new Date("2026-07-12T12:10:00.000Z"),
      rawState: "state-secret-with-at-least-32-bytes",
    });

    await expect(googleIntegrationRepository.claimAuthorization(
      "state-secret-with-at-least-32-bytes",
      new Date("2026-07-12T12:05:00.000Z"),
    )).resolves.toMatchObject({
      actorUserId: auth.userId,
      familyId: auth.familyId,
      workspaceId: auth.workspaceId,
    });
    await expect(googleIntegrationRepository.claimAuthorization(
      "state-secret-with-at-least-32-bytes",
      new Date("2026-07-12T12:05:01.000Z"),
    )).rejects.toThrowError(/AGENT_GOOGLE_OAUTH_STATE_INVALID/);
  });

  it("rejects an expired state before token exchange", async () => {
    const auth = await fixture();
    await googleIntegrationRepository.createAuthorization(auth, {
      expiresAt: new Date("2026-07-12T12:10:00.000Z"),
      rawState: "expired-state-with-at-least-32-bytes",
    });

    await expect(googleIntegrationRepository.claimAuthorization(
      "expired-state-with-at-least-32-bytes",
      new Date("2026-07-12T12:10:01.000Z"),
    )).rejects.toThrowError(/AGENT_GOOGLE_OAUTH_STATE_INVALID/);
  });

  it("stores encrypted tokens and resolves only the current user's default account", async () => {
    const auth = await fixture();
    const account = await connectedAccount(auth);

    expect(account).toMatchObject({
      displayName: "owner@example.com",
      externalAccountId: "google-subject-123",
      isDefault: true,
      status: "active",
    });
    await expect(googleIntegrationRepository.getDefaultAccount(auth, encryptionKey)).resolves
      .toMatchObject({ accessToken: "access-secret", id: account.id, refreshToken: "refresh-secret" });
    const raw = await database().query<{
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
    }>("SELECT access_token_ciphertext, refresh_token_ciphertext FROM integration_credentials");
    expect(JSON.stringify(raw.rows)).not.toContain("access-secret");
    expect(JSON.stringify(raw.rows)).not.toContain("refresh-secret");
  });

  it("replaces the workspace default instead of retaining a stale account", async () => {
    const auth = await fixture();
    await connectedAccount(auth);
    const replacement = await connectedAccount(auth, {
      externalAccountId: "google-subject-456",
      state: "replacement-state-with-at-least-32-bytes",
    });

    await expect(googleIntegrationRepository.getDefaultAccount(auth, encryptionKey)).resolves
      .toMatchObject({ externalAccountId: "google-subject-456", id: replacement.id });
    const accounts = await database().query<{ external_account_id: string }>(
      "SELECT external_account_id FROM integration_accounts WHERE workspace_id = $1",
      [auth.workspaceId],
    );
    expect(accounts.rows).toEqual([{ external_account_id: "google-subject-456" }]);
  });

  it("allows family members to use but not replace the owner-managed family profile", async () => {
    const personal = await fixture();
    const member = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('google-member', 'Участник') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
      [personal.familyId, member.rows[0]!.id],
    );
    const familyWorkspace = await database().query<{ id: string }>(
      `INSERT INTO workspaces (family_id, scope)
       VALUES ($1, 'family') RETURNING id`,
      [personal.familyId],
    );
    const ownerAuth = {
      ...personal,
      scope: "family" as const,
      workspaceId: familyWorkspace.rows[0]!.id,
    };
    const account = await connectedAccount(ownerAuth);
    const memberAuth = {
      ...ownerAuth,
      role: "member" as const,
      telegramUserId: "google-member",
      userId: member.rows[0]!.id,
    };

    await expect(googleIntegrationRepository.getDefaultAccount(memberAuth, encryptionKey)).resolves
      .toMatchObject({ id: account.id, refreshToken: "refresh-secret" });
    await expect(googleIntegrationRepository.createAuthorization(memberAuth, {
      expiresAt: new Date("2026-07-12T12:10:00.000Z"),
      rawState: "member-state-with-at-least-32-bytes",
    })).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
    await expect(googleIntegrationRepository.assertManagement(memberAuth)).rejects.toThrowError(
      /AGENT_OWNER_REQUIRED/,
    );
  });

  it("applies the native gws workspace-binding schema", async () => {
    const columns = await database().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'integration_accounts'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toContain("workspace_id");
    expect(names).toContain("connected_by_user_id");
    expect(names).not.toContain("user_id");
    await expect(database().query<{ relation: string | null }>(
      "SELECT to_regclass('public.integration_operations')::text AS relation",
    )).resolves.toMatchObject({ rows: [{ relation: null }] });
  });
});
