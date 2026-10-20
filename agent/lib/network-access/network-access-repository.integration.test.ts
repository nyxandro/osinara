/**
 * Owner-approved network access PostgreSQL integration tests.
 *
 * Constructs covered:
 * - A grant replayed after a crash, or requested twice, keeps one active row per address and port.
 * - Listing shows only the caller's family; the proxy projection carries every active grant.
 * - A revocation closes the destination and lets it be granted again later.
 * - The schema accepts only a single IPv4 address.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { networkAccessRepository } from "./network-access-repository.js";

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

interface Fixture {
  familyId: string;
  ownerUserId: string;
}

async function createFixture(suffix: string): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Network access family ${suffix}`],
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id",
    [`network-access-owner-${suffix}`],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, ownerUserId: owner.rows[0]!.id };
}

function grantInput(fixture: Fixture, address: string, port: number, operationKey: string) {
  return {
    address,
    familyId: fixture.familyId,
    grantedBy: fixture.ownerUserId,
    operationKey,
    port,
    purpose: "Home Assistant",
  };
}

describeWithDatabase("network access repository", () => {
  afterAll(closeDatabase);

  it("keeps one active grant when the same request is replayed or repeated", async () => {
    const fixture = await createFixture("replay");

    const first = await networkAccessRepository.grant(grantInput(fixture, "100.91.171.16", 8123, "call-replay-1"));
    const replay = await networkAccessRepository.grant(grantInput(fixture, "100.91.171.16", 8123, "call-replay-1"));
    const repeat = await networkAccessRepository.grant(grantInput(fixture, "100.91.171.16", 8123, "call-replay-2"));

    expect(first).toMatchObject({ active: true, created: true });
    expect(replay).toMatchObject({ active: true, created: false });
    expect(repeat).toMatchObject({ active: true, created: false });
    const rows = await database().query(
      "SELECT 1 FROM network_access_grants WHERE address = '100.91.171.16' AND port = 8123",
    );
    expect(rows.rowCount).toBe(1);
  });

  it("refuses an operation key that already granted a different destination", async () => {
    const fixture = await createFixture("operation-conflict");
    await networkAccessRepository.grant(grantInput(fixture, "100.70.0.1", 8123, "call-conflict"));

    await expect(networkAccessRepository.grant(grantInput(fixture, "100.70.0.2", 8123, "call-conflict")))
      .rejects.toMatchObject({ code: "AGENT_NETWORK_ACCESS_OPERATION_CONFLICT" });
  });

  it("lists only the caller's family and projects every active grant", async () => {
    const home = await createFixture("list-home");
    const other = await createFixture("list-other");
    await networkAccessRepository.grant(grantInput(home, "192.168.10.20", 445, "call-list-1"));
    await networkAccessRepository.grant(grantInput(home, "192.168.10.5", 80, "call-list-2"));
    await networkAccessRepository.grant(grantInput(other, "10.9.9.9", 22, "call-list-3"));

    const listed = await networkAccessRepository.listActive(home.familyId);
    const projected = await networkAccessRepository.listAllActiveDestinations();

    expect(listed.map(({ address, port, purpose }) => ({ address, port, purpose }))).toEqual([
      { address: "192.168.10.5", port: 80, purpose: "Home Assistant" },
      { address: "192.168.10.20", port: 445, purpose: "Home Assistant" },
    ]);
    expect(listed[0]!.grantedAt).toBeInstanceOf(Date);
    expect(projected).toEqual(expect.arrayContaining([
      { address: "10.9.9.9", port: 22 },
      { address: "192.168.10.5", port: 80 },
      { address: "192.168.10.20", port: 445 },
    ]));
  });

  it("closes a revoked destination and allows granting it again", async () => {
    const fixture = await createFixture("revoke");
    await networkAccessRepository.grant(grantInput(fixture, "100.64.5.5", 8080, "call-revoke-1"));

    const revoked = await networkAccessRepository.revoke({
      address: "100.64.5.5", familyId: fixture.familyId, port: 8080, revokedBy: fixture.ownerUserId,
    });
    const again = await networkAccessRepository.revoke({
      address: "100.64.5.5", familyId: fixture.familyId, port: 8080, revokedBy: fixture.ownerUserId,
    });

    expect(revoked).toBe(true);
    expect(again).toBe(false);
    expect(await networkAccessRepository.listActive(fixture.familyId)).toEqual([]);
    expect(await networkAccessRepository.listAllActiveDestinations())
      .not.toContainEqual({ address: "100.64.5.5", port: 8080 });
    expect(await networkAccessRepository.grant(grantInput(fixture, "100.64.5.5", 8080, "call-revoke-2")))
      .toMatchObject({ active: true, created: true });
  });

  it("does not revoke another family's grant", async () => {
    const home = await createFixture("foreign-home");
    const other = await createFixture("foreign-other");
    await networkAccessRepository.grant(grantInput(other, "10.8.8.8", 443, "call-foreign-1"));

    expect(await networkAccessRepository.revoke({
      address: "10.8.8.8", familyId: home.familyId, port: 443, revokedBy: home.ownerUserId,
    })).toBe(false);
    expect(await networkAccessRepository.listActive(other.familyId)).toHaveLength(1);
  });

  it("stores only a single IPv4 address", async () => {
    const fixture = await createFixture("schema");
    for (const address of ["::1", "10.0.0.0/8"]) {
      await expect(database().query(
        `INSERT INTO network_access_grants (family_id, address, port, purpose, granted_by, operation_key)
         VALUES ($1, $2::inet, 80, 'x', $3, $4)`,
        [fixture.familyId, address, fixture.ownerUserId, `schema-${address}`],
      )).rejects.toMatchObject({ code: "23514" });
    }
  });
});
