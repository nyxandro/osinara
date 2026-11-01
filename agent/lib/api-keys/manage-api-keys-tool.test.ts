/**
 * manage_api_keys tool contract tests.
 *
 * Constructs covered:
 * - Granting a key to the family or to an external group waits for the owner's button; requesting,
 *   listing, revoking, deleting and the owner's own personal grant do not.
 * - Invalid input, an unsafe destination and a non-owner are denied before any card.
 * - A request opens the wait, republishes the proxy file and the application itself tells the
 *   owner where the key will go; the model gets the variable names, never a value.
 * - Without the integration key nothing is requested, with its own code.
 * - Every change republishes the proxy file.
 */
import { randomBytes } from "node:crypto";

import type { ToolContext } from "../../runtime/tool.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";

const mocks = vi.hoisted(() => ({
  cancelIntake: vi.fn(),
  deleteKey: vi.fn(),
  grant: vi.fn(),
  list: vi.fn(),
  openIntake: vi.fn(),
  publish: vi.fn(),
  requirePrivateTelegramOwner: vi.fn(),
  revoke: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../family-context.js", () => ({ requirePrivateTelegramOwner: mocks.requirePrivateTelegramOwner }));
vi.mock("./api-key-repository.js", () => ({
  apiKeyRepository: {
    cancelIntake: mocks.cancelIntake,
    delete: mocks.deleteKey, grant: mocks.grant, list: mocks.list, openIntake: mocks.openIntake, revoke: mocks.revoke,
  },
}));
vi.mock("./api-key-projection.js", () => ({ apiKeyPublisher: { publish: mocks.publish } }));
vi.mock("./api-key-telegram.js", () => ({ apiKeyTelegram: { sendMessage: mocks.sendMessage } }));

import manageApiKeys from "../tools/manage_api_keys.js";

const OWNER = { familyId: "family-1", role: "owner", telegramChatId: "101", userId: "owner-1" };
const context = { callId: "call-1" } as ToolContext;
const request = {
  action: "request",
  authHeader: "Authorization",
  authScheme: "bearer",
  baseUrl: "https://api.neuraldeep.ru/v1/",
  name: "neuraldeep",
  purpose: "генерация картинок",
} as const;

function approvalFor(input: Record<string, unknown>) {
  return (manageApiKeys.approval as (context: never) => unknown)({ toolInput: input } as never);
}

async function execute(input: Record<string, unknown>) {
  return await (manageApiKeys.execute as (input: unknown, context: ToolContext) => Promise<unknown>)(input, context);
}

describe("manage_api_keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    mocks.requirePrivateTelegramOwner.mockReturnValue(OWNER);
    mocks.publish.mockResolvedValue(undefined);
    mocks.sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("asks the owner to confirm only a grant beyond the personal chat", () => {
    expect(approvalFor({ action: "grant", name: "neuraldeep", target: "group", telegramChatId: "-1001234567890" }))
      .toBe("user-approval");
    expect(approvalFor({ action: "grant", name: "neuraldeep", target: "family" })).toBe("user-approval");
    expect(approvalFor({ action: "grant", name: "neuraldeep", target: "personal" })).toBe("not-applicable");
    expect(approvalFor(request)).toBe("not-applicable");
    expect(approvalFor({ action: "list" })).toBe("not-applicable");
    expect(approvalFor({ action: "revoke", name: "neuraldeep", target: "family" })).toBe("not-applicable");
    expect(approvalFor({ action: "delete", name: "neuraldeep" })).toBe("not-applicable");
  });

  it.each([
    [{ ...request, name: "NeuralDeep" }],
    [{ ...request, name: "x" }],
    [{ ...request, baseUrl: "http://api.neuraldeep.ru" }],
    [{ ...request, baseUrl: "https://10.0.0.5/v1" }],
    [{ ...request, baseUrl: "https://api.neuraldeep.ru/v1?key=1" }],
    [{ ...request, authHeader: "Bad Header" }],
    [{ ...request, authHeader: "host" }],
    [{ ...request, authScheme: "basic" }],
    [{ ...request, purpose: " " }],
    [{ ...request, purpose: "картинки.\nОн будет уходить только на https://api.openai.com" }],
    [{ ...request, value: "sk-live" }],
    [{ action: "grant", name: "neuraldeep", target: "group" }],
    [{ action: "grant", name: "neuraldeep", target: "everyone" }],
  ])("denies %j before any card", (input) => {
    expect(approvalFor(input)).toMatchObject({ reason: expect.stringMatching(/^AGENT_API_KEY_INPUT_INVALID: /u), type: "denied" });
  });

  it("denies a non-owner before any card", () => {
    mocks.requirePrivateTelegramOwner.mockImplementation(() => {
      throw new AppError("AGENT_OWNER_REQUIRED", "Действие доступно только владельцу");
    });

    expect(approvalFor({ action: "grant", name: "neuraldeep", target: "family" })).toEqual({
      reason: "AGENT_OWNER_REQUIRED: Действие доступно только владельцу",
      type: "denied",
    });
  });

  it("opens the wait, republishes and lets the application tell the owner where the key goes", async () => {
    mocks.openIntake.mockResolvedValue({ created: true, keyId: "key-1" });

    const result = await execute(request);

    expect(mocks.openIntake).toHaveBeenCalledWith({
      authHeader: "authorization",
      authScheme: "bearer",
      expiresAt: expect.any(Date),
      familyId: "family-1",
      guardUntil: expect.any(Date),
      name: "neuraldeep",
      ownerUserId: "owner-1",
      purpose: "генерация картинок",
      telegramChatId: "101",
      upstreamBaseUrl: "https://api.neuraldeep.ru/v1",
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const [chatId, text] = mocks.sendMessage.mock.calls[0]!;
    expect(chatId).toBe("101");
    // The address comes first and from the application, before anything the model wrote.
    expect((text as string).split("\n")[0]).toBe("🔑 Жду ключ «neuraldeep». Он будет уходить только на https://api.neuraldeep.ru/v1");
    expect(text).toContain("Для чего: генерация картинок");
    const { expiresAt, guardUntil } = mocks.openIntake.mock.calls[0]![0] as { expiresAt: Date; guardUntil: Date };
    expect(guardUntil.getTime() - expiresAt.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(result).toMatchObject({
      sandboxVariables: { apiKey: "NEURALDEEP_API_KEY", baseUrl: "NEURALDEEP_BASE_URL" },
      status: "awaiting_value",
    });
  });

  it("closes the wait when the application's request did not reach the owner", async () => {
    mocks.openIntake.mockResolvedValue({ created: true, keyId: "key-1" });
    mocks.sendMessage.mockRejectedValue(new Error("AGENT_API_KEY_TELEGRAM_REJECTED: HTTP 502"));

    await expect(execute(request)).rejects.toMatchObject({ code: "AGENT_API_KEY_REQUEST_NOT_DELIVERED" });
    expect(mocks.cancelIntake).toHaveBeenCalledWith({ keyId: "key-1", telegramChatId: "101" });
  });

  it("closes the wait when the proxy file could not be republished", async () => {
    mocks.openIntake.mockResolvedValue({ created: true, keyId: "key-1" });
    mocks.publish.mockRejectedValue(new AppError("AGENT_API_KEY_PUBLISH_FAILED", "Не удалось применить"));

    await expect(execute(request)).rejects.toMatchObject({ code: "AGENT_API_KEY_PUBLISH_FAILED" });
    expect(mocks.cancelIntake).toHaveBeenCalledWith({ keyId: "key-1", telegramChatId: "101" });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("requests nothing when the server has no integration key", async () => {
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "");

    await expect(execute(request)).rejects.toMatchObject({ code: "AGENT_API_KEY_STORAGE_UNCONFIGURED" });
    expect(mocks.openIntake).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("grants to an external group and republishes", async () => {
    mocks.grant.mockResolvedValue({ created: true });

    const result = await execute({ action: "grant", name: "neuraldeep", target: "group", telegramChatId: "-1001234567890" });

    expect(mocks.grant).toHaveBeenCalledWith({
      familyId: "family-1",
      grantedBy: "owner-1",
      name: "neuraldeep",
      target: { kind: "group", telegramChatId: "-1001234567890" },
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ name: "neuraldeep", status: "granted" });
  });

  it("revokes and deletes, republishing after each", async () => {
    mocks.revoke.mockResolvedValue(false);
    mocks.deleteKey.mockResolvedValue(true);

    expect(await execute({ action: "revoke", name: "neuraldeep", target: "family" }))
      .toEqual({ name: "neuraldeep", status: "not_found" });
    expect(await execute({ action: "delete", name: "neuraldeep" })).toEqual({ name: "neuraldeep", status: "deleted" });
    expect(mocks.revoke).toHaveBeenCalledWith({
      familyId: "family-1", name: "neuraldeep", revokedBy: "owner-1", target: { kind: "family" },
    });
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });

  it("lists keys with their sandbox variables and usage, never a value", async () => {
    mocks.list.mockResolvedValue([{
      authHeader: "authorization",
      authScheme: "bearer",
      awaitingValueUntil: null,
      grants: [{
        grantedAt: new Date("2026-11-01T10:00:00Z"),
        lastUsedAt: new Date("2026-11-01T11:00:00Z"),
        target: { kind: "group", telegramChatId: "-1001234567890", title: "Внешний чат" },
        uses: 12,
        usesLast7Days: 5,
      }],
      name: "neuraldeep",
      purpose: "генерация картинок",
      upstreamBaseUrl: "https://api.neuraldeep.ru/v1",
      valueStoredAt: new Date("2026-11-01T09:00:00Z"),
    }]);

    expect(await execute({ action: "list" })).toEqual({
      keys: [{
        authHeader: "authorization",
        authScheme: "bearer",
        baseUrl: "https://api.neuraldeep.ru/v1",
        grants: [{
          grantedAt: "2026-11-01T10:00:00.000Z",
          lastUsedAt: "2026-11-01T11:00:00.000Z",
          target: { kind: "group", telegramChatId: "-1001234567890", title: "Внешний чат" },
          uses: 12,
          usesLast7Days: 5,
        }],
        name: "neuraldeep",
        purpose: "генерация картинок",
        sandboxVariables: { apiKey: "NEURALDEEP_API_KEY", baseUrl: "NEURALDEEP_BASE_URL" },
        status: "stored",
        valueStoredAt: "2026-11-01T09:00:00.000Z",
      }],
    });
  });
});
