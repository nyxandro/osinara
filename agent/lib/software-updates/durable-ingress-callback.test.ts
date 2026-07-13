/**
 * Software update durable-ingress routing tests.
 *
 * Constructs covered:
 * - Application update callbacks are consumed before the Eve dispatch start marker.
 * - Consumed callbacks complete their ingress item without creating an Eve session.
 */
import type { TelegramDrainContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "../telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "../telegram-durable-ingress.js";

describe("software update callback durable ingress", () => {
  it("completes a handled callback without beginDispatch or native Eve dispatch", async () => {
    const claim = {
      attemptCount: 1,
      deliveryContinuationKey: "101::",
      ingressContinuationKey: "101::",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: "123e4567-e89b-42d3-a456-426614174000",
      payload: {
        callback_query: {
          data: "su:a:callback-secret",
          from: { first_name: "Анна", id: 101, is_bot: false },
          id: "query-1",
          message: {
            chat: { id: 101, type: "private" },
            date: 1_700_000_000,
            message_id: 77,
            text: "Доступно обновление",
          },
        },
        update_id: 7001,
      },
      queueId: "123e4567-e89b-42d3-a456-426614174001",
      transcript: null,
      updateId: "7001",
      voice: null,
    };
    const repository = {
      acceptMedia: vi.fn(),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn(),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
      complete: vi.fn(),
      completeWithSession: vi.fn(),
      enqueue: vi.fn(),
      fail: vi.fn(),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      renewLease: vi.fn(),
      saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository;
    const handleSoftwareUpdateCallback = vi.fn().mockResolvedValue(true);
    const dispatch = vi.fn();
    let backgroundTask: Promise<unknown> | undefined;
    const ingress = createTelegramDurableIngress({
      acceptMedia: vi.fn(),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback,
      leaseMilliseconds: 60_000,
      repository,
      transcribeVoice: vi.fn(),
    });

    await ingress.drain({
      dispatch,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramDrainContext);
    await backgroundTask;

    expect(handleSoftwareUpdateCallback).toHaveBeenCalledWith(
      expect.objectContaining({ data: "su:a:callback-secret", id: "query-1" }),
    );
    expect(repository.complete).toHaveBeenCalledWith("7001", claim.leaseToken);
    expect(repository.beginDispatch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
