/**
 * Telegram application session route alias tests.
 *
 * Constructs covered:
 * - `registerTelegramDeliveredMessageRoutes` restores a verified topic from trusted auth.
 * - Private delivery IDs receive aliases for exact HITL callback authorization.
 * - Every chunk of a split group response receives a continuation route alias.
 * - Application aliases never rotate the stable continuation hook.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerRouteAlias = vi.hoisted(() => vi.fn());

vi.mock("./session-repository.js", () => ({
  sessionRepository: { registerRouteAlias },
}));

import { registerTelegramDeliveredMessageRoutes } from "./session-context.js";

describe("registerTelegramDeliveredMessageRoutes", () => {
  beforeEach(() => {
    registerRouteAlias.mockReset();
  });

  it("registers the outgoing bot anchor in the verified forum topic", async () => {
    const setContinuationToken = vi.fn();
    const channel = {
      setContinuationToken,
      state: {
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "279",
        messageThreadId: null,
      },
    };
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "session-1",
              telegramMessageThreadId: "278",
            },
          },
        },
      },
    };

    await registerTelegramDeliveredMessageRoutes(channel as never, ctx as never, ["279"]);

    expect(registerRouteAlias).toHaveBeenCalledWith("session-1", "-1001:278:279");
    expect(setContinuationToken).not.toHaveBeenCalled();
  });

  it("registers every delivered chunk without selecting a new continuation", async () => {
    const setContinuationToken = vi.fn();
    const channel = {
      setContinuationToken,
      state: {
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "302",
        messageThreadId: 278,
      },
    };
    const ctx = {
      session: {
        auth: { current: { attributes: { applicationSessionId: "session-1" } } },
      },
    };

    await registerTelegramDeliveredMessageRoutes(channel as never, ctx as never, ["301", "302"]);

    expect(registerRouteAlias).toHaveBeenNthCalledWith(1, "session-1", "-1001:278:301");
    expect(registerRouteAlias).toHaveBeenNthCalledWith(2, "session-1", "-1001:278:302");
    expect(setContinuationToken).not.toHaveBeenCalled();
  });

  it("registers a private delivery alias without selecting a new continuation", async () => {
    const setContinuationToken = vi.fn();
    const channel = {
      setContinuationToken,
      state: {
        chatId: "101",
        chatType: "private",
        conversationId: null,
        messageThreadId: null,
      },
    };
    const ctx = {
      session: {
        auth: { current: { attributes: { applicationSessionId: "session-1" } } },
      },
    };

    await registerTelegramDeliveredMessageRoutes(channel as never, ctx as never, ["88"]);

    expect(registerRouteAlias).toHaveBeenCalledWith("session-1", "101::88");
    expect(setContinuationToken).not.toHaveBeenCalled();
  });
});
