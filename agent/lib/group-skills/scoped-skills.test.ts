/**
 * Skills of a turn as the runtime resolves them (`agent/skills/scoped.ts`), service skills included.
 *
 * Constructs covered:
 * - The service skills follow the real tool surface of each kind of turn: the owner's live private
 *   chat, another member's, a scheduled run, a delegated child and a live external group. A child's
 *   reading views of schedules and memory (#457) bring no procedure of their changes.
 * - A guest (#471) gets no skill the owner turned off for them, built-in or their own, and a removed guest none.
 * - A guest gets the skills of the owner's library given to them (#474), read from the host family; their own skill
 *   of the same name wins, and nobody else's turn reads the host library on a guest's behalf.
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

function guestPolicy(overrides: Record<string, unknown>) {
  return {
    active: true,
    disabledSkills: new Set(),
    disabledTools: new Set(),
    grantedApiKeys: [],
    grantedSkills: new Set(),
    guestUserId: "user-1",
    hostFamilyId: "host-family",
    ...overrides,
  };
}

describe("scoped skills", () => {
  beforeEach(() => {
    loadWorking.mockReset();
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
    loadGuestAccessPolicy.mockResolvedValue(guestPolicy({ disabledSkills: new Set(["pdf", "my-notes"]) }));
    const names = Object.keys(await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never));

    expect(names).not.toContain("pdf");
    expect(names).not.toContain("my-notes");
    expect(names).toContain("docx");
    expect(names).toContain("trip-plan");

    loadGuestAccessPolicy.mockResolvedValue(guestPolicy({ active: false }));
    expect(await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never)).toEqual({});
  });

  it("gives a guest the owner's skills given to them, their own winning a shared name", async () => {
    const library: Record<string, Record<string, { description: string; name: string }>> = {
      "guest-family": { "trip-plan": { description: "guest's own", name: "trip-plan" } },
      "host-family": { "image-gen": { description: "owner's", name: "image-gen" }, "trip-plan": { description: "owner's", name: "trip-plan" } },
    };
    // As the repository does: a selection by names reads only those names.
    loadWorking.mockImplementation(async (familyId: string, selection: { names?: string[] }) => Object.fromEntries(
      Object.entries(library[familyId] ?? {}).filter(([name]) => selection.names === undefined || selection.names.includes(name)),
    ));
    loadGuestAccessPolicy.mockResolvedValue(guestPolicy({ grantedSkills: new Set(["image-gen", "trip-plan"]) }));

    const skills = await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never) as Record<string, { description: string }>;

    expect(skills["image-gen"]?.description).toBe("owner's");
    expect(skills["trip-plan"]?.description).toBe("guest's own");
    expect(loadWorking).toHaveBeenCalledWith("host-family", { names: ["image-gen"] });
  });

  it("reads no host library for a guest with nothing given, nor for a family member", async () => {
    loadGuestAccessPolicy.mockResolvedValue(guestPolicy({}));
    await resolveScopedSkills(turn({ ...PRIVATE, familyId: "guest-family", role: "member" }) as never);
    loadGuestAccessPolicy.mockResolvedValue(null);
    await resolveScopedSkills(turn({ ...PRIVATE, role: "member" }) as never);

    expect(loadWorking.mock.calls.map(([familyId]) => familyId)).not.toContain("host-family");
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
