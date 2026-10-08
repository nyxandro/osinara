/**
 * The stored turn rebuilt as production sent it, with only its memory block varied.
 *
 * Constructs covered:
 * - Production's own memory block put back gives production's system prompt byte for byte.
 * - Property: substituting the memory slot keeps every other block and its place; removing it
 *   removes that block alone; putting the original back returns the stored turn unchanged.
 * - A turn with no memory block, or with two, is refused rather than guessed at.
 * - The turn's own user-role blocks travel with its input, as the runtime appends them.
 * - `search_memories` is advertised as the turn's surface advertised it, in a private chat as in
 *   an external group, and is absent where the group's grants leave it out.
 * - A turn whose stored rights still name a tool removed since gets the search it had then.
 */
import fc from "fast-check";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
vi.mock("../../../agent/lib/tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability: vi.fn(),
  loadCurrentExternalGroupCapabilities,
}));
vi.mock("../../../agent/lib/group-skills/group-skill-repository.js", () => ({
  groupSkillPolicyRepository: { loadGroupSkillAllowlist: vi.fn(async () => []) },
}));

import { createOsinaraAgent } from "../../../agent/agent.js";
import searchMemories from "../../../agent/lib/tools/search_memories.js";
import {
  formatTurnMemoryContext,
  TURN_MEMORY_CLOSE_TAG,
  TURN_MEMORY_OPEN_TAG,
} from "../../../agent/lib/prompt/turn-memory-context.js";
import type { SessionAuth } from "../../../agent/runtime/context.js";
import { preparedSystemPrompt } from "../../../agent/runtime/prompt/system-prompt.js";
import { turnInputMessages } from "../../../agent/runtime/prompt/turn-instructions.js";
import type { PreparedTurn } from "../../../agent/runtime/turn/turn-types.js";
import { turnMessages, turnSearchTool, turnSystemPrompt, withMemoryBlock, type StoredTurn } from "./turn-prompt.js";

const MODE_BLOCK = "<current_conversation_environment>\n# Личный чат\n</current_conversation_environment>";
// The core rules name the markers in prose; such a block is an instruction, not the payload.
const PROSE_MENTION = `Записи приходят в блоке ${TURN_MEMORY_OPEN_TAG} … ${TURN_MEMORY_CLOSE_TAG} в конце хода.`;
const PRODUCTION_MEMORY = formatTurnMemoryContext("<retrieved_memory>[{\"memoryRef\":\"mem_a\"}]</retrieved_memory>");

function prepared(instructions: string[], extra: Partial<PreparedTurn> = {}): PreparedTurn {
  return { instructions, skillRoot: null, skills: [], userInstructions: [], ...extra };
}

describe("turnSystemPrompt", () => {
  it("gives production's system prompt back byte for byte when production's block is put back", () => {
    const stored = prepared([MODE_BLOCK, PROSE_MENTION, PRODUCTION_MEMORY], {
      skillRoot: "/workspace/skills",
      skills: [{ description: "Сводка расходов", name: "budget" }],
    });

    expect(turnSystemPrompt(stored, PRODUCTION_MEMORY))
      .toBe(preparedSystemPrompt(createOsinaraAgent().basePrompt, stored));
  });
});

describe("withMemoryBlock", () => {
  it("replaces the memory slot alone, wherever it stands", () => {
    // Anything but a payload: arbitrary text, and the prose that names the markers inline.
    const otherBlock = fc.oneof(fc.string({ minLength: 1 }), fc.constant(PROSE_MENTION), fc.constant(MODE_BLOCK));
    const turn = fc.tuple(fc.array(otherBlock, { maxLength: 6 }), fc.nat())
      .map(([others, at]) => {
        const slot = at % (others.length + 1);
        return { others, slot, stored: prepared([...others.slice(0, slot), PRODUCTION_MEMORY, ...others.slice(slot)]) };
      });
    const variant = fc.string().map((text) => formatTurnMemoryContext(text));

    fc.assert(fc.property(turn, variant, ({ others, slot, stored }, block) => {
      expect(withMemoryBlock(stored, PRODUCTION_MEMORY)).toEqual(stored);
      expect(withMemoryBlock(stored, null).instructions).toEqual(others);
      expect(withMemoryBlock(stored, block).instructions)
        .toEqual([...others.slice(0, slot), block, ...others.slice(slot)]);
    }), { examples: [[{ others: [], slot: 0, stored: prepared([PRODUCTION_MEMORY]) }, formatTurnMemoryContext("")]] });
  });

  it.each([
    ["no memory block at all", [MODE_BLOCK, PROSE_MENTION]],
    ["the memory service notice instead of records", [MODE_BLOCK, "AGENT_MEMORY_UNAVAILABLE: В этом ходу долговременная память недоступна."]],
    ["two memory blocks", [PRODUCTION_MEMORY, MODE_BLOCK, PRODUCTION_MEMORY]],
  ])("refuses a turn with %s", (_, instructions) => {
    expect(() => withMemoryBlock(prepared(instructions), null)).toThrowError(/AGENT_MEMORY_ANSWERS_MEMORY_SLOT_INVALID/u);
  });
});

describe("turnMessages", () => {
  it("puts the turn's user-role blocks with its input, as the runtime does", () => {
    const userInstructions: ModelMessage[] = [{ content: "<reaction_set>👍</reaction_set>", role: "user" }];
    const turn: StoredTurn = {
      auth: {} as SessionAuth, channel: { kind: "telegram" },
      input: { context: ["<telegram_context>{}</telegram_context>"], message: "что купить?" },
      prepared: prepared([PRODUCTION_MEMORY], { userInstructions }),
      sessionId: "session-1", startedAt: new Date("2026-10-01T10:00:00.000Z"), turnId: "turn_1",
    };
    const history: ModelMessage[] = [{ content: "привет", role: "user" }, { content: "привет!", role: "assistant" }];

    expect(turnMessages(turn, history)).toEqual([
      ...history,
      ...turnInputMessages({ context: turn.input.context, message: turn.input.message, userInstructions }),
    ]);
  });
});

describe("turnSearchTool", () => {
  function storedTurn(attributes: Record<string, unknown>): StoredTurn {
    return {
      auth: {
        current: {
          attributes: { telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101", ...attributes },
          authenticator: "telegram", principalId: "telegram:101", principalType: "user",
        },
        initiator: null,
      } as SessionAuth,
      channel: { kind: "telegram" },
      input: { context: [], message: "что я просил купить?" },
      prepared: prepared([PRODUCTION_MEMORY]),
      sessionId: "session-1", startedAt: new Date("2026-10-01T10:00:00.000Z"), turnId: "turn_1",
    };
  }
  const externalGroup = {
    familyId: "family-1", groupId: "group-1", groupType: "external", memoryScopes: ["group"],
    telegramChatType: "supergroup",
  };

  beforeEach(() => loadCurrentExternalGroupCapabilities.mockReset());

  it("advertises the product's own description in a private chat", async () => {
    const definition = await turnSearchTool(storedTurn({ memoryScopes: ["personal", "family"], telegramChatType: "private" }), []);

    expect(definition?.description).toBe(searchMemories.description);
  });

  it("offers the tool in an external group only where the group's grants include it", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember", "search_memories"]));
    const granted = await turnSearchTool(storedTurn({ ...externalGroup, toolAllowlist: ["remember", "search_memories"] }), []);
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember"]));
    const withheld = await turnSearchTool(storedTurn({ ...externalGroup, toolAllowlist: ["remember"] }), []);

    expect(granted?.description.length).toBeGreaterThan(0);
    expect(withheld).toBeNull();
  });

  it("offers the search to a turn whose stored grants still name the conflict tool removed in #340", async () => {
    // Four groups held that grant until migration 132; their turns from before it keep it in the
    // stored rights, and one unknown name voids a group's whole policy.
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["search_memories"]));

    const definition = await turnSearchTool(
      storedTurn({ ...externalGroup, toolAllowlist: ["manage_memory_conflict", "search_memories"] }), [],
    );

    expect(definition).not.toBeNull();
  });
});
