/**
 * Consolidated memory mutation routing tests.
 *
 * Constructs:
 * - `manage_memory.edit`: strips the model-facing discriminator before repository hashing.
 * - Delete and undo actions reuse the authorized idempotent deletion boundary.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMemory, updateMemory } = vi.hoisted(() => ({
  deleteMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { delete: deleteMemory, update: updateMemory },
}));

import manageMemory from "../tools/manage_memory.js";

const ID = "00000000-0000-4000-8000-000000000001";
const context = { callId: "call-1" } as ToolContext;

describe("manage_memory", () => {
  beforeEach(() => {
    deleteMemory.mockReset();
    updateMemory.mockReset();
  });

  it("passes only repository fields for an edit", async () => {
    updateMemory.mockResolvedValue({ id: ID });

    await manageMemory.execute({ action: "edit", content: "Исправлено", id: ID }, context);

    expect(updateMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      { content: "Исправлено", id: ID, operationKey: "call-1" },
    );
  });

  it.each(["delete", "undo"] as const)("routes %s through idempotent deletion", async (action) => {
    deleteMemory.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action, id: ID }, context);

    expect(deleteMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      ID,
      "call-1",
    );
  });
});
