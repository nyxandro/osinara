/**
 * Which API keys the owner's skills given to a guest mention but the guest was not granted (#474).
 *
 * Export:
 * - `guestSkillKeyNeeds`: per guest, each given skill whose text or files name `<NAME>_API_KEY` or `<NAME>_BASE_URL`
 *   of a stored key of the host family that the guest lacks, so the owner's agent offers to grant it instead of the
 *   skill failing on the guest's first run.
 *
 * Only key names leave this module: never a value, a placeholder or a skill's content. A skill that reaches a key
 * under another name is not found, which only costs the hint.
 */
import type { Pool, PoolClient } from "pg";

import { apiKeyEnvironmentNames } from "../api-keys/api-key-contract.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface SkillKeyNeed {
  readonly keys: readonly string[];
  readonly skill: string;
}

interface GuestKeyState {
  readonly apiKeys: readonly string[];
  readonly grantedSkills: readonly string[];
  readonly guestUserId: string;
}

/** The text of a skill's current version: its body and every file, decoded as text. */
async function skillTexts(queryable: Queryable, hostFamilyId: string, names: readonly string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const rows = (await queryable.query<{ files: Array<{ content: string }>; markdown: string; name: string }>(
    `SELECT skill.name, version.markdown, version.files
       FROM family_skills skill
       JOIN family_skill_versions version ON version.skill_id = skill.id AND version.version = skill.active_version
      WHERE skill.family_id = $1 AND skill.name = ANY($2::text[])`,
    [hostFamilyId, [...names]],
  )).rows;
  return new Map(rows.map((row) => [
    row.name,
    [row.markdown, ...row.files.map((file) => Buffer.from(file.content, "base64").toString("utf8"))].join("\n"),
  ]));
}

function mentions(text: string, keyName: string): boolean {
  const { apiKey, baseUrl } = apiKeyEnvironmentNames(keyName);
  // A whole variable name only: `MY_IMAGEGEN_API_KEY` is not the key `imagegen`.
  return [apiKey, baseUrl].some((variable) => new RegExp(`(?<![A-Z0-9_])${variable}(?![A-Z0-9_])`, "u").test(text));
}

export async function guestSkillKeyNeeds(
  queryable: Queryable,
  hostFamilyId: string,
  guests: readonly GuestKeyState[],
): Promise<Map<string, SkillKeyNeed[]>> {
  const needs = new Map<string, SkillKeyNeed[]>(guests.map((guest) => [guest.guestUserId, []]));
  const skillNames = [...new Set(guests.flatMap((guest) => guest.grantedSkills))];
  if (skillNames.length === 0) return needs;
  const storedKeys = (await queryable.query<{ name: string }>(
    "SELECT name FROM sandbox_api_keys WHERE family_id = $1 AND value_stored_at IS NOT NULL ORDER BY name",
    [hostFamilyId],
  )).rows.map((row) => row.name);
  const texts = await skillTexts(queryable, hostFamilyId, skillNames);
  for (const guest of guests) {
    const granted = new Set(guest.apiKeys);
    needs.set(guest.guestUserId, [...guest.grantedSkills].sort().flatMap((skill) => {
      const text = texts.get(skill);
      const keys = text === undefined ? [] : storedKeys.filter((key) => !granted.has(key) && mentions(text, key));
      return keys.length === 0 ? [] : [{ keys, skill }];
    }));
  }
  return needs;
}
