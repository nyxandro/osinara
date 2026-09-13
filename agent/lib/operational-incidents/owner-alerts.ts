/** Durable system incidents: one logical failure, one verified owner-private delivery. */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import type { PoolClient } from "pg";

export interface OperationalIncident {
  key: string;
  code: string;
  summary: string;
  context: Readonly<Record<string, string | number | null>>;
}

export async function recordOperationalIncident(input: OperationalIncident, client: Pick<PoolClient, "query"> = database()): Promise<void> {
  if (!input.key || input.key.length > 500 || !/^AGENT_[A-Z0-9_]+$/.test(input.code) || !input.summary || input.summary.length > 1000) {
    throw new AppError("AGENT_INCIDENT_INVALID", "Не удалось сохранить диагностику: неверные данные инцидента");
  }
  await client.query(`INSERT INTO operational_incidents(operation_key,code,summary,context)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(operation_key) DO NOTHING`,
  [input.key, input.code, input.summary, JSON.stringify(input.context)]);
}

export async function dispatchOperationalIncidents(dependencies = { deliver: memoryReviewOwnerAlertTransport.deliver }): Promise<number> {
  const client = await database().connect();
  let rows: Array<{ id: string; delivery_token: string; recipient_telegram_id: string; code: string; summary: string; context: Record<string, string | number | null> }>;
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE operational_incidents SET status='ambiguous',delivery_token=NULL,updated_at=now()
      WHERE status='delivering' AND delivery_started_at < now()-interval '2 minutes'`);
    const owner = await client.query<{ id: string; telegram_user_id: string }>(`SELECT u.id,u.telegram_user_id
      FROM users u JOIN family_memberships m ON m.user_id=u.id WHERE m.role='owner' FOR SHARE OF m,u`);
    if (owner.rows.length !== 1) {
      await client.query("COMMIT");
      if (owner.rows.length > 1) throw new AppError("AGENT_INCIDENT_OWNER_AMBIGUOUS", "Не удалось определить единственного владельца для уведомлений");
      return 0;
    }
    const current = owner.rows[0]!;
    const claimed = await client.query<(typeof rows)[number]>(`WITH candidates AS (
      SELECT id FROM operational_incidents WHERE status='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 10
    ) UPDATE operational_incidents item SET status='delivering',delivery_token=gen_random_uuid(),delivery_started_at=now(),
      recipient_user_id=$1,recipient_telegram_id=$2,updated_at=now() FROM candidates WHERE item.id=candidates.id RETURNING item.*`, [current.id, current.telegram_user_id]);
    rows = claimed.rows;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  for (const incident of rows) {
    // Recheck immediately before the external send; the old owner never receives new diagnostics.
    const authorized = await database().query(`SELECT 1 FROM family_memberships m JOIN users u ON u.id=m.user_id
      JOIN operational_incidents i ON i.recipient_user_id=u.id AND i.recipient_telegram_id=u.telegram_user_id
      WHERE i.id=$1 AND i.delivery_token=$2 AND m.role='owner'`, [incident.id, incident.delivery_token]);
    let status = "failed";
    if (authorized.rowCount === 1) {
      const context = Object.entries(incident.context).filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}: ${value}`).join("\n");
      try {
        await dependencies.deliver({ chatId: incident.recipient_telegram_id,
          text: `${incident.code}\n\n${incident.summary}${context ? `\n\n${context}` : ""}` });
        status = "delivered";
      } catch (error) {
        status = "ambiguous";
        console.error(JSON.stringify({ code: "AGENT_INCIDENT_DELIVERY_UNCONFIRMED", incidentId: incident.id,
          errorName: error instanceof Error ? error.name : "UnknownError" }));
      }
    }
    await database().query(`UPDATE operational_incidents SET status=$3,delivery_token=NULL,updated_at=now()
      WHERE id=$1 AND delivery_token=$2 AND status='delivering'`, [incident.id, incident.delivery_token, status]);
  }
  return rows.length;
}
