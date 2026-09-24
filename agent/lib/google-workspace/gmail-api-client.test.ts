/**
 * Direct Gmail metadata boundary tests.
 *
 * Constructs covered:
 * - One exact message is requested by encoded ID with headers only, never its body.
 * - A missing message, a provider failure, an undecodable reply and a network failure each fail
 *   closed with a stable code and without the live token in diagnostics.
 * - A caller cancellation propagates as-is and is not logged as a provider failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGmailMessageMetadata } from "./gmail-api-client.js";

const TOKEN = "live-access-secret";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => { throw new Error("Expected the Gmail metadata read to fail"); },
    (caught: unknown) => caught as Error,
  );
}

describe("fetchGmailMessageMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests only the From, Subject and Date headers of the exact message", async () => {
    const payload = { id: "18f/1", payload: { headers: [] }, snippet: "Начало" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGmailMessageMetadata(TOKEN, "18f/1", new AbortController().signal))
      .resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const requested = new URL(url);
    expect(`${requested.origin}${requested.pathname}`)
      .toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/18f%2F1");
    expect(requested.searchParams.get("format")).toBe("metadata");
    expect(requested.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(init.method).toBe("GET");
  });

  it("reports a message that no longer exists so the person refreshes the list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));

    await expect(fetchGmailMessageMetadata(TOKEN, "gone", new AbortController().signal))
      .rejects.toThrowError(/AGENT_GMAIL_APPROVAL_MESSAGE_NOT_FOUND/u);
  });

  it.each([
    [400, "AGENT_GMAIL_APPROVAL_MESSAGE_ID_INVALID"],
    [401, "AGENT_GMAIL_APPROVAL_ACCESS_DENIED"],
    [403, "AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE"],
    [429, "AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE"],
    [500, "AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE"],
  ])("maps provider status %i to %s and leaves logging to the batch boundary", async (status, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = new Response(TOKEN, { status });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await rejection(fetchGmailMessageMetadata(TOKEN, "message-1", new AbortController().signal));

    expect(error.message).toMatch(new RegExp(`^${code}:`, "u"));
    expect(String((error.cause as Error).message)).toContain(String(status));
    expect(JSON.stringify(error.cause)).not.toContain(TOKEN);
    expect(response.bodyUsed || response.body?.locked).toBeTruthy();
    expect(log).not.toHaveBeenCalled();
  });

  it("fails closed when the reply cannot be decoded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(fetchGmailMessageMetadata(TOKEN, "message-1", new AbortController().signal))
      .rejects.toThrowError(/AGENT_GMAIL_APPROVAL_SUBJECT_INVALID/u);
  });

  it("fails closed when Gmail cannot be reached", async () => {
    const networkFailure = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkFailure));

    const error = await rejection(fetchGmailMessageMetadata(TOKEN, "message-1", new AbortController().signal));

    expect(error.message).toMatch(/^AGENT_GMAIL_APPROVAL_SUBJECT_UNAVAILABLE:/u);
    expect(error.cause).toBe(networkFailure);
  });

  it("propagates a caller cancellation without reporting a provider failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    const reason = new Error("sibling failed");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      controller.abort(reason);
      throw new DOMException("aborted", "AbortError");
    }));

    await expect(fetchGmailMessageMetadata(TOKEN, "message-1", controller.signal)).rejects.toBe(reason);
    expect(log).not.toHaveBeenCalled();
  });
});
