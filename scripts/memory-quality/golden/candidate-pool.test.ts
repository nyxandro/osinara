/**
 * Candidate pool guard tests.
 *
 * Constructs covered:
 * - The ungated pool binds the product's own statement with exactly its gates opened and its
 *   per-branch candidate count changed; every other parameter is the product's, unchanged.
 * - A parameter list whose gates are no longer where the pool expects them, or that has grown,
 *   stops the run instead of measuring a different search; so does any edit to the statement, and
 *   the statement as it stands is the one the gates were checked against.
 * - Only a fresh copy whose name marks it as one, tuned like production and migrated as far as
 *   the repository, is marked spent and used; every refusal leaves the copy unspent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
} from "../../../agent/lib/memory-config.js";
import {
  memoryRetrievalSearchParameters,
  memoryRetrievalSearchStatement,
} from "../../../agent/lib/memory-retrieval-repository.js";
import {
  POOL_CANDIDATES_PER_BRANCH,
  requireDisposableCopy,
  requireReviewedSearchStatement,
  ungatedSearchParameters,
} from "./candidate-pool.js";

const copy = vi.hoisted(() => ({
  analyzed: 2, applied: ["001_a.sql", "002_b.sql"], iterative: true, name: "osinara_eval", spent: false,
  statements: [] as string[],
}));

vi.mock("../../../agent/lib/database.js", () => ({
  database: () => ({
    query: async (sql: string) => {
      copy.statements.push(sql);
      if (sql.includes("current_database() AS name")) return { rows: [{ name: copy.name }] };
      if (sql.includes("AS spent")) return { rows: [{ spent: copy.spent }] };
      if (sql.includes("AS iterative")) return { rows: [{ analyzed: copy.analyzed, iterative: copy.iterative }] };
      if (sql.includes("FROM schema_migrations")) return { rows: copy.applied.map((name) => ({ name })) };
      return { rows: [] };
    },
  }),
}));

const auth = {
  familyId: "family-1", groupId: null, role: "owner" as const, scopes: ["personal" as const],
  telegramActorId: "101", telegramActorKind: "telegram_user" as const, telegramUserId: "101", userId: "user-1",
};
const vector = Array.from({ length: 384 }, () => 0.01);

describe("ungatedSearchParameters", () => {
  it("opens the gates and widens nothing else", () => {
    const product = memoryRetrievalSearchParameters(auth, "где бэкап", [vector]);
    const ungated = ungatedSearchParameters(product);

    const changed = product.flatMap((value, index) => (value === ungated[index] ? [] : [index]));
    expect(changed).toEqual([5, 6, 7, 10]);
    expect([ungated[5], ungated[6], ungated[7], ungated[10]])
      .toEqual([POOL_CANDIDATES_PER_BRANCH, 1, 1, -1]);
  });

  it("stops when the gates are no longer where it expects them", () => {
    const product = memoryRetrievalSearchParameters(auth, "где бэкап", [vector]);
    const shifted = [...product.slice(0, 5), "extra", ...product.slice(5)];

    expect(product[5]).toBe(MEMORY_RETRIEVAL_CANDIDATE_LIMIT);
    expect(product[10]).toBe(MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY);
    expect(() => ungatedSearchParameters(shifted)).toThrow(/AGENT_MEMORY_GOLDEN_PARAMETERS_CHANGED/u);
  });

  it("stops when the statement has grown a parameter past the gates it knows", () => {
    const product = memoryRetrievalSearchParameters(auth, "где бэкап", [vector]);

    expect(() => ungatedSearchParameters([...product, 0.5])).toThrow(/AGENT_MEMORY_GOLDEN_PARAMETERS_CHANGED/u);
  });
});

describe("requireReviewedSearchStatement", () => {
  // Fails on any edit to the product statement: GATES have to be checked against the new text
  // and the digest updated in the same change, not discovered on the next measurement run.
  it("accepts the product statement the gates were checked against", () => {
    expect(() => requireReviewedSearchStatement(memoryRetrievalSearchStatement())).not.toThrow();
  });

  it("stops at a statement the gates were not checked against", () => {
    expect(() => requireReviewedSearchStatement("SELECT 1 WHERE similarity >= 0.9"))
      .toThrow(/AGENT_MEMORY_GOLDEN_STATEMENT_CHANGED/u);
  });
});

describe("requireDisposableCopy", () => {
  const repository = ["001_a.sql", "002_b.sql"];
  const marked = () => copy.statements.some((sql) => sql.startsWith("CREATE TABLE memory_golden_eval_run"));

  beforeEach(() => {
    Object.assign(copy, {
      analyzed: 2, applied: [...repository, "000_removed_since.sql"], iterative: true, name: "osinara_eval",
      spent: false, statements: [],
    });
  });

  it("marks a fresh, tuned, migrated copy as spent", async () => {
    await requireDisposableCopy(repository);

    expect(marked()).toBe(true);
  });

  it.each([
    ["a database not named as a copy", { name: "osinara" }, "AGENT_MEMORY_GOLDEN_DATABASE_UNSAFE"],
    ["a copy an earlier run used", { spent: true }, "AGENT_MEMORY_GOLDEN_COPY_SPENT"],
    ["a copy without the vector scan setting", { iterative: false }, "AGENT_MEMORY_GOLDEN_COPY_UNTUNED"],
    ["a copy without table statistics", { analyzed: 1 }, "AGENT_MEMORY_GOLDEN_COPY_UNTUNED"],
    ["a copy behind the repository's migrations", { applied: ["001_a.sql"] }, "AGENT_MEMORY_GOLDEN_COPY_SCHEMA_BEHIND"],
  ])("refuses %s and leaves it unspent", async (_case, state, code) => {
    Object.assign(copy, state);

    await expect(requireDisposableCopy(repository)).rejects.toThrow(new RegExp(code, "u"));
    expect(marked()).toBe(false);
  });
});
