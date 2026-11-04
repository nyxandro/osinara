/**
 * The tool that sends a contact card.
 *
 * Constructs covered:
 * - The phone number is cleaned of spaces, brackets and dashes and keeps its own country prefix; in a
 *   group the card answers the message that addressed the agent, in its topic.
 * - The sent card enters the history as the same line the agent reads for a shared contact.
 * - Invalid input stops before anything is sent; an unconfirmed send is reported as possibly
 *   delivered; a refusal forbids another attempt in the turn.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { createSendContactTool } from "../tools/send_contact.js";

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
    callId: "call-contact-1",
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
      id: "wrun-contact",
      turn: { id: "turn-contact", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies(send = vi.fn().mockResolvedValue({ telegramMessageId: "95" })) {
  return { recordTimeline: vi.fn().mockResolvedValue(true), send };
}

async function execute(deps: ReturnType<typeof dependencies>, attributes: Record<string, string>, input: unknown) {
  return await createSendContactTool(deps as never).execute(input as never, context(attributes)) as Record<string, unknown>;
}

describe("send_contact", () => {
  it("sends a cleaned number in a group as a reply in the topic and records it like a shared contact", async () => {
    const deps = dependencies();

    const result = await execute(deps, FAMILY_GROUP, {
      firstName: "Иван",
      lastName: "сантехник",
      phone: "+7 (999) 123-45-67",
    });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      body: { first_name: "Иван", last_name: "сантехник", phone_number: "+79991234567" },
      method: "sendContact",
      target: { chatId: "-1001", messageThreadId: 7, replyToMessageId: 41 },
    }));
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      contentText: "👤 Контакт: Иван сантехник, +79991234567",
      telegramMessageId: "95",
    }));
    expect(result).toMatchObject({ delivered: true, sideEffectStatus: "completed", telegramMessageId: "95" });
  });

  it("keeps a number without a country prefix as written and a short service number", async () => {
    const deps = dependencies();

    await execute(deps, PRIVATE, { firstName: "Мама", phone: "8 916 000-11-22" });
    await execute(deps, PRIVATE, { firstName: "Экстренная служба", phone: "112" });

    expect(deps.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { first_name: "Мама", phone_number: "89160001122" },
      target: { chatId: "101" },
    }));
    expect(deps.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: { first_name: "Экстренная служба", phone_number: "112" },
    }));
  });

  it.each([
    ["two digits", { firstName: "Иван", phone: "12" }],
    ["sixteen digits", { firstName: "Иван", phone: "+1234567890123456" }],
    ["letters in the number", { firstName: "Иван", phone: "+7 999 CALL-NOW" }],
    ["a plus in the middle", { firstName: "Иван", phone: "7+9991234567" }],
    ["an empty name", { firstName: "  ", phone: "+79991234567" }],
    ["an unknown field", { email: "a@example.com", firstName: "Иван", phone: "+79991234567" }],
  ])("refuses %s before sending anything", async (_name, input) => {
    const deps = dependencies();

    await expect(execute(deps, PRIVATE, input)).rejects.toMatchObject({
      contract: { category: "input", code: "AGENT_CONTACT_SEND_INPUT_INVALID", sideEffectStatus: "not_started" },
    });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed send as possibly delivered and a refusal as not sent", async () => {
    const input = { firstName: "Иван", phone: "+79991234567" };
    const unconfirmed = dependencies(vi.fn().mockRejectedValue(new AppError("AGENT_CONTACT_DELIVERY_AMBIGUOUS", "Не удалось подтвердить")));
    await expect(execute(unconfirmed, PRIVATE, input)).rejects.toMatchObject({
      contract: { code: "AGENT_CONTACT_DELIVERY_AMBIGUOUS", retryable: false, sideEffectStatus: "unknown" },
    });

    const refused = dependencies(vi.fn().mockRejectedValue(new AppError("AGENT_CONTACT_DELIVERY_FAILED", "Telegram не принял контакт")));
    const failure = await execute(refused, PRIVATE, input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelFacingError);
    expect(failure).toMatchObject({ contract: { retryable: false, sideEffectStatus: "not_started" } });
    expect(refused.recordTimeline).not.toHaveBeenCalled();
  });
});
