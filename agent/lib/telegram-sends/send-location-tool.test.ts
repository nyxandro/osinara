/**
 * The tool that sends a place or a point on the map.
 *
 * Constructs covered:
 * - With a title and an address it sends a venue, without them a bare location; in a group the
 *   message answers the one that addressed the agent, in its topic.
 * - The sent message enters the history as the same line the agent reads for a shared place.
 * - Invalid input stops before anything is sent; an unconfirmed send is reported as possibly
 *   delivered; a refusal forbids another attempt in the turn.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { createSendLocationTool } from "../tools/send_location.js";

const PRIVATE = { telegramChatId: "101", telegramChatType: "private" };
const FAMILY_GROUP = {
  groupId: "group-1",
  groupType: "family_private",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  telegramForumTopicId: "7",
  telegramMessageThreadId: "7",
  telegramReplyToMessageId: "41",
};

function context(attributes: Record<string, string>): ToolContext {
  return {
    callId: "call-location-1",
    session: {
      auth: {
        current: {
          attributes: { familyId: "family-1", role: "owner", ...attributes },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-location",
      turn: { id: "turn-location", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies(send = vi.fn().mockResolvedValue({ telegramMessageId: "93" })) {
  return { recordTimeline: vi.fn().mockResolvedValue(true), send };
}

async function execute(deps: ReturnType<typeof dependencies>, attributes: Record<string, string>, input: unknown) {
  return await createSendLocationTool(deps as never).execute(input as never, context(attributes)) as Record<string, unknown>;
}

const VENUE = { address: "ул. Ленина, 12", latitude: 52.424577, longitude: 37.608176, title: "Кофейня у парка" };

describe("send_location", () => {
  it("sends a place card in a group as a reply in the topic and records it like a shared place", async () => {
    const deps = dependencies();

    const result = await execute(deps, FAMILY_GROUP, VENUE);

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      body: { address: "ул. Ленина, 12", latitude: 52.424577, longitude: 37.608176, title: "Кофейня у парка" },
      method: "sendVenue",
      target: { chatId: "-1001", messageThreadId: 7, replyToMessageId: 41 },
    }));
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      contentText: "📍 Место «Кофейня у парка», ул. Ленина, 12 — 52.424577, 37.608176",
      telegramMessageId: "93",
    }));
    expect(result).toMatchObject({ delivered: true, sideEffectStatus: "completed", telegramMessageId: "93" });
  });

  it("sends a bare point without a title and an address", async () => {
    const deps = dependencies();

    await execute(deps, PRIVATE, { latitude: 55.75, longitude: 37.61 });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      body: { latitude: 55.75, longitude: 37.61 },
      method: "sendLocation",
      target: { chatId: "101" },
    }));
  });

  it.each([
    ["a title without an address", { latitude: 1, longitude: 2, title: "Кафе" }],
    ["a latitude past the pole", { latitude: 91, longitude: 2 }],
    ["a longitude past the date line", { latitude: 1, longitude: 181 }],
    ["an unknown field", { latitude: 1, live: true, longitude: 2 }],
  ])("refuses %s before sending anything", async (_name, input) => {
    const deps = dependencies();

    await expect(execute(deps, PRIVATE, input)).rejects.toMatchObject({
      contract: { category: "input", code: "AGENT_LOCATION_SEND_INPUT_INVALID", sideEffectStatus: "not_started" },
    });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed send as possibly delivered and a refusal as not sent", async () => {
    const unconfirmed = dependencies(vi.fn().mockRejectedValue(new AppError("AGENT_LOCATION_DELIVERY_AMBIGUOUS", "Не удалось подтвердить")));
    await expect(execute(unconfirmed, PRIVATE, VENUE)).rejects.toMatchObject({
      contract: { code: "AGENT_LOCATION_DELIVERY_AMBIGUOUS", retryable: false, sideEffectStatus: "unknown" },
    });

    const refused = dependencies(vi.fn().mockRejectedValue(new AppError("AGENT_LOCATION_DELIVERY_FAILED", "Telegram не принял место")));
    const failure = await execute(refused, PRIVATE, VENUE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelFacingError);
    expect(failure).toMatchObject({ contract: { retryable: false, sideEffectStatus: "not_started" } });
    expect(refused.recordTimeline).not.toHaveBeenCalled();
  });
});
