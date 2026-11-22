/**
 * Memory subject person label tests.
 *
 * Constructs covered:
 * - `formatMemorySubjectPerson`: «Имя (@username)», a bare name, a bare @username, or nothing.
 * - `loadWrittenMemorySubjectPeople`: a database that blinks after a committed write costs only
 *   `about`, and the miss is logged with its code.
 */
import { describe, expect, it, vi } from "vitest";

import { formatMemorySubjectPerson, loadWrittenMemorySubjectPeople } from "./memory-subject-person.js";

vi.mock("./database.js", () => ({
  database: () => ({
    query: async () => {
      throw Object.assign(new Error("Connection terminated"), { code: "AGENT_DATABASE_UNAVAILABLE" });
    },
  }),
}));

describe("formatMemorySubjectPerson", () => {
  it("names the person with their username", () => {
    expect(formatMemorySubjectPerson({ name: "Нина Соколова", username: "nina_s" }))
      .toBe("Нина Соколова (@nina_s)");
  });

  it("keeps the name alone for a person without a username", () => {
    expect(formatMemorySubjectPerson({ name: "Нина", username: null })).toBe("Нина");
  });

  it("falls back to the username when Telegram gave no name", () => {
    expect(formatMemorySubjectPerson({ name: "  ", username: "nina_s" })).toBe("@nina_s");
  });

  it("names nobody when there is neither", () => {
    expect(formatMemorySubjectPerson({ name: null, username: null })).toBeNull();
  });
});

describe("loadWrittenMemorySubjectPeople", () => {
  it("answers without people and logs the miss when the database blinks after the write", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadWrittenMemorySubjectPeople(["00000000-0000-4000-8000-000000000001"]))
      .resolves.toEqual(new Map());
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      causeCode: "AGENT_DATABASE_UNAVAILABLE", code: "AGENT_MEMORY_SUBJECT_PERSON_UNAVAILABLE", records: 1,
    }]);
    logged.mockRestore();
  });
});
