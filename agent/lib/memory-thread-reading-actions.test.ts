/**
 * Reading memory threads through `manage_memory_thread` (#457: list, search and read replaced three
 * separate tools).
 *
 * Constructs covered:
 * - Each reading action reaches its query with the page or limit it had as a separate tool, needs no
 *   verified Telegram message and never touches the lifecycle of a thread.
 * - A reading call takes only its own fields; a ref of the wrong kind is refused before any query.
 * - A place that may only read gets a descriptor and schema without completion; an external group's
 *   list names only its own scope.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

const query = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), search: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ complete: vi.fn(), reactivate: vi.fn() }));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal", "family"] }),
}));
vi.mock("./memory-thread-query-repository.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-thread-query-repository.js")>(),
  memoryThreadQueryRepository: query,
}));
vi.mock("./memory-thread-lifecycle-repository.js", () => ({ memoryThreadLifecycleRepository: lifecycle }));

const { default: manageMemoryThread, manageMemoryThreadPresentation } = await import("./tools/manage_memory_thread.js");

const THREAD = `thread_${"a".repeat(32)}`;
const ENTRY = `entry_${"b".repeat(32)}`;
// A scheduled run or a silent review has no verified Telegram message: reading must not need one.
const NO_MESSAGE = { callId: "call-1", session: { auth: { current: { attributes: {} } } } } as unknown as ToolContext;
const AUTH = { familyId: "family-1", scopes: ["personal", "family"] };

describe("manage_memory_thread reading actions", () => {
  beforeEach(() => {
    for (const method of [...Object.values(query), ...Object.values(lifecycle)]) method.mockReset();
    query.list.mockResolvedValue({ items: [], nextCursor: null });
    query.search.mockResolvedValue([]);
    query.read.mockResolvedValue({ entries: [], nextCursor: null });
  });

  it("lists threads with the page, scope and status asked", async () => {
    await manageMemoryThread.execute({ action: "list" } as never, NO_MESSAGE);
    await manageMemoryThread.execute(
      { action: "list", cursor: THREAD, limit: 5, scope: "family", status: "active" } as never, NO_MESSAGE,
    );

    expect(query.list.mock.calls).toEqual([
      [AUTH, { limit: 20 }],
      [AUTH, { cursor: THREAD, limit: 5, scope: "family", status: "active" }],
    ]);
  });

  it("searches threads by meaning with the limit the search had", async () => {
    await manageMemoryThread.execute({ action: "search", query: "ремонт кухни" } as never, NO_MESSAGE);
    await manageMemoryThread.execute({ action: "search", limit: 3, query: "переезд" } as never, NO_MESSAGE);

    expect(query.search.mock.calls).toEqual([[AUTH, "ремонт кухни", 10], [AUTH, "переезд", 3]]);
  });

  it("reads the history of one thread page by page", async () => {
    await manageMemoryThread.execute({ action: "read", threadRef: THREAD } as never, NO_MESSAGE);
    await manageMemoryThread.execute({ action: "read", cursor: ENTRY, limit: 5, threadRef: THREAD } as never, NO_MESSAGE);

    expect(query.read.mock.calls).toEqual([
      [AUTH, THREAD, { limit: 20 }],
      [AUTH, THREAD, { cursor: ENTRY, limit: 5 }],
    ]);
    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(lifecycle.reactivate).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "read" }, "threadRef"],
    [{ action: "search" }, "query"],
    [{ action: "list", threadRef: THREAD }, "threadRef"],
    [{ action: "read", cursor: THREAD, threadRef: THREAD }, "cursor"],
    [{ action: "list", cursor: ENTRY }, "cursor"],
  ])("refuses %j before any query", async (input, field) => {
    await expect(manageMemoryThread.execute(input as never, NO_MESSAGE)).rejects.toMatchObject({
      code: "AGENT_MEMORY_THREAD_INPUT_INVALID",
      message: expect.stringContaining(field),
    });
    for (const method of Object.values(query)) expect(method).not.toHaveBeenCalled();
  });

  it("gives a reading place no completion in its descriptor or schema", () => {
    const view = manageMemoryThreadPresentation(["list", "search", "read"]);
    const schema = view.inputSchema as unknown as ZodType;

    expect(schema.safeParse({ action: "read", threadRef: THREAD }).success).toBe(true);
    expect(schema.safeParse({ action: "complete", authority: "current_user_statement", sourceEntryRefs: [ENTRY], threadRef: THREAD }).success)
      .toBe(false);
    expect(view.description).not.toMatch(/\bcomplete\b|\breactivate\b/u);
  });

  it("names in a view's descriptor only the actions it has", () => {
    expect(manageMemoryThreadPresentation(["search", "read"]).description).not.toMatch(/\blist\b/iu);
  });

  it("lets an external group's list name only its own scope", () => {
    const schema = manageMemoryThreadPresentation(["list"], { listScopes: ["group"] }).inputSchema as unknown as ZodType;

    expect(schema.safeParse({ action: "list", scope: "group" }).success).toBe(true);
    expect(schema.safeParse({ action: "list", scope: "personal" }).success).toBe(false);
  });
});
