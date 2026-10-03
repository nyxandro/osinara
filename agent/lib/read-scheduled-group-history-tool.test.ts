/**
 * Run-bound scheduled group history reader tests.
 *
 * Constructs covered:
 * - The tool derives run identity only from verified scheduled auth.
 * - Opaque cursors are forwarded without model-selected group, dates, path, or limit.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readChunk = vi.hoisted(() => vi.fn());

vi.mock("./agent-schedules/scheduled-group-history-snapshot-repository.js", () => ({
  scheduledGroupHistorySnapshotRepository: { readChunk },
}));

import readScheduledGroupHistory from "./tools/read_scheduled_group_history.js";

function principal(attributes: Record<string, unknown>) {
  return {
    attributes,
    authenticator: "telegram" as const,
    principalId: "owner-1",
    principalType: "user" as const,
  };
}

function context(
  currentAttributes: Record<string, unknown> | null,
  initiatorAttributes: Record<string, unknown> | null = currentAttributes,
): ToolContext {
  return {
    session: {
      auth: {
        current: currentAttributes === null ? null : principal(currentAttributes),
        initiator: initiatorAttributes === null ? null : principal(initiatorAttributes),
      },
    },
  } as ToolContext;
}

function scheduledAttributes(overrides: Record<string, unknown> = {}) {
  return {
    groupId: "group-1",
    groupType: "external",
    memoryScopes: ["group"],
    scheduledGroupHistory: "enabled",
    scheduledRunId: "run-1",
    ...overrides,
  };
}

describe("read_scheduled_group_history", () => {
  beforeEach(() => readChunk.mockReset());

  it("reads the initial chunk for the verified scheduled run", async () => {
    readChunk.mockResolvedValue({ done: false, nextCursor: "cursor-2", timeline: "timeline" });

    await readScheduledGroupHistory.execute({}, context(scheduledAttributes()));

    expect(readChunk).toHaveBeenCalledWith({ cursor: null, groupId: "group-1", runId: "run-1" });
  });

  it("rejects an ordinary external turn before repository access", async () => {
    await expect(readScheduledGroupHistory.execute({}, context({
      groupId: "group-1",
      groupType: "external",
    }))).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects initiator-only scheduled history before repository access", async () => {
    await expect(readScheduledGroupHistory.execute(
      {},
      context(null, scheduledAttributes()),
    )).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });

    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects an ordinary current caller even when the initiator is scheduled", async () => {
    await expect(readScheduledGroupHistory.execute({}, context(
      { groupId: "group-1", groupType: "external", memoryScopes: ["group"] },
      scheduledAttributes(),
    ))).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });

    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects mismatched scheduled run identity before repository access", async () => {
    await expect(readScheduledGroupHistory.execute({}, context(
      scheduledAttributes({ scheduledRunId: "run-2" }),
      scheduledAttributes(),
    ))).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });

    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects mismatched scheduled group identity before repository access", async () => {
    await expect(readScheduledGroupHistory.execute({}, context(
      scheduledAttributes({ groupId: "group-2" }),
      scheduledAttributes(),
    ))).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });

    expect(readChunk).not.toHaveBeenCalled();
  });
});
