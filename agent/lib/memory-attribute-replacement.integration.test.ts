/**
 * The replacement stop on the write paths the slot file does not reach.
 *
 * Constructs covered:
 * - A write that creates a thread and is stopped leaves neither the record nor the thread, and the
 *   reservation of the thread is released, so the same write with `replaces` goes through.
 * - Two current versions of one property (written before the slot lock existed) both have to be
 *   named; naming one retires nothing.
 * - The silent review is never shown the text of a sensitive version it would replace.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";

const UNIT = [1, ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 1 }, () => 0)];

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async (passages: readonly string[]) => passages.map(() => UNIT)),
}));

import { closeDatabase, database } from "./database.js";
import { MemoryAttributeReplacementRefusal } from "./memory-attribute-replacement-refusal.js";
import { supersedeMemoryAttributeSlot } from "./memory-attribute-slot.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("memory attribute replacement", () => {
  let fixture: Awaited<ReturnType<typeof createMainAgentMemoryFixture>>;

  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    fixture = await createMainAgentMemoryFixture();
  });

  afterAll(closeDatabase);

  function write(operationKey: string, input: Partial<CreateMemoryInput> & { content: string }) {
    return memoryRepository.create(fixture.auth, {
      confirmation: "user_confirmed",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "profile",
      operationKey,
      provenance: { sessionId: "replacement-session", turnId: operationKey },
      scope: "family",
      sensitivity: "normal",
      source: `turn:replacement-session:${operationKey}`,
      ...input,
    });
  }

  async function status(id: string): Promise<string> {
    const row = await database().query<{ claim_status: string }>(
      "SELECT claim_status FROM memory_items_all WHERE id = $1",
      [id],
    );
    return row.rows[0]!.claim_status;
  }

  it("leaves no record and no thread behind when a write that creates a thread is stopped", async () => {
    const current = await write("replacement-1", { attribute: "место работы", content: "Работает в «Ладоге»" });
    const withThread = (operationKey: string, replaces?: readonly string[]) => write(operationKey, {
      attribute: "место работы",
      content: "Перешла в «Ладожец» ведущим инженером",
      ...(replaces === undefined ? {} : { replaces }),
      thread: { action: "create", purpose: "Следить за сменой работы", role: "goal", title: "Новая работа" },
    });

    await expect(withThread("replacement-2"))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_ATTRIBUTE_REPLACEMENT_UNCONFIRMED" });

    const left = await database().query(
      `SELECT (SELECT count(*) FROM memory_items_all WHERE operation_key = 'replacement-2')::int AS records,
              (SELECT count(*) FROM memory_threads WHERE title = 'Новая работа')::int AS threads`,
    );
    expect(left.rows[0]).toEqual({ records: 0, threads: 0 });
    expect(await status(current.id)).toBe("active");

    const saved = await withThread("replacement-3", [current.memoryRef]);

    expect(saved.supersededRefs).toEqual([current.memoryRef]);
    expect(saved.thread).toMatchObject({ action: "created" });
  });

  it("needs every current version named, and retires nothing when one is left out", async () => {
    const first = await write("replacement-4", { attribute: "город", content: "Живёт в Казани" });
    const second = await write("replacement-5", { content: "Живёт в Твери" });
    // Two versions of one property, the way a race before the slot lock left them.
    await database().query("UPDATE memory_items_all SET attribute = 'город' WHERE id = $1", [second.id]);

    const refused = await write("replacement-6", {
      attribute: "город", content: "Переехала в Москву", replaces: [first.memoryRef],
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(MemoryAttributeReplacementRefusal);
    expect((refused as MemoryAttributeReplacementRefusal).current.map((version) => version.memoryRef))
      .toEqual([first.memoryRef, second.memoryRef]);
    expect([await status(first.id), await status(second.id)]).toEqual(["active", "active"]);
  });

  it("refuses a ref that is not a current version instead of keeping both as if replaced", async () => {
    // The neighbour stop shows records without a property too; named in replaces, such a record
    // used to stay current beside the new one while the model believed it was replaced.
    const unslotted = await write("replacement-7", { content: "Пьёт кофе с сахаром", kind: "preference" });

    await expect(write("replacement-8", {
      attribute: "кофе", content: "Пьёт кофе без сахара", kind: "preference", replaces: [unslotted.memoryRef],
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_ATTRIBUTE_REPLACEMENT_INVALID" });

    expect(await status(unslotted.id)).toBe("active");
    const stored = await database().query("SELECT 1 FROM memory_items_all WHERE operation_key = 'replacement-8'");
    expect(stored.rowCount).toBe(0);
  });

  it("withholds the text of a sensitive version from the silent review", async () => {
    const sensitive = await write("replacement-9", {
      attribute: "здоровье", content: "Диагноз: мигрень", sensitivity: "sensitive",
    });
    const fresh = await write("replacement-10", { content: "Новая запись о здоровье" });
    await database().query("UPDATE memory_items_all SET attribute = 'здоровье' WHERE id = $1", [fresh.id]);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const refused = await supersedeMemoryAttributeSlot(client, fresh.id, { replaces: [], revealSensitive: false })
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(MemoryAttributeReplacementRefusal);
      expect((refused as MemoryAttributeReplacementRefusal).current)
        .toEqual([{ content: "Текст скрыт: чувствительная запись.", memoryRef: sensitive.memoryRef }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
