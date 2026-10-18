/**
 * The skills a newly registered group starts with.
 *
 * Constructs covered:
 * - `EXTERNAL_GROUP_BASE_SKILLS`: every name is an installed built-in skill.
 * - Registration: a new external group gets the base set, without the script skills while it has no
 *   Bash; a family group starts with an empty list of family skills; re-registering keeps the list.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { EXTERNAL_GROUP_BASE_SKILLS, GROUP_SAFE_SKILL_NAMES } from "./group-skill-catalog.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}

async function owner() {
  const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Base') RETURNING id")).rows[0]!.id;
  const userId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('7001', 'Owner') RETURNING id",
  )).rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
  return { familyId, requestedBy: userId };
}

async function skills(telegramChatId: string): Promise<string[]> {
  return (await database().query<{ skill_allowlist: string[] }>(
    "SELECT skill_allowlist FROM telegram_groups WHERE telegram_chat_id = $1", [telegramChatId],
  )).rows[0]!.skill_allowlist;
}

describe("external group base skills", () => {
  it("names installed built-in skills only", () => {
    expect(GROUP_SAFE_SKILL_NAMES).toEqual(expect.arrayContaining([...EXTERNAL_GROUP_BASE_SKILLS]));
  });
});

(enabled ? describe : describe.skip)("group registration skills", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("starts an external group with the base set and a family group with no family skills", async () => {
    const who = await owner();
    const register = (telegramChatId: string, type: "external" | "family_private", toolAllowlist: string[]) =>
      telegramGroupAdministrationRepository.registerGroup({
        ...who, messageMode: "all", telegramChatId, title: telegramChatId, toolAllowlist, type,
      } as never);

    await register("-1007001", "external", []);
    await register("-1007002", "external", ["bash"]);
    await register("-1007003", "family_private", []);

    expect(await skills("-1007001")).toEqual(["behavior-preferences"]);
    expect(await skills("-1007002")).toEqual([...EXTERNAL_GROUP_BASE_SKILLS]);
    expect(await skills("-1007003")).toEqual([]);

    // Registering the same group again keeps the list the owner has shaped since.
    await telegramGroupAdministrationRepository.updateSkills({ ...who, skillAllowlist: ["pdf"], telegramChatId: "-1007002" });
    await register("-1007002", "external", ["bash"]);
    expect(await skills("-1007002")).toEqual(["pdf"]);
  });
});
