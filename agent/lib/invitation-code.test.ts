/**
 * Family invitation code tests.
 *
 * Constructs covered:
 * - `createInvitationCode`: generates Telegram-compatible one-time tokens.
 * - `createInvitationCodeForOperation`: deterministically survives a step replay.
 * - `parseInvitationStartCommand`: accepts only an exact Telegram start command.
 */
import { describe, expect, it } from "vitest";

import {
  createInvitationCode,
  createInvitationCodeForOperation,
  parseInvitationStartCommand,
} from "./invitation-code.js";

describe("family invitation code", () => {
  it("generates a token accepted by the Telegram start command parser", () => {
    const invitation = createInvitationCode(new Date("2026-07-11T12:00:00.000Z"));

    expect(parseInvitationStartCommand(`/start ${invitation.code}`, "osinara_bot")).toBe(
      invitation.code,
    );
    expect(parseInvitationStartCommand(`/start@osinara_bot ${invitation.code}`, "osinara_bot")).toBe(
      invitation.code,
    );
  });

  it("rejects ordinary messages and commands containing extra text", () => {
    const invitation = createInvitationCode(new Date("2026-07-11T12:00:00.000Z"));

    expect(parseInvitationStartCommand(invitation.code, "osinara_bot")).toBeNull();
    expect(
      parseInvitationStartCommand(`/start ${invitation.code} extra`, "osinara_bot"),
    ).toBeNull();
    expect(parseInvitationStartCommand("/start short-token", "osinara_bot")).toBeNull();
    expect(parseInvitationStartCommand(` /start ${invitation.code}`, "osinara_bot")).toBeNull();
    expect(parseInvitationStartCommand(`/start ${invitation.code} `, "osinara_bot")).toBeNull();
    expect(
      parseInvitationStartCommand(`/start@other_bot ${invitation.code}`, "osinara_bot"),
    ).toBeNull();
  });

  it("derives the same high-entropy token for one durable tool operation", () => {
    const first = createInvitationCodeForOperation("call-1", "signing-secret");
    const replay = createInvitationCodeForOperation("call-1", "signing-secret");
    const other = createInvitationCodeForOperation("call-2", "signing-secret");

    expect(first).toEqual(replay);
    expect(first.code).toHaveLength(32);
    expect(other.code).not.toBe(first.code);
  });
});
