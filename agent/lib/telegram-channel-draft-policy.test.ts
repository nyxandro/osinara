/**
 * Telegram channel draft-rate regression contract.
 *
 * Constructs covered:
 * - No "thinking" placeholder: a private chat shows "typing" from the turn's start, before the turn
 *   is prepared, and a draft only of the visible text (`telegram-answer-draft/`).
 * - The draft stops before any message of the turn goes out: the answer, a reaction, the failure.
 * - Scheduled Telegram delivery is reauthorized before send and confirmed before timeline persistence.
 * - Turn start never launches a second semantic pass over the conversation.
 * - Turn-bound memory sources survive HITL and release only at a terminal turn boundary.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TELEGRAM_CHANNEL_PATH = new URL("../channels/telegram.ts", import.meta.url);
async function readChannelSource() {
  return (await Promise.all([
    readFile(TELEGRAM_CHANNEL_PATH, "utf8"),
    readFile(new URL("./telegram-turn-preparation.ts", import.meta.url), "utf8"),
  ])).join("\n");
}

describe("Telegram channel draft policy", () => {
  it("shows typing from the turn's start and stops the draft before every message of the turn", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");
    const started = source.slice(source.indexOf('async "turn.started"'));
    const completed = source.slice(source.indexOf('async "message.completed"'), source.indexOf('async "turn.failed"'));
    const failed = source.slice(source.indexOf('async "turn.failed"'));

    expect(started.indexOf("startAnswerDraft(channel, ctx)")).toBeGreaterThan(-1);
    expect(started.indexOf("startAnswerDraft(channel, ctx)")).toBeLessThan(started.indexOf("await prepareTelegramTurn("));
    const stop = completed.indexOf("await answerDrafts.beforeMessage(ctx.session.turn.id)");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(completed.indexOf("setTelegramMessageReaction("));
    expect(stop).toBeLessThan(completed.indexOf("await deliverTelegramFinalOutput("));
    expect(failed.indexOf("await answerDrafts.close(ctx.session.turn.id)")).toBeGreaterThan(-1);
    expect(failed.indexOf("await answerDrafts.close(ctx.session.turn.id)")).toBeLessThan(failed.indexOf("await recordTelegramFailure("));
    expect(source).not.toContain("tg-thinking");
    expect(source).not.toContain('"message.appended"');
    expect(source).not.toContain('"action.result"');
  });

  it("records scheduled delivery confirmation before the group timeline", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");
    const authorization = source.indexOf("await agentScheduleDispatchRepository.authorizeDelivery(");
    const delivery = source.indexOf("await deliverTelegramFinalOutput(");
    const confirmation = source.indexOf("await agentScheduleDispatchRepository.completeDeliveredRun(");
    const timeline = source.indexOf("await telegramGroupJournalRepository.recordAgentResponse(");

    expect(authorization).toBeGreaterThan(-1);
    expect(delivery).toBeGreaterThan(authorization);
    expect(confirmation).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(confirmation);
    expect(source).not.toContain("agentScheduleDispatchRepository.completeRun(");
    expect(source).toContain("AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING");
  });

  it("does not create background extraction work at turn start", async () => {
    const source = await readChannelSource();

    expect(source).not.toContain("createTurnExtractionBatch");
  });

  it("retains turn-bound memory sources while HITL is parked", async () => {
    const source = await readChannelSource();
    const turnCompleted = source.slice(
      source.indexOf('async "turn.completed"'),
      source.indexOf('async "authorization.required"'),
    );
    const reviewCompletion = turnCompleted.indexOf("memoryReviewRepository.completeBatch(");
    const sourceRelease = turnCompleted.indexOf("await releaseMemoryTurnSources(ctx)");

    expect(source).toContain("await bindMemoryTurnSources(ctx)");
    expect(turnCompleted).toContain("if (!awaitingApproval) {");
    expect(reviewCompletion).toBeGreaterThan(-1);
    expect(sourceRelease).toBeGreaterThan(reviewCompletion);
  });
});
