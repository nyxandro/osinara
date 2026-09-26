/**
 * Trusted Gmail approval-subject tests.
 *
 * Constructs covered:
 * - Approval metadata is loaded from the exact live Google profile for every message of the batch,
 *   in the requested order, by immutable message ID.
 * - Only headers and a short provider snippet are exposed; the body is not requested.
 * - Provider reads run with bounded concurrency; the first failure stops the batch and is logged once.
 * - A malformed or mismatched provider response fails closed before buttons are shown.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createGmailMessageApprovalLoader } from "./gmail-message-approval.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    payload: {
      headers: [
        { name: "From", value: "News <news@example.com>" },
        { name: "Subject", value: `Тема ${id}` },
        { name: "Date", value: "Sat, 29 Aug 2026 14:32:00 +0300" },
      ],
    },
    snippet: "Короткое начало",
    ...overrides,
  };
}

type FetchMetadata = (token: string, id: string, signal: AbortSignal) => Promise<unknown>;

function dependencies(fetchMetadata = vi.fn<FetchMetadata>(async (_token, id) => message(id))) {
  const profile = { displayName: "owner@example.com", profileRef: "profile-1" };
  return {
    fetchMetadata,
    resolveAuthorization: vi.fn().mockResolvedValue(auth),
    withAuthorizedExecution: vi.fn(async (_auth, operation) =>
      await operation("live-access-token", profile)
    ),
  };
}

describe("createGmailMessageApprovalLoader", () => {
  it("loads sender, subject, date and a bounded opening for every exact message", async () => {
    const deps = dependencies(vi.fn<FetchMetadata>(async (_token, id) => message(id, {
      internalDate: "1788013920000",
      snippet: `Короткое начало ${"письма ".repeat(80)}`,
    })));
    const load = createGmailMessageApprovalLoader(deps as never);

    const result = await load(["18f1a", "18f1b"], "profile-1", { session: {} } as never);

    expect(result).toEqual({
      messages: [
        {
          date: "Sat, 29 Aug 2026 14:32:00 +0300",
          from: "News <news@example.com>",
          id: "18f1a",
          snippet: expect.stringMatching(/^Короткое начало .+…$/u),
          subject: "Тема 18f1a",
        },
        expect.objectContaining({ id: "18f1b", subject: "Тема 18f1b" }),
      ],
      profileDisplayName: "owner@example.com",
      profileRef: "profile-1",
      scope: "personal",
    });
    expect(result.messages[0]!.snippet!.length).toBeLessThanOrEqual(240);
    expect(deps.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(deps.fetchMetadata).toHaveBeenCalledWith("live-access-token", "18f1a", expect.any(AbortSignal));
    expect(deps.withAuthorizedExecution).toHaveBeenCalledOnce();
  });

  it("keeps the requested order and at most ten provider reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 30 }, (_, index) => `message-${index}`);
    const deps = dependencies(vi.fn<FetchMetadata>(async (_token, id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Later IDs finish first, so ordering cannot come from completion order.
      await new Promise((resolve) => setTimeout(resolve, 30 - Number(id.split("-")[1])));
      inFlight -= 1;
      return message(id);
    }));
    const load = createGmailMessageApprovalLoader(deps as never);

    const result = await load(ids, "profile-1", { session: {} } as never);

    expect(result.messages.map((item) => item.id)).toEqual(ids);
    expect(peak).toBe(10);
  });

  it("stops the batch at the first provider failure", async () => {
    const failure = new Error("AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND: письмо не найдено");
    const signals: AbortSignal[] = [];
    const deps = dependencies(vi.fn<FetchMetadata>(async (_token, id, signal) => {
      signals.push(signal);
      if (id === "message-0") throw failure;
      return message(id);
    }));
    const load = createGmailMessageApprovalLoader(deps as never);

    await expect(load(
      Array.from({ length: 30 }, (_, index) => `message-${index}`),
      "profile-1",
      { session: {} } as never,
    )).rejects.toBe(failure);
    expect(deps.fetchMetadata.mock.calls.length).toBeLessThan(30);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("logs one diagnostic for a batch whose parallel reads all fail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new Error("Gmail metadata request failed with HTTP 503");
    const deps = dependencies(vi.fn<FetchMetadata>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const error = new AppError("AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE", "Gmail недоступен");
      error.cause = cause;
      throw error;
    }));
    const load = createGmailMessageApprovalLoader(deps as never);

    await expect(load(
      Array.from({ length: 10 }, (_, index) => `message-${index}`),
      "profile-1",
      { session: {} } as never,
    )).rejects.toThrowError(/AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE/u);
    expect(deps.fetchMetadata).toHaveBeenCalledTimes(10);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      causeMessage: "Gmail metadata request failed with HTTP 503",
      code: "AGENT_GMAIL_APPROVAL_SUBJECT_LOAD_FAILED",
      errorCode: "AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE",
      messageCount: 10,
    });
    log.mockRestore();
  });

  it("does not log a message that is simply gone, because the person is told to refresh", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies(vi.fn<FetchMetadata>(async () => {
      throw new AppError("AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND", "нет письма");
    }));
    const load = createGmailMessageApprovalLoader(deps as never);

    await expect(load(["gone"], "profile-1", { session: {} } as never))
      .rejects.toThrowError(/AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND/u);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("fails closed when Gmail returns another message", async () => {
    const load = createGmailMessageApprovalLoader(dependencies(vi.fn<FetchMetadata>(async () =>
      message("another-message")
    )) as never);

    await expect(load(["requested-message"], "profile-1", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH/u,
    );
  });

  it("fails closed when Gmail metadata is incomplete", async () => {
    const load = createGmailMessageApprovalLoader(dependencies(vi.fn<FetchMetadata>(async () =>
      ({ payload: { headers: "broken" } })
    )) as never);

    await expect(load(["requested-message"], "profile-1", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GMAIL_APPROVAL_SUBJECT_INVALID/u,
    );
  });

  it("fails before Gmail when the connected profile changed", async () => {
    const deps = dependencies();
    const load = createGmailMessageApprovalLoader(deps as never);

    await expect(load(["message-1"], "old-profile", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED/u,
    );
    expect(deps.fetchMetadata).not.toHaveBeenCalled();
  });
});
