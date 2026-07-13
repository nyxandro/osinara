/**
 * PostgreSQL software update proposal repository.
 *
 * Exports:
 * - `createSoftwareUpdateRepository`: testable repository with explicit installed version.
 * - `softwareUpdateRepository`: durable proposal, Telegram binding, and atomic owner decision state.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { CURRENT_SOFTWARE_VERSION } from "./current-version.js";
import { compareSemver, parseSemver } from "./semver.js";
import type {
  ClaimSoftwareUpdateDecisionInput,
  SoftwareUpdateDecisionClaim,
  SoftwareUpdateRepository,
} from "./types.js";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const SOFTWARE_UPDATE_PROPOSAL_LOCK_KEY = "osinara-software-update-proposals";

interface SoftwareUpdateRepositoryDependencies {
  currentVersion: string;
}

async function rollbackAndRethrow(client: PoolClient, error: unknown): Promise<never> {
  await client.query("ROLLBACK");
  throw error;
}

function requirePositiveTelegramMessageId(messageId: string): void {
  if (!POSITIVE_INTEGER_PATTERN.test(messageId)) {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_MESSAGE_INVALID",
      "Telegram не передал корректный идентификатор сообщения обновления",
    );
  }
}

function callbackTokenHash(token: string): string {
  if (!token) {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_CALLBACK_INVALID",
      "Кнопка обновления не содержит защитный токен",
    );
  }
  return createHash("sha256").update(token).digest("hex");
}

async function ownerStillCurrent(
  client: PoolClient,
  row: {
    expected_owner_telegram_user_id: string;
    expected_owner_user_id: string;
    family_id: string;
  },
): Promise<boolean> {
  const result = await client.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM family_memberships fm
         JOIN users u ON u.id = fm.user_id
        WHERE fm.family_id = $1
          AND fm.user_id = $2
          AND fm.role = 'owner'
          AND u.telegram_user_id = $3
     ) AS current`,
    [row.family_id, row.expected_owner_user_id, row.expected_owner_telegram_user_id],
  );
  return result.rows[0]?.current === true;
}

async function lockProposalByToken(
  client: PoolClient,
  input: ClaimSoftwareUpdateDecisionInput,
) {
  const result = await client.query<{
    expected_owner_telegram_user_id: string;
    expected_owner_user_id: string;
    family_id: string;
    id: string;
    status: string;
    target_version: string;
    telegram_chat_id: string | null;
    telegram_chat_type: string | null;
    telegram_message_id: string | null;
  }>(
    `SELECT id, family_id, expected_owner_user_id, expected_owner_telegram_user_id,
             status, target_version, telegram_chat_id, telegram_chat_type,
             telegram_message_id::text
       FROM software_update_proposals
      WHERE callback_token_hash = $1
      FOR UPDATE`,
    [callbackTokenHash(input.callbackToken)],
  );
  return result.rows[0] ?? null;
}

export function createSoftwareUpdateRepository(
  dependencies: SoftwareUpdateRepositoryDependencies,
): SoftwareUpdateRepository {
  const currentVersion = parseSemver(dependencies.currentVersion).version;

  return {
  async findCurrentOwner() {
    const result = await database().query<{
      family_id: string;
      telegram_user_id: string;
      user_id: string;
    }>(
      `SELECT fm.family_id, fm.user_id, u.telegram_user_id
         FROM family_memberships fm
         JOIN users u ON u.id = fm.user_id
        WHERE fm.role = 'owner'
        ORDER BY fm.created_at
        LIMIT 2`,
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new AppError(
        "AGENT_SOFTWARE_UPDATE_OWNER_AMBIGUOUS",
        "Найдено несколько владельцев программы. Исправьте семейные области перед обновлением",
      );
    }
    const owner = result.rows[0]!;
    return {
      familyId: owner.family_id,
      telegramUserId: owner.telegram_user_id,
      userId: owner.user_id,
    };
  },

  async prepareProposal(input) {
    if (!SHA256_HEX_PATTERN.test(input.callbackTokenHash)) {
      throw new AppError(
        "AGENT_SOFTWARE_UPDATE_CALLBACK_HASH_INVALID",
        "Не удалось безопасно подготовить кнопки обновления",
      );
    }
    if (compareSemver(input.release.version, currentVersion) <= 0) {
      throw new AppError(
        "AGENT_SOFTWARE_UPDATE_TARGET_NOT_NEWER",
        "Предлагаемая версия обновления не новее установленной",
      );
    }

    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // The advisory lock also serializes the empty-table case for concurrent schedule runs.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        SOFTWARE_UPDATE_PROPOSAL_LOCK_KEY,
      ]);
      const existing = await client.query(
        "SELECT 1 FROM software_update_proposals WHERE target_version = $1",
        [input.release.version],
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return { status: "duplicate" };
      }

      const open = await client.query<{ id: string; target_version: string }>(
        `SELECT id, target_version
           FROM software_update_proposals
          WHERE status IN ('preparing', 'pending')
          FOR UPDATE`,
      );
      if (open.rows.some((row) => compareSemver(row.target_version, input.release.version) >= 0)) {
        throw new AppError(
          "AGENT_SOFTWARE_UPDATE_TARGET_ORDER_INVALID",
          "Новый релиз не новее уже открытого предложения обновления",
        );
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO software_update_proposals
           (family_id, expected_owner_user_id, expected_owner_telegram_user_id,
            target_version, release_url, manifest, callback_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [
          input.owner.familyId,
          input.owner.userId,
          input.owner.telegramUserId,
          input.release.version,
          input.release.releaseUrl,
          JSON.stringify(input.release.manifest),
          input.callbackTokenHash,
        ],
      );
      if (open.rows.length > 0) {
        // Supersession and insertion commit together, so old buttons cannot race a partial update.
        await client.query(
          `UPDATE software_update_proposals
              SET status = 'superseded',
                  superseded_at = now(),
                  completed_at = now(),
                  updated_at = now()
            WHERE id = ANY($1::uuid[]) AND status IN ('preparing', 'pending')`,
          [open.rows.map((row) => row.id)],
        );
      }
      await client.query("COMMIT");
      return { proposalId: inserted.rows[0]!.id, status: "created" };
    } catch (error) {
      return rollbackAndRethrow(client, error);
    } finally {
      client.release();
    }
  },

  async bindPendingTelegramMessage(input) {
    requirePositiveTelegramMessageId(input.messageId);
    const result = await database().query(
      `UPDATE software_update_proposals proposal
          SET status = 'pending',
              telegram_chat_id = $2,
              telegram_chat_type = $3,
              telegram_message_id = $4,
              placeholder_sent_at = now(),
              pending_at = now(),
              updated_at = now()
        WHERE proposal.id = $1
          AND proposal.status = 'preparing'
          AND proposal.expected_owner_telegram_user_id = $2
          AND EXISTS (
            SELECT 1
              FROM family_memberships fm
              JOIN users u ON u.id = fm.user_id
             WHERE fm.family_id = proposal.family_id
               AND fm.user_id = proposal.expected_owner_user_id
               AND fm.role = 'owner'
               AND u.telegram_user_id = proposal.expected_owner_telegram_user_id
          )`,
      [input.proposalId, input.chatId, input.chatType, input.messageId],
    );
    return result.rowCount === 1 ? "bound" : "rejected";
  },

  async markDeliveryFailure(input) {
    const result = await database().query(
      `UPDATE software_update_proposals
          SET status = $2,
              result_error_code = $3,
              result_error_message = $4,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1 AND status IN ('preparing', 'pending')`,
      [input.proposalId, input.status, input.code, input.message],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_SOFTWARE_UPDATE_STATE_CONFLICT",
        "Состояние предложения обновления уже изменилось",
      );
    }
  },

  async claimDecision(input): Promise<SoftwareUpdateDecisionClaim> {
    requirePositiveTelegramMessageId(input.telegramMessageId);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const row = await lockProposalByToken(client, input);
      if (!row || row.status !== "pending") {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }

      // Every value must match the durable private-message binding before current role is checked.
      const exactBinding = input.telegramChatType === "private" &&
        row.telegram_chat_type === "private" &&
        row.telegram_chat_id === input.telegramChatId &&
        row.telegram_message_id === input.telegramMessageId &&
        row.expected_owner_telegram_user_id === input.telegramUserId;
      if (!exactBinding || !await ownerStillCurrent(client, row)) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }

      // An update installed after prompt delivery invalidates approval without creating a decision.
      if (compareSemver(row.target_version, currentVersion) <= 0) {
        await client.query(
          `UPDATE software_update_proposals
              SET status = 'superseded',
                  superseded_at = now(),
                  completed_at = now(),
                  updated_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [row.id],
        );
        await client.query("COMMIT");
        return { status: "expired" };
      }

      const status = input.action === "approve" ? "approved" : "declined";
      const decided = await client.query<{ decision_id: string }>(
        `UPDATE software_update_proposals
            SET status = $2,
                decision_id = gen_random_uuid(),
                decision_callback_query_id = $3,
                decided_at = now(),
                updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING decision_id::text`,
        [row.id, status, input.callbackQueryId],
      );
      if (decided.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      await client.query("COMMIT");
      return {
        decisionId: decided.rows[0]!.decision_id,
        proposalId: row.id,
        status,
      };
    } catch (error) {
      return rollbackAndRethrow(client, error);
    } finally {
      client.release();
    }
  },

  async recordDecisionUiFailure(input) {
    await database().query(
      `UPDATE software_update_proposals
          SET decision_ui_error_code = coalesce(decision_ui_error_code, $2),
              decision_ui_error_message = coalesce(decision_ui_error_message, $3),
              decision_ui_failed_at = coalesce(decision_ui_failed_at, now()),
              updated_at = now()
        WHERE id = $1 AND decision_id IS NOT NULL`,
      [input.proposalId, input.code, input.message],
    );
  },
  };
}

export const softwareUpdateRepository = createSoftwareUpdateRepository({
  currentVersion: CURRENT_SOFTWARE_VERSION,
});
