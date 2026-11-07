/**
 * Skills of a turn as the runtime resolves them (`agent/skills/scoped.ts`), service skills included.
 *
 * Constructs covered:
 * - The service skills follow the real tool surface of each kind of turn: the owner's live private
 *   chat, another member's, a scheduled run, a delegated child and a live external group. A child's
 *   reading views of schedules and memory (#457) bring no procedure of their changes.
 * - A guest (#471) gets no skill the owner turned off for them, built-in or their own, and a removed guest none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const loadGroupSkillAllowlist = vi.hoisted(() => vi.fn());
const loadWorking = vi.hoisted(() => vi.fn());
const loadGuestAccessPolicy = vi.hoisted(() => vi.fn());

vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability: vi.fn(),
  loadCurrentExternalGroupCapabilities,
}));
vi.mock("./group-skill-repository.js", () => ({
  groupSkillPolicyRepository: { loadGroupSkillAllowlist },
}));
vi.mock("../family-skills/family-skill-repository.js", () => ({
  familySkillRepository: { loadWorking },
}));
vi.mock("../guests/guest-repository.js", () => ({ loadGuestAccessPolicy }));

import { resolveScopedSkills } from "../../skills/scoped.js";

const SERVICE = ["delegation", "group-admin", "group-reminders", "schedules", "skill-manager", "voice-replies"];

function turn(attributes: Record<string, unknown>, channel: "subagent" | "telegram" = "telegram") {
  const principal = {
    attributes: { familyId: "family-1", telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101", ...attributes },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { channel: { kind: channel }, messages: [], session: { auth: { current: principal, initiator: principal }, id: "session-1" } };
}

async function serviceSkills(context: ReturnType<typeof turn>): Promise<string[]> {
  return Object.keys(await resolveScopedSkills(context as never)).filter((name) => SERVICE.includes(name)).sort();
}

const PRIVATE = { memoryScopes: ["personal", "family"], role: "owner", telegramChatType: "private" };

describe("scoped skills", () => {
  beforeEach(() => {
    loadWorking.mockResolvedValue({});
    loadGuestAccessPolicy.mockResolvedValue(null);
    loadGroupSkillAllowlist.mockResolvedValue(new Set());
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember", "send_voice_message", "manage_memory.edit"]));
  });

  it("gives a live private chat every procedure of its tools", async () => {
    expect(await serviceSkills(turn(PRIVATE)))
      .toEqual(["delegation", "group-admin", "schedules", "skill-manager", "voice-replies"]);
  });

  it("gives another member's private chat no procedure of the owner's administration", async () => {
    expect(await serviceSkills(turn({ ...PRIVATE, role: "member" })))
      .toEqual(["delegation", "schedules", "skill-manager", "voice-replies"]);
  });

  it("gives a guest no skill the owner turned off, built-in or their own", async () => {
    loadWorking.mockResolvedValue({ "my-notes": { description: "guest's own", name: "my-notes" }, "trip-plan": { description: "guest's own", name: "trip-plan" } });
    loadGuestAccessPolicy.mockResolvedValue({
      active: true,
      disabledSkills: new Set(["pdf", "my-notes"]),
      disabledTools: new Set(),
      guestUserId: "user-1",
    });
    const names = Object.keys(await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never));

    expect(names).not.toContain("pdf");
    expect(names).not.toContain("my-notes");
    expect(names).toContain("docx");
    expect(names).toContain("trip-plan");

    loadGuestAccessPolicy.mockResolvedValue({ active: false, disabledSkills: new Set(), disabledTools: new Set(), guestUserId: "user-1" });
    expect(await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never)).toEqual({});
  });

  it("gives a scheduled run only the procedures of the tools it keeps", async () => {
    const skills = await serviceSkills(turn({ ...PRIVATE, scheduledRunId: "run-1" }));

    expect(skills).toContain("schedules");
    expect(skills).not.toContain("voice-replies");
    expect(skills).not.toContain("skill-manager");
  });

  it("gives a delegated child no procedure of a tool it does not have", async () => {
    const skills = await serviceSkills(turn(PRIVATE, "subagent"));

    for (const name of ["delegation", "group-admin", "schedules", "skill-manager", "voice-replies"]) {
      expect(skills).not.toContain(name);
    }
  });

  it("gives an external group its own procedures and none of the family's", async () => {
    const skills = await serviceSkills(turn({
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      skillAllowlist: [],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember", "send_voice_message", "manage_memory.edit"],
    }));

    expect(skills).toEqual(["delegation", "group-reminders", "voice-replies"]);
  });
});
