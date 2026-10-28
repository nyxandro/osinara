/**
 * Credentialed Google Workspace execution boundary tests.
 *
 * Constructs covered:
 * - Reads and ordinary changes run at once; only a command that opens the user's data to other
 *   people waits for the owner's button, and is denied where no button can be shown.
 * - A delegated child and a scenario run (isolated or a wake-up in the conversation) only read.
 * - Execution rechecks current access/profile and preserves scope isolation.
 * - Exact argv transport treats shell metacharacters as ordinary data.
 */
import { describe, expect, it, vi } from "vitest";

import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import executeGoogleWorkspace, {
  createGoogleWorkspaceExecutor,
} from "../tools/execute_google_workspace.js";

const personalAuth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};
const familyAuth = {
  ...personalAuth,
  scope: "family" as const,
  workspaceId: "00000000-0000-4000-8000-000000000004",
};

const PERSON = {
  attributes: { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" },
  authenticator: "telegram",
  principalId: "user-1",
  principalType: "user",
};
const SCENARIO = { ...PERSON, attributes: { ...PERSON.attributes, scheduledRunId: "00000000-0000-4000-8000-000000000010" } };
const WAKEUP = { ...PERSON, attributes: { ...PERSON.attributes, conversationScheduleRunId: "00000000-0000-4000-8000-000000000011" } };
// The presser's fresh auth after a button press: no scenario attribute of its own.
const PRESSER = { ...PERSON, attributes: { ...PERSON.attributes, telegramApprovalContinuation: "true" } };

function turnOf(kind: string, current: object, initiator: object | null = null, extra: object = {}) {
  return { session: { auth: { current, initiator }, turn: { id: "turn-1", kind, sequence: 1 }, ...extra } } as never;
}

const PRIVATE_TURN = turnOf("conversation", PERSON);
const FAMILY_GROUP_TURN = turnOf("conversation", {
  ...PERSON,
  attributes: {
    groupId: "group-1", groupType: "family_private",
    telegramChatId: "-1001", telegramChatType: "supergroup", telegramUserId: "101",
  },
});
const SCHEDULED_TURN = turnOf("scheduled", SCENARIO);
const WAKEUP_TURN = turnOf("wakeup", WAKEUP);
// A continuation keeps the kind of the turn it resumes; the person who pressed the button acts in it.
const SCHEDULED_CONTINUATION_TURN = turnOf("scheduled", PRESSER, SCENARIO);
const WAKEUP_CONTINUATION_TURN = turnOf("wakeup", PRESSER);
// Each lock holds on its own: the auth marks a scenario even where the turn kind does not.
const SCENARIO_INITIATOR_ONLY_TURN = turnOf("conversation", PERSON, SCENARIO);
const SUBAGENT_TURN = turnOf("subagent", PERSON, null, {
  parent: { callId: "call-agent", rootSessionId: "root", sessionId: "root", turn: { id: "turn-0", kind: "conversation", sequence: 1 } },
});

function approval(argv: string[], turn: never = PRIVATE_TURN) {
  return (executeGoogleWorkspace as unknown as {
    approval: (context: { session: unknown; toolInput?: { argv: string[] } }) => unknown;
  }).approval({ session: (turn as { session: unknown }).session, toolInput: { argv } });
}

function toolDescription(): string {
  return (executeGoogleWorkspace as unknown as { description: string }).description;
}

async function executeRaw(input: { argv: string[] }, turn: unknown = PRIVATE_TURN) {
  return await (executeGoogleWorkspace as unknown as {
    execute: (input: { argv: string[] }, ctx: unknown) => Promise<unknown>;
  }).execute(input, turn);
}

function dependencies(auth: GoogleIntegrationAuthorization = personalAuth) {
  const profile = { displayName: "owner@example.com", profileRef: "profile-1" };
  return {
    resolveAuthorization: vi.fn().mockResolvedValue(auth),
    run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "{}" }),
    withAuthorizedExecution: vi.fn(async <T>(
      _auth: GoogleIntegrationAuthorization,
      operation: (accessToken: string, currentProfile: typeof profile) => Promise<T>,
    ): Promise<T> => await operation("live-access-token", profile)),
  };
}

const AUTO_FORWARDING = [
  "gmail", "users", "settings", "updateAutoForwarding",
  "--params", '{"userId":"me"}',
  "--json", '{"enabled":true,"emailAddress":"someone@example.com","disposition":"leaveInInbox"}',
];
const DRIVE_SHARING = [
  "drive", "permissions", "create",
  "--params", '{"fileId":"file-1"}', "--json", '{"role":"reader","type":"anyone"}',
];
const DOCUMENT_PUBLISHING = [
  "drive", "revisions", "update",
  "--params", '{"fileId":"file-1","revisionId":"head"}', "--json", '{"published":true,"publishAuto":true}',
];
const CALENDAR_SHARING = [
  "calendar", "acl", "insert",
  "--params", '{"calendarId":"primary"}', "--json", '{"role":"reader","scope":{"type":"user","value":"x@example.com"}}',
];

describe("execute_google_workspace approval", () => {
  it("runs reads and ordinary changes at once, in a private chat and in a family group", () => {
    for (const turn of [PRIVATE_TURN, FAMILY_GROUP_TURN]) {
      expect(approval(["calendar", "events", "list", "--params", "{}"], turn)).toBe("not-applicable");
      expect(approval(["calendar", "events", "insert", "--json", "{}"], turn)).toBe("not-applicable");
      expect(approval(["calendar", "events", "delete", "--params", '{"calendarId":"primary","eventId":"e"}'], turn))
        .toBe("not-applicable");
      expect(approval(["gmail", "+send", "--to", "a@example.com", "--subject", "Привет", "--body", "Текст"], turn))
        .toBe("not-applicable");
      expect(approval(["drive", "permissions", "delete", "--params", '{"fileId":"f","permissionId":"p"}'], turn))
        .toBe("not-applicable");
    }
  });

  it("asks the owner before a command opens the user's data to other people", () => {
    for (const argv of [AUTO_FORWARDING, DRIVE_SHARING, DOCUMENT_PUBLISHING, CALENDAR_SHARING]) {
      expect(approval(argv)).toBe("user-approval");
    }
  });

  it("denies such a command in a group turn, where no button can be shown", () => {
    for (const argv of [AUTO_FORWARDING, DRIVE_SHARING, CALENDAR_SHARING]) {
      expect(approval(argv, FAMILY_GROUP_TURN))
        .toMatchObject({ reason: expect.stringContaining("AGENT_APPROVAL_SURFACE_UNAVAILABLE"), type: "denied" });
    }
  });

  it.each([
    ["a delegated task", SUBAGENT_TURN, "AGENT_GOOGLE_WORKSPACE_SUBAGENT_WRITE_FORBIDDEN"],
    ["an isolated scenario run", SCHEDULED_TURN, "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"],
    ["a scenario wake-up in the conversation", WAKEUP_TURN, "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"],
    ["an isolated scenario run continued after a button press", SCHEDULED_CONTINUATION_TURN,
      "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"],
    ["a wake-up continued after a button press", WAKEUP_CONTINUATION_TURN, "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"],
    ["a turn whose auth alone names a scenario", SCENARIO_INITIATOR_ONLY_TURN, "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"],
  ] as const)("lets %s only read", async (_name, turn, code) => {
    expect(approval(["calendar", "+agenda", "--today"], turn)).toBe("not-applicable");
    for (const argv of [
      ["gmail", "+send", "--to", "a@example.com", "--subject", "s", "--body", "b"],
      AUTO_FORWARDING,
      // A Gmail message change gets the same refusal, not a hint to a tool the turn cannot use.
      ["gmail", "users", "messages", "trash", "--params", '{"userId":"me","id":"m"}'],
    ]) {
      expect(approval(argv, turn)).toMatchObject({ reason: expect.stringContaining(code), type: "denied" });
    }
    // Execution repeats the check before any credential is touched.
    await expect(executeRaw({ argv: ["calendar", "events", "insert", "--json", "{}"] }, turn))
      .rejects.toMatchObject({ code, isExpectedRefusal: true });
  });

  it("denies unreviewed commands and raw Gmail message changes", () => {
    expect(approval(["auth", "export"])).toMatchObject({ type: "denied" });
    expect(approval([
      "gmail",
      "users",
      "messages",
      "trash",
      "--params",
      '{"userId":"me","id":"message-id"}',
    ])).toMatchObject({
      reason: expect.stringMatching(/manage_gmail_message/u),
      type: "denied",
    });
  });

  it("offers executable read examples through the actual approval boundary", () => {
    const examples = [...toolDescription().matchAll(/\[[^\[\]]+\]/gu)].map(match => JSON.parse(match[0]) as string[]);
    expect(examples.some(argv => argv[0] === "gmail" && argv[1] === "+triage")).toBe(true);
    expect(examples.some(argv => argv[0] === "calendar")).toBe(true);
    expect(examples.some(argv => argv[0] === "schema")).toBe(true);
    for (const argv of examples) expect(approval(argv)).toBe("not-applicable");
  });

  it("denies a replayed raw Gmail deletion before resolving credentials", async () => {
    await expect(executeRaw({
      argv: [
        "gmail",
        "users",
        "messages",
        "delete",
        "--params",
        '{"userId":"me","id":"message-id"}',
      ],
    })).rejects.toThrowError(/manage_gmail_message/u);
  });
});

describe("createGoogleWorkspaceExecutor", () => {
  it("does not execute after a mid-turn membership revocation", async () => {
    const deps = dependencies();
    deps.withAuthorizedExecution.mockRejectedValueOnce(
      new Error("AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED: Доступ отозван"),
    );
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute({ argv: ["calendar", "events", "insert", "--json", "{}"] }, {} as never))
      .rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED/u);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([personalAuth, familyAuth])("uses only the live $scope profile", async (auth) => {
    const deps = dependencies(auth);
    const execute = createGoogleWorkspaceExecutor(deps as never);

    const result = await execute(
      { argv: ["calendar", "events", "list", "--params", "{}"] },
      {} as never,
    );

    expect(result).toMatchObject({ profileRef: "profile-1", scope: auth.scope });
    expect(deps.withAuthorizedExecution).toHaveBeenCalledWith(auth, expect.any(Function));
    expect(deps.run).toHaveBeenCalledWith(
      ["calendar", "events", "list", "--params", "{}"],
      "read",
      auth,
      "live-access-token",
      expect.anything(),
    );
  });

  it("passes shell metacharacters as one unchanged argument", async () => {
    const deps = dependencies();
    const execute = createGoogleWorkspaceExecutor(deps as never);
    const dangerous = '$(touch /tmp/pwned); `id`; a && rm -rf /';

    await execute({
      argv: ["gmail", "+send", "--to", "a@example.com", "--subject", dangerous],
    }, {} as never);

    expect(deps.run.mock.calls[0]?.[0][5]).toBe(dangerous);
  });

  it("keeps live authorization active through the credentialed command", async () => {
    const deps = dependencies();
    let authorizationActive = false;
    deps.withAuthorizedExecution.mockImplementationOnce(async (_auth, operation) => {
      authorizationActive = true;
      try {
        return await operation("live-access-token", {
          displayName: "owner@example.com",
          profileRef: "profile-1",
        });
      } finally {
        authorizationActive = false;
      }
    });
    deps.run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ authorizationActive }),
    }));
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "list", "--params", "{}"] },
      {} as never,
    )).resolves.toMatchObject({ stdout: "{\"authorizationActive\":true}" });
    expect(authorizationActive).toBe(false);
  });

  it("rejects oversized output before it reaches the next model call", async () => {
    const deps = dependencies();
    deps.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: "x".repeat(300_000),
    });
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "list", "--params", "{}"] },
      {} as never,
    )).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_OUTPUT_TOO_LARGE/u);
  });

  it("reports bounded success after an oversized mutation result", async () => {
    const deps = dependencies();
    deps.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "details".repeat(50_000),
      stdout: "result".repeat(50_000),
    });
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "insert", "--json", "{}"] },
      {} as never,
    )).resolves.toEqual({
      completed: true,
      kind: "mutation",
      outputBytes: expect.any(Number),
      outputTruncated: true,
      profileRef: "profile-1",
      scope: "personal",
      stderr: "",
      stdout: "",
    });
  });

  it("stops inside the live profile lock when the approved profile was replaced", async () => {
    const deps = dependencies();
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute({
      argv: ["gmail", "users", "messages", "trash", "--params", "{}"],
      expectedProfileRef: "old-profile",
    }, {} as never)).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED/u);
    expect(deps.run).not.toHaveBeenCalled();
  });
});
