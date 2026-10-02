import { describe, expect, it } from "vitest";

import { newSessionId, newTurnId } from "./ids.js";

describe("runtime identifiers", () => {
  it("issue turn and session ids in the ULID shape the stores and the sandbox runner accept", () => {
    expect(newTurnId()).toMatch(/^turn_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(newSessionId()).toMatch(/^wrun_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("sort by creation time and never repeat", () => {
    const ids = Array.from({ length: 50 }, (_, index) => newTurnId(1_759_400_000_000 + index * 1_000));

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 1_000 }, () => newTurnId())).size).toBe(1_000);
  });

  it("encode the time like a ULID", () => {
    expect(newTurnId(0).slice(5, 15)).toBe("0000000000");
    expect(newTurnId(2 ** 48 - 1).slice(5, 15)).toBe("7ZZZZZZZZZ");
  });
});
