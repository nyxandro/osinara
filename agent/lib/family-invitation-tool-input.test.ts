/**
 * Family invitation model-input contract tests.
 *
 * Constructs covered:
 * - Machine-visible required action enum in an object schema.
 * - Shared semantic validation before approval and execution.
 * - Explicit safe handling of MiniMax sibling-field materialization.
 * - Complete payload and bounded-correction guidance in the tool description.
 * - Durable fail-closed delivery when Telegram succeeds but completion persistence fails.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
  approveInvitation,
  createInvitation,
  deliverFamilyInvitation,
  markInvitationDelivered,
  markInvitationDeliveryStarted,
} = vi.hoisted(() => ({
  approveInvitation: vi.fn(),
  createInvitation: vi.fn(),
  deliverFamilyInvitation: vi.fn(),
  markInvitationDelivered: vi.fn(),
  markInvitationDeliveryStarted: vi.fn(),
}));

vi.mock("./family-context.js", () => ({
  requirePrivateTelegramOwner: vi.fn(() => ({
    familyId: "family-1",
    telegramChatId: "101",
    userId: "owner-1",
  })),
}));
vi.mock("./family-repository.js", () => ({
  familyRepository: {
    approveInvitation,
    createInvitation,
    markInvitationDelivered,
    markInvitationDeliveryStarted,
  },
}));
vi.mock("./telegram-delivery.js", () => ({ deliverFamilyInvitation }));

import manageFamilyInvitation from "./tools/manage_family_invitation.js";

const context = { callId: "call-1" } as ToolContext;

function approvalFor(input: Record<string, unknown>) {
  return (manageFamilyInvitation.approval as (context: never) => unknown)(
    { toolInput: input } as never,
  );
}

describe("manage_family_invitation model input", () => {
  beforeEach(() => {
    approveInvitation.mockReset();
    createInvitation.mockReset();
    deliverFamilyInvitation.mockReset();
    markInvitationDelivered.mockReset();
    markInvitationDeliveryStarted.mockReset();
    createInvitation.mockResolvedValue({
      deliveryRequired: false,
      expiresAt: new Date("2026-08-06T10:00:00.000Z"),
    });
  });

  it("publishes a required action enum in an object schema", () => {
    const schema = z.toJSONSchema(manageFamilyInvitation.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    expect(schema.properties.action?.enum).toEqual(["create", "approve"]);
  });

  it("rejects the same incomplete approval candidate before HITL and execution", async () => {
    const invalid = { action: "approve" };

    expect(() => approvalFor(invalid)).toThrowError(
      /AGENT_FAMILY_INVITATION_INPUT_INVALID.*candidateDisplayName/u,
    );
    await expect(manageFamilyInvitation.execute(invalid as never, context)).rejects.toThrowError(
      /AGENT_FAMILY_INVITATION_INPUT_INVALID.*candidateDisplayName/u,
    );
    expect(approveInvitation).not.toHaveBeenCalled();
  });

  it("does not send again when delivery completion fails and Eve replays the call", async () => {
    const invitation = {
      code: "invite-code",
      deliveryRequired: true,
      expiresAt: "2026-08-06T10:00:00.000Z",
      invitationId: "00000000-0000-4000-8000-000000000001",
    };
    createInvitation
      .mockResolvedValueOnce(invitation)
      .mockRejectedValueOnce(new Error(
        "AGENT_INVITATION_DELIVERY_AMBIGUOUS: Не удалось подтвердить отправку приглашения",
      ));
    markInvitationDelivered.mockRejectedValueOnce(new Error(
      "AGENT_INVITATION_DELIVERY_AMBIGUOUS: Не удалось подтвердить отправку приглашения",
    ));

    await expect(manageFamilyInvitation.execute({ action: "create" }, context))
      .rejects.toThrowError(/AGENT_INVITATION_DELIVERY_AMBIGUOUS/u);
    await expect(manageFamilyInvitation.execute({ action: "create" }, context))
      .rejects.toThrowError(/AGENT_INVITATION_DELIVERY_AMBIGUOUS/u);

    expect(markInvitationDeliveryStarted).toHaveBeenCalledTimes(1);
    expect(deliverFamilyInvitation).toHaveBeenCalledTimes(1);
    expect(markInvitationDeliveryStarted.mock.invocationCallOrder[0])
      .toBeLessThan(deliverFamilyInvitation.mock.invocationCallOrder[0]!);
    expect(deliverFamilyInvitation.mock.invocationCallOrder[0])
      .toBeLessThan(markInvitationDelivered.mock.invocationCallOrder[0]!);
  });

  it("ignores only known approve siblings when MiniMax materializes them for create", async () => {
    const input = {
      action: "create",
      candidateDisplayName: "Анна",
      candidateTelegramUserId: "123456789",
      invitationId: "00000000-0000-4000-8000-000000000001",
    } as const;

    expect(approvalFor(input)).toBe("user-approval");
    await expect(manageFamilyInvitation.execute(input, context)).resolves.toMatchObject({
      delivered: true,
    });
    expect(createInvitation).toHaveBeenCalledWith("family-1", "owner-1", "call-1");
    expect(approveInvitation).not.toHaveBeenCalled();
  });

  it("rejects unpublished fields before approval", () => {
    expect(() => approvalFor({ action: "create", familyId: "family-2" })).toThrowError(
      /AGENT_FAMILY_INVITATION_INPUT_INVALID.*familyId/u,
    );
  });

  it("documents every action payload and one bounded correction without defaults", () => {
    const description = manageFamilyInvitation.description;

    for (const fragment of [
      "action=create",
      "action=approve",
      "invitationId",
      "candidateTelegramUserId",
      "candidateDisplayName",
      "обязательн",
      "не более одного раза",
      "Не угадывай",
    ]) expect(description).toContain(fragment);
  });
});
