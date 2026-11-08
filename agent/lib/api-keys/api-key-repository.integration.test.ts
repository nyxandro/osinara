/**
 * Sandbox API key PostgreSQL integration tests.
 *
 * Constructs covered:
 * - A request creates the key and the owner's personal grant; a request for another key while one
 *   is awaited in the same chat is refused, so the next message belongs to one key only.
 * - A value is stored only for the very wait it was matched to while it is open; the update that
 *   delivered it is recognized when Telegram sends it again.
 * - After a wait ends, by a stored value, a cancellation or its time, the chat stays guarded.
 * - A stored key cannot change its destination by a new request; a key without a value that does
 *   loses its family and group grants.
 * - Grants reach the proxy projection and the sandbox environment only once the value is stored, an
 *   external group's grant carries its own network and a family group is refused as a target.
 * - A guest's grant (#474) lands in the guest's own personal folder and is bound to that folder's network, never
 *   the family's trusted one; it leaves the proxy while the guest is removed and comes back with them; only the
 *   owner's own guest, named as listed, can be a target, and a removed guest gets no new grant. A grant in
 *   another family's folder that no live guest of the key's family holds never reaches the proxy.
 * - Revocation and deletion close the key at once; usage is recorded once per id and counted.
 * - The schema refuses a malformed placeholder and a value without its parts.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { apiKeyRepository } from "./api-key-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const VALUE = { authTag: "dGFn", ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" };
const SETTINGS = {
  authHeader: "authorization",
  authScheme: "bearer" as const,
  purpose: "генерация картинок",
  upstreamBaseUrl: "https://api.neuraldeep.ru/v1",
};

interface Fixture {
  chatId: string;
  externalChatId: string;
  familyChatId: string;
  familyId: string;
  ownerUserId: string;
}

async function createFixture(suffix: string): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`API key family ${suffix}`],
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id",
    [`api-key-owner-${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, owner.rows[0]!.id],
  );
  const chatId = () => `-100${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
  const externalChatId = chatId();
  const familyChatId = chatId();
  await database().query(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, 'Внешний чат', 'external', 'addressed_only'),
            ($1, $3, 'Семейный чат', 'family_private', 'all')`,
    [familyId, externalChatId, familyChatId],
  );
  return { chatId: `chat-${suffix}`, externalChatId, familyChatId, familyId, ownerUserId: owner.rows[0]!.id };
}

const GUARD_MS = 24 * 60 * 60 * 1000;

function intake(fixture: Fixture, name: string, overrides: Partial<typeof SETTINGS> = {}, expiresInMs = 60_000) {
  const expiresAt = new Date(Date.now() + expiresInMs);
  return {
    ...SETTINGS,
    ...overrides,
    expiresAt,
    familyId: fixture.familyId,
    guardUntil: new Date(expiresAt.getTime() + GUARD_MS),
    name,
    ownerUserId: fixture.ownerUserId,
    telegramChatId: fixture.chatId,
  };
}

/** A guest of the fixture's family, living in a one-person family of their own. */
async function createGuest(fixture: Fixture, suffix: string, hostFamilyId = fixture.familyId): Promise<{ familyId: string; userId: string }> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Guest ${suffix}`]);
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Пётр') RETURNING id",
    [`api-key-guest-${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  const userId = user.rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')", [familyId, userId]);
  await database().query(
    "INSERT INTO guest_accounts (user_id, guest_family_id, host_family_id, status) VALUES ($1, $2, $3, 'active')",
    [userId, familyId, hostFamilyId],
  );
  return { familyId, userId };
}

async function workspaceIds(fixture: Fixture): Promise<Record<string, string>> {
  const rows = await database().query<{ id: string; scope: string }>(
    "SELECT id, scope FROM workspaces WHERE family_id = $1",
    [fixture.familyId],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.scope, row.id]));
}

/** The projection holds every family's grants; a test looks only at its own family's. */
async function projectedForFamily(fixture: Fixture) {
  const own = await database().query<{ placeholder: string }>(
    `SELECT g.placeholder FROM sandbox_api_key_grants g JOIN sandbox_api_keys k ON k.id = g.key_id
      WHERE k.family_id = $1`,
    [fixture.familyId],
  );
  const placeholders = new Set(own.rows.map((row) => row.placeholder));
  return (await apiKeyRepository.listProjectionGrants()).filter((grant) => placeholders.has(grant.placeholder));
}

async function store(fixture: Fixture, name: string, updateId: string): Promise<boolean> {
  const found = await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId });
  if (found?.kind !== "open" || found.name !== name) throw new Error(`TEST_EXPECTED_OPEN_INTAKE: ${name}`);
  return await apiKeyRepository.storeValue({
    expiresAt: found.expiresAt, keyId: found.keyId, telegramChatId: fixture.chatId, updateId, value: VALUE,
  });
}

describeWithDatabase("API key repository", () => {
  afterAll(closeDatabase);

  it("creates the key with a personal grant and refuses another key while one is awaited", async () => {
    const fixture = await createFixture("intake");

    expect(await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"))).toMatchObject({ created: true });
    await expect(apiKeyRepository.openIntake(intake(fixture, "openai", { upstreamBaseUrl: "https://api.openai.com/v1" })))
      .rejects.toMatchObject({ code: "AGENT_API_KEY_INTAKE_BUSY" });
    await expect(apiKeyRepository.openIntake(intake(fixture, "neuraldeep"))).resolves.toMatchObject({ created: false });

    const open = await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "1" });
    expect(open).toMatchObject({ kind: "open", name: "neuraldeep" });
    await apiKeyRepository.cancelIntake({ keyId: (open as { keyId: string }).keyId, telegramChatId: fixture.chatId });
    await apiKeyRepository.openIntake(intake(fixture, "openai", { upstreamBaseUrl: "https://api.openai.com/v1" }));

    const keys = await apiKeyRepository.list(fixture.familyId);
    expect(keys.map((key) => [key.name, key.grants.map((grant) => grant.target.kind)])).toEqual([
      ["neuraldeep", ["personal"]],
      ["openai", ["personal"]],
    ]);
    expect(await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "2" }))
      .toMatchObject({ kind: "open", name: "openai" });
  });

  it("stores a value once for its own wait, recognizes its update again and keeps the chat guarded", async () => {
    const fixture = await createFixture("store");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    const found = await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "500" });
    if (found?.kind !== "open") throw new Error("TEST_EXPECTED_OPEN_INTAKE");

    expect(await apiKeyRepository.storeValue({
      expiresAt: new Date(found.expiresAt.getTime() + 1), keyId: found.keyId, telegramChatId: fixture.chatId,
      updateId: "500", value: VALUE,
    })).toBe(false);
    expect(await store(fixture, "neuraldeep", "501")).toBe(true);

    expect(await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "501" }))
      .toEqual({ kind: "delivered", name: "neuraldeep" });
    expect(await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "502" }))
      .toMatchObject({ kind: "guarded", name: "neuraldeep" });
  });

  it("guards the chat after a wait ran out or was cancelled, and frees it after the guard", async () => {
    const fixture = await createFixture("guard");
    await apiKeyRepository.openIntake(intake(fixture, "late", {}, -1_000));

    expect(await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "601" }))
      .toMatchObject({ kind: "guarded", name: "late" });

    await apiKeyRepository.openIntake(intake(fixture, "gone", {}, -GUARD_MS - 1_000));
    expect(await apiKeyRepository.findIntake({ telegramChatId: fixture.chatId, updateId: "602" })).toBeNull();
  });

  it("revokes the family and group grants of a key without a value whose destination changes", async () => {
    const fixture = await createFixture("moved");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    await apiKeyRepository.grant({
      familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep", target: { kind: "family" },
    });

    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep", { upstreamBaseUrl: "https://api.other.example.com" }));

    const [key] = await apiKeyRepository.list(fixture.familyId);
    expect(key!.upstreamBaseUrl).toBe("https://api.other.example.com");
    expect(key!.grants.map((grant) => grant.target.kind)).toEqual(["personal"]);
  });

  it("does not let a new request redirect a stored key", async () => {
    const fixture = await createFixture("locked");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    await store(fixture, "neuraldeep", "701");

    await expect(apiKeyRepository.openIntake(intake(fixture, "neuraldeep", { upstreamBaseUrl: "https://evil.example.com" })))
      .rejects.toMatchObject({ code: "AGENT_API_KEY_DESTINATION_LOCKED" });
    await expect(apiKeyRepository.openIntake(intake(fixture, "neuraldeep"))).resolves.toMatchObject({ created: false });
  });

  it("projects only stored keys and binds an external group's grant to its own network", async () => {
    const fixture = await createFixture("grant");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    expect(await apiKeyRepository.grant({
      familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep",
      target: { kind: "group", telegramChatId: fixture.externalChatId },
    })).toEqual({ created: true });
    const workspaces = await workspaceIds(fixture);

    expect(await projectedForFamily(fixture)).toEqual([]);
    expect(await apiKeyRepository.environmentGrants([workspaces.group!])).toEqual([]);

    await store(fixture, "neuraldeep", "711");

    const projected = await projectedForFamily(fixture);
    const group = projected.find((grant) => grant.network.kind === "group")!;
    expect(projected.map((grant) => grant.network)).toEqual(expect.arrayContaining([
      { kind: "trusted" },
      { kind: "group", workspaceId: workspaces.group },
    ]));
    expect(group).toMatchObject({
      authHeader: "authorization", authScheme: "bearer", keyName: "neuraldeep",
      upstreamBaseUrl: SETTINGS.upstreamBaseUrl, value: VALUE,
    });
    expect(await apiKeyRepository.environmentGrants([workspaces.group!]))
      .toEqual([{ name: "neuraldeep", placeholder: group.placeholder }]);
    const personal = await apiKeyRepository.environmentGrants([workspaces.personal!]);
    expect(personal).toHaveLength(1);
    expect(personal[0]!.placeholder).not.toBe(group.placeholder);

    await expect(apiKeyRepository.grant({
      familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep",
      target: { kind: "group", telegramChatId: fixture.familyChatId },
    })).rejects.toMatchObject({ code: "AGENT_API_KEY_GROUP_NOT_FOUND" });
  });

  it("grants a key to a guest on the guest's own network, and keeps it from the proxy while the guest is removed", async () => {
    const fixture = await createFixture("guest");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    await store(fixture, "neuraldeep", "951");
    const guest = await createGuest(fixture, "guest");
    const target = { guestDisplayName: "Пётр", guestUserId: guest.userId, kind: "guest" } as const;
    const grant = () => apiKeyRepository.grant({ familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep", target });

    expect(await grant()).toEqual({ created: true });
    expect(await grant()).toEqual({ created: false });
    const folder = (await database().query<{ id: string }>(
      "SELECT id FROM workspaces WHERE family_id = $1 AND scope = 'personal' AND owner_user_id = $2",
      [guest.familyId, guest.userId],
    )).rows[0]!.id;
    // Nothing of the key lands in the owner's family folders for the guest.
    expect(Object.keys(await workspaceIds(fixture))).toEqual(["personal"]);

    const projected = await projectedForFamily(fixture);
    expect(projected.map((entry) => entry.network)).toEqual(expect.arrayContaining([
      { kind: "trusted" }, { kind: "group", workspaceId: folder },
    ]));
    expect(projected.filter((entry) => entry.network.kind === "trusted")).toHaveLength(1);
    const guestGrant = projected.find((entry) => entry.network.kind === "group")!;
    expect(await apiKeyRepository.environmentGrants([folder])).toEqual([{ name: "neuraldeep", placeholder: guestGrant.placeholder }]);
    const listed = (await apiKeyRepository.list(fixture.familyId))[0]!;
    expect(listed.grants.map((entry) => entry.target)).toEqual(expect.arrayContaining([
      { kind: "personal" },
      { displayName: "Пётр", guestStatus: "active", guestUserId: guest.userId, kind: "guest" },
    ]));

    await database().query("UPDATE guest_accounts SET status = 'revoked', revoked_at = now() WHERE user_id = $1", [guest.userId]);
    expect((await projectedForFamily(fixture)).map((entry) => entry.network)).toEqual([{ kind: "trusted" }]);
    await expect(grant()).rejects.toMatchObject({ code: "AGENT_GUEST_REMOVED" });
    expect((await apiKeyRepository.list(fixture.familyId))[0]!.grants.map((entry) => entry.target))
      .toContainEqual({ displayName: "Пётр", guestStatus: "revoked", guestUserId: guest.userId, kind: "guest" });
    await database().query("UPDATE guest_accounts SET status = 'active', revoked_at = NULL WHERE user_id = $1", [guest.userId]);
    expect(await projectedForFamily(fixture)).toHaveLength(2);

    await expect(apiKeyRepository.grant({
      familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep", target: { ...target, guestDisplayName: "Пётр Иванов" },
    })).rejects.toMatchObject({ code: "AGENT_GUEST_NOT_FOUND" });
    const other = await createFixture("guest-other");
    const stranger = await createGuest(other, "guest-stranger");
    await expect(apiKeyRepository.grant({
      familyId: fixture.familyId, grantedBy: fixture.ownerUserId, name: "neuraldeep", target: { ...target, guestUserId: stranger.userId },
    })).rejects.toMatchObject({ code: "AGENT_GUEST_NOT_FOUND" });
    // A folder of another family that is no guest's of this key's family: the grant fails closed, never trusted.
    const strangerFolder = (await database().query<{ id: string }>(
      "INSERT INTO workspaces (family_id, owner_user_id, scope) VALUES ($1, $2, 'personal') RETURNING id",
      [stranger.familyId, stranger.userId],
    )).rows[0]!.id;
    const key = (await database().query<{ id: string }>(
      "SELECT id FROM sandbox_api_keys WHERE family_id = $1 AND name = 'neuraldeep'", [fixture.familyId],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO sandbox_api_key_grants (key_id, workspace_id, placeholder, granted_by) VALUES ($1, $2, $3, $4)",
      [key, strangerFolder, `osk_${"s".repeat(43)}`, fixture.ownerUserId],
    );
    expect((await projectedForFamily(fixture)).map((entry) => entry.placeholder)).not.toContain(`osk_${"s".repeat(43)}`);
    await database().query("DELETE FROM sandbox_api_key_grants WHERE workspace_id = $1", [strangerFolder]);

    expect(await apiKeyRepository.revoke({ familyId: fixture.familyId, name: "neuraldeep", revokedBy: fixture.ownerUserId, target }))
      .toBe(true);
    expect(await apiKeyRepository.environmentGrants([folder])).toEqual([]);
  });

  it("closes a revoked grant at once and creates nothing to revoke a never used target", async () => {
    const fixture = await createFixture("revoke");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    await store(fixture, "neuraldeep", "801");

    expect(await apiKeyRepository.revoke({
      familyId: fixture.familyId, name: "neuraldeep", revokedBy: fixture.ownerUserId,
      target: { kind: "group", telegramChatId: fixture.externalChatId },
    })).toBe(false);
    expect((await workspaceIds(fixture)).group).toBeUndefined();

    expect(await apiKeyRepository.revoke({
      familyId: fixture.familyId, name: "neuraldeep", revokedBy: fixture.ownerUserId, target: { kind: "personal" },
    })).toBe(true);
    expect(await apiKeyRepository.environmentGrants([(await workspaceIds(fixture)).personal!])).toEqual([]);
  });

  it("records usage once per id, drops a deleted grant's use and deletes everything with the key", async () => {
    const fixture = await createFixture("usage");
    await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    await store(fixture, "neuraldeep", "901");
    const grant = await database().query<{ id: string }>(
      `SELECT g.id FROM sandbox_api_key_grants g JOIN sandbox_api_keys k ON k.id = g.key_id
        WHERE k.family_id = $1`,
      [fixture.familyId],
    );
    const grantId = grant.rows[0]!.id;
    const events = [
      { grantId, id: crypto.randomUUID(), status: 200, usedAt: new Date().toISOString() },
      { grantId, id: crypto.randomUUID(), status: null, usedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() },
      { grantId: crypto.randomUUID(), id: crypto.randomUUID(), status: 200, usedAt: new Date().toISOString() },
    ];

    expect(await apiKeyRepository.recordUsage(events)).toBe(2);
    expect(await apiKeyRepository.recordUsage(events)).toBe(0);

    const [key] = await apiKeyRepository.list(fixture.familyId);
    expect(key!.grants[0]).toMatchObject({ uses: 2, usesLast7Days: 1 });
    expect(key!.grants[0]!.lastUsedAt).toBeInstanceOf(Date);

    expect(await apiKeyRepository.delete({ familyId: fixture.familyId, name: "neuraldeep" })).toBe(true);
    const left = await database().query(
      "SELECT 1 FROM sandbox_api_key_usage WHERE grant_id = $1 UNION ALL SELECT 1 FROM sandbox_api_key_grants WHERE id = $1",
      [grantId],
    );
    expect(left.rowCount).toBe(0);
  });

  it("refuses a malformed placeholder and a value without its parts", async () => {
    const fixture = await createFixture("schema");
    const { keyId } = await apiKeyRepository.openIntake(intake(fixture, "neuraldeep"));
    const workspace = (await workspaceIds(fixture)).personal!;

    await expect(database().query(
      "INSERT INTO sandbox_api_key_grants (key_id, workspace_id, placeholder) VALUES ($1, $2, 'sk-real-key')",
      [keyId, workspace],
    )).rejects.toThrow();
    await expect(database().query(
      "UPDATE sandbox_api_keys SET value_ciphertext = 'x' WHERE id = $1",
      [keyId],
    )).rejects.toThrow();
  });
});
