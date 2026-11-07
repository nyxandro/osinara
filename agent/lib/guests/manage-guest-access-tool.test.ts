/**
 * The owner's guests tool (#471), section `guests` of `owner_settings`.
 *
 * Constructs covered:
 * - The list asks no confirmation and returns the guest tool catalog and built-in skills to choose from.
 * - Invite, configure and revoke ask for confirmation; an invalid call reaches execution and is refused there.
 * - A guest link is a `guest` invitation delivered once to the owner's chat, never returned to the model.
 * - Configure refuses a tool the guest's chat cannot carry, before any change.
 * - The confirmation card names the guest and the full lists, and says what a link does.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  configureGuest: vi.fn(),
  listGuests: vi.fn(),
  revokeGuest: vi.fn(),
}));
const family = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  markInvitationDelivered: vi.fn(),
  markInvitationDeliveryStarted: vi.fn(),
}));
const deliverFamilyInvitation = vi.hoisted(() => vi.fn());

vi.mock("../family-context.js", () => ({
  requirePrivateTelegramOwner: vi.fn(() => ({ familyId: "family-1", role: "owner", telegramChatId: "101", userId: "owner-1" })),
}));
vi.mock("./guest-repository.js", () => ({ guestRepository: repository, loadGuestAccessPolicy: vi.fn() }));
vi.mock("../family-repository.js", () => ({ familyRepository: family }));
vi.mock("../telegram-delivery.js", () => ({ deliverFamilyInvitation }));

import manageGuestAccess from "../tools/manage_guest_access.js";
import { localizeTelegramInputRequest, type TelegramInputRequest } from "../telegram-interface.js";

const context = { abortSignal: new AbortController().signal, callId: "call-1" } as ToolContext;
const GUEST = { guestDisplayName: "Пётр", guestUserId: "00000000-0000-4000-8000-000000000007" };

function approvalFor(input: Record<string, unknown>) {
  return (manageGuestAccess.approval as (context: never) => unknown)({ toolInput: input } as never);
}

describe("manage_guest_access", () => {
  // The tool loads the guest tool catalog on call; in production the tool surface is already loaded, here the
  // first load of the whole surface can take seconds on a cold, CPU-capped run.
  beforeAll(async () => {
    await import("./guest-tool-surface.js");
  }, 60_000);

  beforeEach(() => {
    for (const fn of [...Object.values(repository), ...Object.values(family), deliverFamilyInvitation]) fn.mockReset();
  });

  it("lists guests without confirmation, with the names the owner can turn off", async () => {
    repository.listGuests.mockResolvedValue({ guests: [], openInvitations: [] });

    expect(approvalFor({ action: "list" })).toBe("not-applicable");
    const listed = await manageGuestAccess.execute({ action: "list" } as never, context) as Record<string, unknown>;

    expect(repository.listGuests).toHaveBeenCalledWith({ hostFamilyId: "family-1", ownerUserId: "owner-1" });
    expect(listed.toolCatalog).toEqual(expect.arrayContaining(["bash", "web_search", "remember", "manage_skill"]));
    expect(listed.toolCatalog).not.toContain("owner_settings");
    expect(listed.builtInSkills).toEqual(expect.arrayContaining(["pdf", "docx"]));
  });

  it("asks confirmation for every change and leaves a malformed call to execution", async () => {
    expect(approvalFor({ action: "invite" })).toBe("user-approval");
    expect(approvalFor({ action: "revoke", ...GUEST })).toBe("user-approval");
    expect(approvalFor({ action: "configure", ...GUEST, disabledSkills: [], disabledTools: ["bash"] })).toBe("user-approval");
    expect(approvalFor({ action: "revoke" })).toBe("not-applicable");
    await expect(manageGuestAccess.execute({ action: "revoke" } as never, context))
      .rejects.toMatchObject({ code: "AGENT_GUEST_ACCESS_INPUT_INVALID" });
    await expect(manageGuestAccess.execute({ action: "configure", ...GUEST, disabledTools: ["bash"] } as never, context))
      .rejects.toMatchObject({ code: "AGENT_GUEST_ACCESS_INPUT_INVALID" });
    expect(repository.revokeGuest).not.toHaveBeenCalled();
    expect(repository.configureGuest).not.toHaveBeenCalled();
  });

  it("sends a guest link once to the owner's chat and never returns it", async () => {
    family.createInvitation.mockResolvedValue({
      code: "secret-guest-code",
      deliveryRequired: true,
      expiresAt: "2026-11-08T10:00:00.000Z",
      invitationId: "00000000-0000-4000-8000-000000000001",
    });

    const result = await manageGuestAccess.execute({ action: "invite", guestUserId: "" } as never, context);

    expect(family.createInvitation).toHaveBeenCalledWith("family-1", "owner-1", "call-1", "guest");
    expect(deliverFamilyInvitation).toHaveBeenCalledWith(expect.objectContaining({ audience: "guest", chatId: "101", code: "secret-guest-code" }));
    expect(JSON.stringify(result)).not.toContain("secret-guest-code");
    expect(result).toEqual({ delivered: true, expiresAt: "2026-11-08T10:00:00.000Z" });
  });

  it("refuses a tool the guest's chat cannot carry before any change", async () => {
    await expect(manageGuestAccess.execute({ action: "configure", ...GUEST, disabledSkills: [], disabledTools: ["owner_settings"] } as never, context))
      .rejects.toMatchObject({ code: "AGENT_GUEST_TOOL_UNKNOWN" });
    expect(repository.configureGuest).not.toHaveBeenCalled();

    repository.configureGuest.mockResolvedValue({ disabledSkills: ["pdf"], disabledTools: ["bash"] });
    await manageGuestAccess.execute({ action: "configure", ...GUEST, disabledSkills: ["pdf"], disabledTools: ["bash"] } as never, context);
    expect(repository.configureGuest).toHaveBeenCalledWith(expect.objectContaining({
      ...GUEST,
      disabledSkills: ["pdf"],
      disabledTools: ["bash"],
      hostFamilyId: "family-1",
      ownerUserId: "owner-1",
    }));
  });

  it("shows the owner whom a change concerns and what a link does", () => {
    const card = (input: Record<string, unknown>) => localizeTelegramInputRequest({
      action: { input, toolName: "manage_guest_access" },
      kind: "tool-approval",
      options: [{ id: "approve", label: "approve" }, { id: "cancel", label: "cancel" }],
      prompt: "",
      requestId: "request-1",
    } as unknown as TelegramInputRequest).prompt;

    expect(card({ action: "invite" })).toContain("Кто первым её откроет, получит доступ к агенту в личном чате");
    const configure = card({ action: "configure", ...GUEST, disabledSkills: [], disabledTools: ["bash", "web_search"] });
    expect(configure).toContain("Гость: Пётр");
    expect(configure).toContain("Выключенные инструменты: bash, web_search");
    expect(configure).toContain("Выключенные скиллы: нет");
    expect(card({ action: "revoke", ...GUEST })).toContain("закрыть гостю доступ к агенту");
  });
});
