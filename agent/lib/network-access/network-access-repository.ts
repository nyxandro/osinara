/**
 * Owner-approved network access persistence.
 *
 * Exports:
 * - `NetworkAccessGrantRecord`: an active grant as the owner sees it.
 * - `networkAccessRepository`: grant, list, revoke, and the full active list the proxy receives.
 *
 * One address and port is active at most once per server: the proxy cannot tell family sandboxes
 * apart, so a second family asking for the same destination already has it.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { NetworkAccessGrant } from "./network-access-contract.js";

export interface NetworkAccessGrantRecord extends NetworkAccessGrant {
  readonly grantedAt: Date;
  readonly purpose: string;
}

interface GrantRow {
  address: string;
  created_at: Date;
  port: number;
  purpose: string;
  revoked_at: Date | null;
}

function toRecord(row: GrantRow): NetworkAccessGrantRecord {
  return { address: row.address, grantedAt: row.created_at, port: row.port, purpose: row.purpose };
}

export const networkAccessRepository = {
  async grant(input: {
    address: string;
    familyId: string;
    grantedBy: string;
    operationKey: string;
    port: number;
    purpose: string;
  }): Promise<{ active: boolean; created: boolean; grant: NetworkAccessGrantRecord }> {
    const inserted = await database().query<GrantRow>(
      `INSERT INTO network_access_grants (family_id, address, port, purpose, granted_by, operation_key)
       VALUES ($1, $2::inet, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING host(address) AS address, port, purpose, created_at, revoked_at`,
      [input.familyId, input.address, input.port, input.purpose, input.grantedBy, input.operationKey],
    );
    if (inserted.rows[0]) return { active: true, created: true, grant: toRecord(inserted.rows[0]) };

    // A replay finds its own row, which must name the same destination.
    const replayed = await database().query<GrantRow>(
      `SELECT host(address) AS address, port, purpose, created_at, revoked_at
         FROM network_access_grants
        WHERE operation_key = $1`,
      [input.operationKey],
    );
    const own = replayed.rows[0];
    if (own) {
      if (own.address !== input.address || own.port !== input.port) {
        throw new AppError(
          "AGENT_NETWORK_ACCESS_OPERATION_CONFLICT",
          "Не удалось выдать доступ: этот вызов уже открыл другой адрес. Повторите запрос",
          { details: { address: input.address, port: input.port } },
        );
      }
      return { active: own.revoked_at === null, created: false, grant: toRecord(own) };
    }

    // A repeated request finds the destination already open.
    const active = await database().query<GrantRow>(
      `SELECT host(address) AS address, port, purpose, created_at, revoked_at
         FROM network_access_grants
        WHERE address = $1::inet AND port = $2 AND revoked_at IS NULL`,
      [input.address, input.port],
    );
    const open = active.rows[0];
    if (!open) {
      throw new Error("AGENT_NETWORK_ACCESS_GRANT_CONFLICT: Grant was neither inserted nor found");
    }
    return { active: true, created: false, grant: toRecord(open) };
  },

  // Lists sort by the stored inet value, not by the text column of the same name: .5 before .20.
  async listActive(familyId: string): Promise<NetworkAccessGrantRecord[]> {
    const result = await database().query<GrantRow>(
      `SELECT host(address) AS address, port, purpose, created_at, revoked_at
         FROM network_access_grants grants
        WHERE family_id = $1 AND revoked_at IS NULL
        ORDER BY grants.address, grants.port`,
      [familyId],
    );
    return result.rows.map(toRecord);
  },

  async listAllActiveDestinations(): Promise<NetworkAccessGrant[]> {
    const result = await database().query<{ address: string; port: number }>(
      `SELECT host(address) AS address, port
         FROM network_access_grants grants
        WHERE revoked_at IS NULL
        ORDER BY grants.address, grants.port`,
    );
    return result.rows.map(({ address, port }) => ({ address, port }));
  },

  async revoke(input: { address: string; familyId: string; port: number; revokedBy: string }): Promise<boolean> {
    const result = await database().query(
      `UPDATE network_access_grants
          SET revoked_at = now(), revoked_by = $4
        WHERE family_id = $1 AND address = $2::inet AND port = $3 AND revoked_at IS NULL`,
      [input.familyId, input.address, input.port, input.revokedBy],
    );
    return result.rowCount === 1;
  },
};
