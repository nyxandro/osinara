/**
 * PostgreSQL software update proposal integration tests.
 *
 * Constructs covered:
 * - Target-version deduplication, supersession, and durable exact Telegram binding.
 * - Atomic current-owner and installed-version authorization for callback decisions.
 * - One-shot decisions with unique callback-query and decision identifiers.
 * - Deployment lease invariants required by the host-side controller.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createSoftwareUpdateRepository } from "./repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const TOKEN = "integration-callback-secret";
const softwareUpdateRepository = createSoftwareUpdateRepository({ currentVersion: "0.1.0" });
const manifest = {
  commitSha: "b".repeat(40),
  composeSha256: "c".repeat(64),
  images: {
    app: `ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}`,
    cliProxy: `ghcr.io/nyxandro/osinara-cli-proxy@sha256:${"a".repeat(64)}`,
    edge: `ghcr.io/nyxandro/osinara-edge@sha256:${"a".repeat(64)}`,
    sandboxEgressProxy:
      `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${"a".repeat(64)}`,
    sandboxRunner: `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${"a".repeat(64)}`,
    sandboxRuntime: `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${"a".repeat(64)}`,
  },
  schemaVersion: 1 as const,
  version: "0.2.0",
};

function release(version: string) {
  return {
    manifest: { ...manifest, version },
    releaseUrl: `https://github.com/nyxandro/osinara/releases/tag/v${version}`,
    version,
  };
}

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Software updates') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('101', 'Владелец') RETURNING id`,
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    telegramUserId: "101",
    userId: owner.rows[0]!.id,
  };
}

async function preparePendingProposal(
  owner: Awaited<ReturnType<typeof fixture>>,
  version: string,
  token: string,
  messageId: string,
) {
  const prepared = await softwareUpdateRepository.prepareProposal({
    callbackTokenHash: createHash("sha256").update(token).digest("hex"),
    owner,
    release: release(version),
  });
  if (prepared.status !== "created") {
    throw new Error("AGENT_TEST_PROPOSAL_NOT_CREATED: Не создано тестовое предложение обновления");
  }
  await softwareUpdateRepository.bindPendingTelegramMessage({
    chatId: "101",
    chatType: "private",
    messageId,
    proposalId: prepared.proposalId,
  });
  return prepared.proposalId;
}

async function pendingProposal() {
  const owner = await fixture();
  const proposalId = await preparePendingProposal(owner, "0.2.0", TOKEN, "77");
  return { owner, proposalId };
}

describeWithDatabase("softwareUpdateRepository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE software_update_proposals, family_memberships, users, families CASCADE",
    );
  });

  afterAll(async () => closeDatabase());

  it("deduplicates the target version without replacing its owner binding", async () => {
    const current = await pendingProposal();

    await expect(softwareUpdateRepository.prepareProposal({
      callbackTokenHash: createHash("sha256").update("other-token").digest("hex"),
      owner: current.owner,
      release: release("0.2.0"),
    })).resolves.toEqual({ status: "duplicate" });

    const rows = await database().query<{ count: string; expected_owner_user_id: string }>(
      `SELECT count(*)::text AS count, min(expected_owner_user_id::text) AS expected_owner_user_id
         FROM software_update_proposals`,
    );
    expect(rows.rows[0]).toEqual({ count: "1", expected_owner_user_id: current.owner.userId });
  });

  it("rejects a JSON null compose hash at the database boundary", async () => {
    const owner = await fixture();
    const invalidManifest = { ...manifest, composeSha256: null };

    await expect(database().query(
      `INSERT INTO software_update_proposals
         (family_id, expected_owner_user_id, expected_owner_telegram_user_id,
          target_version, release_url, manifest, callback_token_hash)
       VALUES ($1, $2, $3, '0.2.0', $4, $5::jsonb, $6)`,
      [
        owner.familyId,
        owner.userId,
        owner.telegramUserId,
        "https://github.com/nyxandro/osinara/releases/tag/v0.2.0",
        JSON.stringify(invalidManifest),
        createHash("sha256").update("invalid-manifest-token").digest("hex"),
      ],
    )).rejects.toThrow();
  });

  it("atomically supersedes every older open proposal and expires its buttons", async () => {
    const owner = await fixture();
    const pendingId = await preparePendingProposal(owner, "0.2.0", TOKEN, "77");
    const preparingToken = "integration-preparing-token";
    const preparing = await softwareUpdateRepository.prepareProposal({
      callbackTokenHash: createHash("sha256").update(preparingToken).digest("hex"),
      owner,
      release: release("0.2.1"),
    });
    expect(preparing.status).toBe("created");

    await expect(softwareUpdateRepository.prepareProposal({
      callbackTokenHash: createHash("sha256").update("newest-token").digest("hex"),
      owner,
      release: release("0.3.0"),
    })).resolves.toMatchObject({ status: "created" });

    const rows = await database().query<{
      completed_at: Date | null;
      id: string;
      status: string;
      superseded_at: Date | null;
      target_version: string;
    }>(
      `SELECT id, target_version, status, superseded_at, completed_at
         FROM software_update_proposals
        ORDER BY target_version`,
    );
    expect(rows.rows).toMatchObject([
      { id: pendingId, status: "superseded", target_version: "0.2.0" },
      { status: "superseded", target_version: "0.2.1" },
      { status: "preparing", target_version: "0.3.0" },
    ]);
    expect(rows.rows[0]?.superseded_at).toBeInstanceOf(Date);
    expect(rows.rows[0]?.completed_at).toBeInstanceOf(Date);
    expect(rows.rows[1]?.superseded_at).toBeInstanceOf(Date);

    await expect(softwareUpdateRepository.claimDecision({
      action: "approve",
      callbackQueryId: "query-superseded",
      callbackToken: TOKEN,
      telegramChatId: "101",
      telegramChatType: "private",
      telegramMessageId: "77",
      telegramUserId: "101",
    })).resolves.toEqual({ status: "expired" });
  });

  it("rejects foreign and former owners, then atomically approves once", async () => {
    const current = await pendingProposal();
    const decision = {
      action: "approve" as const,
      callbackQueryId: "query-1",
      callbackToken: TOKEN,
      telegramChatId: "101",
      telegramChatType: "private" as const,
      telegramMessageId: "77",
      telegramUserId: "202",
    };

    await expect(softwareUpdateRepository.claimDecision(decision))
      .resolves.toEqual({ status: "forbidden" });
    await expect(softwareUpdateRepository.claimDecision({
      ...decision,
      callbackToken: "wrong-integration-token",
      telegramUserId: "101",
    })).resolves.toEqual({ status: "expired" });
    for (const wrongBinding of [
      { telegramChatId: "102" },
      { telegramChatType: "group" as const },
      { telegramMessageId: "78" },
    ]) {
      await expect(softwareUpdateRepository.claimDecision({
        ...decision,
        ...wrongBinding,
        telegramUserId: "101",
      })).resolves.toEqual({ status: "forbidden" });
    }
    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE user_id = $1",
      [current.owner.userId],
    );
    await expect(softwareUpdateRepository.claimDecision({
      ...decision,
      telegramUserId: "101",
    })).resolves.toEqual({ status: "forbidden" });
    await database().query(
      "UPDATE family_memberships SET role = 'owner' WHERE user_id = $1",
      [current.owner.userId],
    );

    const approved = await softwareUpdateRepository.claimDecision({
      ...decision,
      telegramUserId: "101",
    });
    expect(approved).toMatchObject({ proposalId: current.proposalId, status: "approved" });
    expect(approved).toHaveProperty("decisionId", expect.any(String));
    await expect(softwareUpdateRepository.claimDecision({
      ...decision,
      callbackQueryId: "query-2",
      telegramUserId: "101",
    })).resolves.toEqual({ status: "expired" });

    // A separate controller can claim the approved row and retain its unique decision identity.
    await expect(database().query(
      `UPDATE software_update_proposals
          SET status = 'deploying', deployment_started_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'approved'`,
      [current.proposalId],
    )).rejects.toThrow();
    const leaseToken = "123e4567-e89b-42d3-a456-426614174000";
    await expect(database().query(
      `UPDATE software_update_proposals
          SET status = 'deploying',
              deployment_started_at = now(),
              deployment_lease_token = $2,
              deployment_lease_expires_at = now() + interval '15 minutes',
              updated_at = now()
        WHERE id = $1 AND status = 'approved'`,
      [current.proposalId, leaseToken],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(database().query(
      `UPDATE software_update_proposals
          SET status = 'succeeded', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'deploying'`,
      [current.proposalId],
    )).rejects.toThrow();
    await expect(database().query(
      `UPDATE software_update_proposals
          SET status = 'succeeded',
              result = '{}'::jsonb,
              deployment_lease_token = NULL,
              deployment_lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'deploying'`,
      [current.proposalId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("expires a callback when its target is not newer than the installed version", async () => {
    const current = await pendingProposal();
    const repositoryAtTargetVersion = createSoftwareUpdateRepository({ currentVersion: "0.2.0" });

    await expect(repositoryAtTargetVersion.claimDecision({
      action: "approve",
      callbackQueryId: "query-stale-version",
      callbackToken: TOKEN,
      telegramChatId: "101",
      telegramChatType: "private",
      telegramMessageId: "77",
      telegramUserId: "101",
    })).resolves.toEqual({ status: "expired" });

    const row = await database().query<{ decision_id: string | null; status: string }>(
      "SELECT status, decision_id::text FROM software_update_proposals WHERE id = $1",
      [current.proposalId],
    );
    expect(row.rows[0]).toEqual({ decision_id: null, status: "superseded" });
  });

  it("atomically declines a pending proposal without making it deployable", async () => {
    const current = await pendingProposal();
    const input = {
      action: "decline" as const,
      callbackQueryId: "query-decline",
      callbackToken: TOKEN,
      telegramChatId: "101",
      telegramChatType: "private" as const,
      telegramMessageId: "77",
      telegramUserId: "101",
    };

    await expect(softwareUpdateRepository.claimDecision(input)).resolves.toMatchObject({
      proposalId: current.proposalId,
      status: "declined",
    });
    await expect(softwareUpdateRepository.claimDecision(input))
      .resolves.toEqual({ status: "expired" });
    const row = await database().query<{ status: string }>(
      "SELECT status FROM software_update_proposals WHERE id = $1",
      [current.proposalId],
    );
    expect(row.rows[0]?.status).toBe("declined");
  });
});
