/**
 * Credentialed Google Workspace execution boundary tests.
 *
 * Constructs covered:
 * - Mutations require Eve HITL while reads do not.
 * - Execution rechecks current access/profile after approval and preserves scope isolation.
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

function approval(argv: string[]) {
  return (executeGoogleWorkspace as unknown as {
    approval: (context: { toolInput?: { argv: string[] } }) => unknown;
  }).approval({ toolInput: { argv } });
}

function toolDescription(): string {
  return (executeGoogleWorkspace as unknown as { description: string }).description;
}

async function executeRaw(input: { argv: string[] }) {
  return await (executeGoogleWorkspace as unknown as {
    execute: (input: { argv: string[] }, ctx: unknown) => Promise<unknown>;
  }).execute(input, {});
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

describe("execute_google_workspace approval", () => {
  it("requires approval for every mutation and denies unreviewed commands", () => {
    expect(approval(["calendar", "events", "list", "--params", "{}"])).toBe(
      "not-applicable",
    );
    expect(approval(["calendar", "events", "insert", "--json", "{}"])).toBe(
      "user-approval",
    );
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
