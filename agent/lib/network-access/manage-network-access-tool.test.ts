/**
 * manage_network_access tool contract tests.
 *
 * Constructs covered:
 * - Only a request for access asks the owner to confirm; listing and revoking do not.
 * - The owner check and the destination policy deny the call with its reason before the card is
 *   shown, so the model can explain or correct it instead of the turn ending.
 * - A grant is keyed on the call id, and every change republishes the proxy's grant file.
 * - The description carries the tunnel note: a home address is useless without a route.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";

const { grant, listActive, publish, requirePrivateTelegramOwner, revoke } = vi.hoisted(() => ({
  grant: vi.fn(),
  listActive: vi.fn(),
  publish: vi.fn(),
  requirePrivateTelegramOwner: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../family-context.js", () => ({ requirePrivateTelegramOwner }));
vi.mock("./network-access-repository.js", () => ({
  networkAccessRepository: { grant, listActive, revoke },
}));
vi.mock("./network-access-projection.js", () => ({ networkAccessPublisher: { publish } }));

import manageNetworkAccess from "../tools/manage_network_access.js";

const OWNER = { familyId: "family-1", telegramChatId: "101", userId: "owner-1" };
const context = { callId: "call-1" } as ToolContext;
const request = { action: "request", address: "100.91.171.16", port: 8123, purpose: "Home Assistant" } as const;

function approvalFor(input: Record<string, unknown>) {
  return (manageNetworkAccess.approval as (context: never) => unknown)({ toolInput: input } as never);
}

describe("manage_network_access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requirePrivateTelegramOwner.mockReturnValue(OWNER);
    publish.mockResolvedValue(undefined);
  });

  it("asks the owner to confirm a request and nothing else", () => {
    expect(approvalFor(request)).toBe("user-approval");
    expect(approvalFor({ action: "list" })).toBe("not-applicable");
    expect(approvalFor({ action: "revoke", address: "100.91.171.16", port: 8123 })).toBe("not-applicable");
  });

  it("denies a non-owner before any confirmation card", () => {
    requirePrivateTelegramOwner.mockImplementation(() => {
      throw new AppError("AGENT_OWNER_REQUIRED", "Действие доступно только владельцу");
    });

    expect(approvalFor(request)).toEqual({
      reason: "AGENT_OWNER_REQUIRED: Действие доступно только владельцу",
      type: "denied",
    });
  });

  it("does not turn an unexpected failure into a denial", () => {
    requirePrivateTelegramOwner.mockImplementation(() => {
      throw new Error("database connection lost");
    });

    expect(() => approvalFor(request)).toThrow("database connection lost");
  });

  it.each([
    [{ ...request, address: "homeassistant.local" }, "AGENT_NETWORK_ACCESS_INPUT_INVALID"],
    [{ ...request, port: 70_000 }, "AGENT_NETWORK_ACCESS_INPUT_INVALID"],
    [{ ...request, port: "8123" }, "AGENT_NETWORK_ACCESS_INPUT_INVALID"],
    [{ ...request, purpose: " " }, "AGENT_NETWORK_ACCESS_INPUT_INVALID"],
    [{ ...request, scope: "all" }, "AGENT_NETWORK_ACCESS_INPUT_INVALID"],
    [{ ...request, address: "127.0.0.1" }, "AGENT_NETWORK_ACCESS_DESTINATION_FORBIDDEN"],
    [{ ...request, address: "169.254.169.254", port: 80 }, "AGENT_NETWORK_ACCESS_DESTINATION_FORBIDDEN"],
  ])("denies %j before confirmation", (input, code) => {
    expect(approvalFor(input)).toEqual({ reason: expect.stringMatching(new RegExp(`^${code}: `, "u")), type: "denied" });
  });

  it("grants on the call id and republishes the proxy's list", async () => {
    grant.mockResolvedValue({
      active: true,
      created: true,
      grant: { address: "100.91.171.16", grantedAt: new Date("2026-10-20T12:00:00Z"), port: 8123, purpose: "Home Assistant" },
    });

    const result = await manageNetworkAccess.execute(request, context);

    expect(grant).toHaveBeenCalledWith({
      address: "100.91.171.16",
      familyId: "family-1",
      grantedBy: "owner-1",
      operationKey: "call-1",
      port: 8123,
      purpose: "Home Assistant",
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(result).toEqual({ address: "100.91.171.16", port: 8123, status: "granted" });
  });

  it("reports a destination that was already open", async () => {
    grant.mockResolvedValue({
      active: true,
      created: false,
      grant: { address: "100.91.171.16", grantedAt: new Date(), port: 8123, purpose: "Home Assistant" },
    });

    expect(await manageNetworkAccess.execute(request, context))
      .toEqual({ address: "100.91.171.16", port: 8123, status: "already_granted" });
  });

  it("lists the family's grants", async () => {
    listActive.mockResolvedValue([
      { address: "100.91.171.16", grantedAt: new Date("2026-10-20T12:00:00Z"), port: 8123, purpose: "Home Assistant" },
    ]);

    expect(await manageNetworkAccess.execute({ action: "list" }, context)).toEqual({
      grants: [{ address: "100.91.171.16", grantedAt: "2026-10-20T12:00:00.000Z", port: 8123, purpose: "Home Assistant" }],
    });
    expect(listActive).toHaveBeenCalledWith("family-1");
    expect(publish).not.toHaveBeenCalled();
  });

  it("revokes and republishes even when nothing was left to revoke", async () => {
    revoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const input = { action: "revoke", address: "100.91.171.16", port: 8123 } as const;

    expect(await manageNetworkAccess.execute(input, context)).toEqual({ status: "revoked" });
    expect(await manageNetworkAccess.execute(input, context)).toEqual({ status: "not_found" });
    expect(revoke).toHaveBeenCalledWith({ address: "100.91.171.16", familyId: "family-1", port: 8123, revokedBy: "owner-1" });
    // The second call is the retry after a failed publication: the proxy must still be told.
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("tells the model that a home address needs a tunnel first", () => {
    expect(manageNetworkAccess.description).toMatch(/Tailscale/u);
    expect(manageNetworkAccess.description).toContain("AGENT_SANDBOX_EGRESS_GRANT_REQUIRED");
  });
});
