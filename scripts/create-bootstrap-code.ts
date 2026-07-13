/**
 * First-owner bootstrap code generator.
 *
 * Constructs:
 * - Invalidates an earlier active code.
 * - Persists only a SHA-256 hash and prints plaintext once.
 */
import pg from "pg";

import { createBootstrapCode } from "../agent/lib/bootstrap-code.ts";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных");
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const owner = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM family_memberships WHERE role = 'owner') AS exists",
  );
  if (owner.rows[0]?.exists) {
    throw new Error("AGENT_OWNER_ALREADY_EXISTS: Первый владелец уже создан");
  }

  const generated = createBootstrapCode(new Date());
  await client.query("BEGIN");
  try {
    await client.query(
      "UPDATE bootstrap_codes SET consumed_at = now() WHERE consumed_at IS NULL",
    );
    await client.query(
      `INSERT INTO bootstrap_codes (code_hash, created_at, expires_at)
       VALUES ($1, $2, $3)`,
      [generated.record.codeHash, generated.record.createdAt, generated.record.expiresAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  process.stdout.write(
    `Одноразовый код владельца (действует 15 минут):\n${generated.code}\n`,
  );
} finally {
  await client.end();
}
