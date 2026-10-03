/**
 * Live Telegram attachment authorization integration tests.
 *
 * Constructs covered:
 * - `telegramGroupAttachmentRepository.find` and `list`: revalidate family membership at read time.
 * - Registered external group removal and trust-zone replacement invalidate stale references.
 */
import type { TelegramMessage } from "../../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { database, closeDatabase } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { recordVerifiedHumanTelegramMessage } from "../telegram-group-journal.integration-fixtures.js";
import { telegramGroupAttachmentRepository } from "./telegram-group-attachment-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith("_test"))) {
  throw new Error(
    "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты live authorization разрешены только для БД *_test",
  );
}

const describeWithDatabase = enabled ? describe : describe.skip;

async function createOwnedFamily(suffix: string): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`owner-attachment-${suffix}`, `Владелец ${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  const ownerId = user.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  return { familyId, ownerId };
}

function photoMessage(messageId: string, telegramChatId: string): TelegramMessage {
  return {
    attachments: [{
      fileId: `photo-${messageId}`,
      fileUniqueId: `photo-unique-${messageId}`,
      kind: "photo",
      mediaType: "image/jpeg",
      size: 2_048,
    }],
    caption: "",
    chat: { id: telegramChatId, title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false },
    messageId,
    raw: { date: 1_700_000_000 + Number(messageId), photo: [{ file_id: `photo-${messageId}` }] },
    text: "",
  };
}

async function createReference(input: {
  familyId: string;
  ownerId: string;
  telegramChatId: string;
  type: "external" | "family_private";
}) {
  const group = await telegramGroupAdministrationRepository.registerGroup({
    familyId: input.familyId,
    messageMode: "addressed_only",
    requestedBy: input.ownerId,
    telegramChatId: input.telegramChatId,
    title: "Группа с изображением",
    toolAllowlist: input.type === "external" ? ["inspect_workspace_image"] : [],
    type: input.type,
  });
  const message = photoMessage("43", input.telegramChatId);
  await recordVerifiedHumanTelegramMessage(group.groupId, message);
  const reference = await telegramGroupAttachmentRepository.record(group.groupId, message);
  return { attachmentId: reference.attachmentId, groupId: group.groupId };
}

describeWithDatabase("Telegram attachment live authorization", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("rejects a family attachment when membership was revoked immediately before lookup", async () => {
    const { familyId, ownerId } = await createOwnedFamily("membership-revoked");
    const reference = await createReference({
      familyId,
      ownerId,
      telegramChatId: "-100-live-family",
      type: "family_private",
    });
    const staleAuth = {
      familyId,
      groupId: reference.groupId,
      groupType: "family_private" as const,
      role: "owner" as const,
      telegramChatType: "supergroup" as const,
      userId: ownerId,
    };

    // Simulate revocation after session authorization but before the tool resolves Telegram bytes.
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [familyId, ownerId],
    );

    await expect(telegramGroupAttachmentRepository.find(
      staleAuth,
      reference.attachmentId,
    )).rejects.toThrowError(/AGENT_TELEGRAM_ATTACHMENT_ACCESS_REVOKED/);
  });

  it("rejects the family attachment list when membership was revoked", async () => {
    const { familyId, ownerId } = await createOwnedFamily("list-membership-revoked");
    const reference = await createReference({
      familyId,
      ownerId,
      telegramChatId: "-100-live-family-list",
      type: "family_private",
    });
    const staleAuth = {
      familyId,
      groupId: reference.groupId,
      groupType: "family_private" as const,
      role: "owner" as const,
      telegramChatType: "supergroup" as const,
      userId: ownerId,
    };
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [familyId, ownerId],
    );

    await expect(telegramGroupAttachmentRepository.list(staleAuth, {
      limit: 10,
      messageThreadId: null,
    })).rejects.toThrowError(/AGENT_TELEGRAM_ATTACHMENT_ACCESS_REVOKED/);
  });

  it("rejects an external attachment after its registered group was removed", async () => {
    const { familyId, ownerId } = await createOwnedFamily("external-removed");
    const reference = await createReference({
      familyId,
      ownerId,
      telegramChatId: "-100-live-external-removed",
      type: "external",
    });
    const staleAuth = {
      familyId,
      groupId: reference.groupId,
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [reference.groupId]);

    await expect(telegramGroupAttachmentRepository.find(
      staleAuth,
      reference.attachmentId,
    )).rejects.toThrowError(/AGENT_TELEGRAM_ATTACHMENT_NOT_FOUND/);
  });

  it("rejects an external attachment after the chat is retyped into a new trust zone", async () => {
    const { familyId, ownerId } = await createOwnedFamily("external-retyped");
    const telegramChatId = "-100-live-external-retyped";
    const reference = await createReference({
      familyId,
      ownerId,
      telegramChatId,
      type: "external",
    });
    const staleAuth = {
      familyId,
      groupId: reference.groupId,
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };

    const replacement = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId,
      title: "Новая семейная trust zone",
      toolAllowlist: [],
      type: "family_private",
    });
    expect(replacement.groupId).not.toBe(reference.groupId);

    await expect(telegramGroupAttachmentRepository.find(
      staleAuth,
      reference.attachmentId,
    )).rejects.toThrowError(/AGENT_TELEGRAM_ATTACHMENT_NOT_FOUND/);
  });
});
