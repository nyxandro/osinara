/**
 * Safe two-phase software update proposal delivery tests.
 *
 * Constructs covered:
 * - Placeholder delivery has no buttons and precedes exact Telegram binding.
 * - Actionable buttons appear only after the proposal is pending in PostgreSQL.
 * - Ambiguous transport failure is persisted once and never retried.
 */
import { describe, expect, it, vi } from "vitest";

import { createSoftwareUpdateProposalDelivery } from "./proposal-delivery.js";

const input = {
  callbackToken: "callback-secret",
  owner: { familyId: "family-1", telegramUserId: "101", userId: "owner-1" },
  proposalId: "proposal-1",
  release: {
    manifest: {
      commitSha: "b".repeat(40),
      composeSha256: "c".repeat(64),
      images: {
        app: `ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}`,
        cliProxy: `ghcr.io/nyxandro/osinara-cli-proxy@sha256:${"a".repeat(64)}`,
        edge: `ghcr.io/nyxandro/osinara-edge@sha256:${"a".repeat(64)}`,
        sandboxEgressProxy:
          `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${"a".repeat(64)}`,
        sandboxRunner: `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${"a".repeat(64)}`,
        sandboxRuntime: `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${"a".repeat(64)}`,
      },
      schemaVersion: 1 as const,
      version: "0.2.0",
    },
    releaseUrl: "https://github.com/nyxandro/osinara/releases/tag/v0.2.0",
    version: "0.2.0",
  },
};

describe("software update proposal delivery", () => {
  it("binds the placeholder before revealing buttons", async () => {
    const events: string[] = [];
    const transport = {
      editProposal: vi.fn(async (request: Record<string, unknown>) => {
        events.push("edit");
        expect(request).toMatchObject({
          chatId: "101",
          messageId: "77",
          replyMarkup: {
            inline_keyboard: [[
              { callback_data: "su:a:callback-secret", text: "Обновить" },
              { callback_data: "su:d:callback-secret", text: "Не сейчас" },
            ]],
          },
        });
      }),
      sendPlaceholder: vi.fn(async (request: Record<string, unknown>) => {
        events.push("send");
        expect(request).not.toHaveProperty("replyMarkup");
        return { chatId: "101", chatType: "private" as const, messageId: "77" };
      }),
    };
    const repository = {
      bindPendingTelegramMessage: vi.fn(async () => {
        events.push("bind");
        return "bound" as const;
      }),
      markDeliveryFailure: vi.fn(),
    };
    const deliver = createSoftwareUpdateProposalDelivery({ repository, transport });

    await expect(deliver(input)).resolves.toBeUndefined();

    expect(events).toEqual(["send", "bind", "edit"]);
    expect(repository.markDeliveryFailure).not.toHaveBeenCalled();
  });

  it("records ambiguous edit delivery without retrying or rolling back the binding", async () => {
    const transportError = Object.assign(new Error("socket closed"), {
      delivery: "ambiguous" as const,
    });
    const transport = {
      editProposal: vi.fn().mockRejectedValue(transportError),
      sendPlaceholder: vi.fn().mockResolvedValue({
        chatId: "101",
        chatType: "private",
        messageId: "77",
      }),
    };
    const repository = {
      bindPendingTelegramMessage: vi.fn().mockResolvedValue("bound"),
      markDeliveryFailure: vi.fn().mockResolvedValue(undefined),
    };
    const deliver = createSoftwareUpdateProposalDelivery({ repository, transport });

    await expect(deliver(input)).resolves.toBeUndefined();

    expect(transport.editProposal).toHaveBeenCalledTimes(1);
    expect(repository.markDeliveryFailure).toHaveBeenCalledWith({
      code: "AGENT_SOFTWARE_UPDATE_DELIVERY_AMBIGUOUS",
      message: expect.stringContaining("не удалось однозначно определить"),
      proposalId: "proposal-1",
      status: "delivery_ambiguous",
    });
  });
});
