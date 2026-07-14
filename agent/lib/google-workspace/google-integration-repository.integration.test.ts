/**
 * Google Workspace OAuth persistence tests.
 *
 * Constructs covered:
 * - One-time expiring OAuth state claims.
 * - Encrypted credential persistence and identity-scoped default account selection.
 * - Refreshed access tokens remain bound to the current membership and account.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
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
  return {
    familyId: family.rows[0]!.id,
    role: "owner" as const,
    telegramChatId: "google-owner",
    userId: user.rows[0]!.id,
  };
}

async function connectedAccount(auth: Awaited<ReturnType<typeof fixture>>) {
  await googleIntegrationRepository.createAuthorization(auth, {
    expiresAt: new Date("2026-07-12T12:10:00.000Z"),
    rawState: "complete-state-with-at-least-32-bytes",
  });
  const claim = await googleIntegrationRepository.claimAuthorization(
    "complete-state-with-at-least-32-bytes",
    new Date("2026-07-12T12:05:00.000Z"),
  );
  return await googleIntegrationRepository.completeAuthorization(claim, {
    accessToken: "access-secret",
    accessTokenExpiresAt: new Date("2026-07-12T13:05:00.000Z"),
    displayName: "owner@example.com",
    encryptionKey,
    externalAccountId: "google-subject-123",
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
    )).resolves.toMatchObject({ familyId: auth.familyId, userId: auth.userId });
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

  it("persists a refreshed access token and updated scopes", async () => {
    const auth = await fixture();
    const account = await connectedAccount(auth);
    await googleIntegrationRepository.updateAccessToken(auth, account.id, {
      accessToken: "refreshed-access-secret",
      accessTokenExpiresAt: new Date("2026-07-12T14:05:00.000Z"),
      encryptionKey,
      scopes: ["scope-a", "scope-b", "scope-c"],
    });

    await expect(googleIntegrationRepository.getDefaultAccount(auth, encryptionKey)).resolves
      .toMatchObject({
        accessToken: "refreshed-access-secret",
        scopes: ["scope-a", "scope-b", "scope-c"],
      });
  });
});
