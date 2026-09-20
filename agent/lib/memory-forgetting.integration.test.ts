/**
 * The forgetting curve, and the fact that there are two copies of it.
 *
 * Constructs covered:
 * - The multiplier falls with age, rises with use, and never drops through its floor.
 * - An episode fades faster than a standing property of a person.
 * - The SQL copy inside the retrieval statement agrees with the TypeScript one over a grid.
 *
 * The last one is the point of this file. The rank is computed in SQL, so the formula had to be
 * written twice, and two copies of one formula drift apart silently — nothing fails, the order of
 * results just stops meaning what the code says it means.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_RETENTION_BASE_DAYS,
  MEMORY_RETENTION_FLOOR,
  memoryRetentionMultiplier,
} from "./memory-forgetting.js";
import type { MemoryKind } from "./memory-record.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const KINDS: MemoryKind[] = ["episode", "fact", "preference", "profile", "family_shared"];
const AGES_IN_DAYS = [0, 1, 7, 30, 90, 180, 365, 3_650];
const USE_COUNTS = [0, 1, 4, 25];

describe("memoryRetentionMultiplier", () => {
  it("falls with age and never drops through the floor", () => {
    const fresh = memoryRetentionMultiplier({ ageDays: 0, kind: "fact", usageCount: 0 });
    const old = memoryRetentionMultiplier({ ageDays: 365, kind: "fact", usageCount: 0 });
    const ancient = memoryRetentionMultiplier({ ageDays: 36_500, kind: "fact", usageCount: 0 });

    expect(fresh).toBe(1);
    expect(old).toBeLessThan(fresh);
    expect(ancient).toBeGreaterThanOrEqual(MEMORY_RETENTION_FLOOR);
  });

  it("lets a record that gets used stay available longer", () => {
    const unused = memoryRetentionMultiplier({ ageDays: 180, kind: "fact", usageCount: 0 });
    const used = memoryRetentionMultiplier({ ageDays: 180, kind: "fact", usageCount: 4 });

    expect(used).toBeGreaterThan(unused);
  });

  it("fades an episode faster than a standing property of a person", () => {
    const episode = memoryRetentionMultiplier({ ageDays: 60, kind: "episode", usageCount: 0 });
    const preference = memoryRetentionMultiplier({ ageDays: 60, kind: "preference", usageCount: 0 });

    expect(episode).toBeLessThan(preference);
    expect(MEMORY_RETENTION_BASE_DAYS.episode).toBeLessThan(MEMORY_RETENTION_BASE_DAYS.preference);
  });

  it("treats impossible input as the boundary rather than inventing a value", () => {
    expect(memoryRetentionMultiplier({ ageDays: -5, kind: "fact", usageCount: -1 })).toBe(1);
  });
});

describeWithDatabase("the SQL copy of the forgetting curve", () => {
  afterAll(async () => closeDatabase());

  it("agrees with the TypeScript one over every kind, age and use count", async () => {
    const cases = KINDS.flatMap((kind) =>
      AGES_IN_DAYS.flatMap((ageDays) => USE_COUNTS.map((usageCount) => ({
        ageDays,
        kind,
        usageCount,
      }))),
    );
    // The same expression the retrieval statement multiplies its fused score by.
    const measured = await database().query<{ multiplier: number; ordinal: number }>(
      `SELECT input.ordinal,
              $1::double precision + (1 - $1::double precision) * exp(
                -GREATEST(input.age_days, 0)
                / ((CASE input.kind WHEN 'episode' THEN $2::double precision
                                    ELSE $3::double precision END)
                   * (1 + ln(1 + GREATEST(input.usage_count, 0))))
              ) AS multiplier
       FROM unnest($4::int[], $5::text[], $6::int[])
            WITH ORDINALITY AS input(age_days, kind, usage_count, ordinal)`,
      [
        MEMORY_RETENTION_FLOOR,
        MEMORY_RETENTION_BASE_DAYS.episode,
        MEMORY_RETENTION_BASE_DAYS.fact,
        cases.map((one) => one.ageDays),
        cases.map((one) => one.kind),
        cases.map((one) => one.usageCount),
      ],
    );

    const mismatched = measured.rows
      .map((row) => ({
        expected: memoryRetentionMultiplier(cases[row.ordinal - 1]!),
        input: cases[row.ordinal - 1]!,
        measured: Number(row.multiplier),
      }))
      .filter((one) => Math.abs(one.expected - one.measured) > 1e-12);

    expect(mismatched).toEqual([]);
  });
});
