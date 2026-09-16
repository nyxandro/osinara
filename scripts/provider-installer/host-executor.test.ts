/**
 * Transactional host installation executor tests.
 *
 * Constructs covered:
 * - `createHostInstallationExecutor`: orders immutable staging, Compose, TLS, webhook, and bootstrap.
 * - Durable migration boundary, pre-migration rollback, and ambiguous-state handling.
 * - Primary installation failure precedence over release-lock cleanup failure.
 * - Exact generated environment and schema-v4 model configuration inputs.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { InstallationExecutionInput, NormalizedModel } from "./contracts.js";
import {
  createHostInstallationExecutor,
  type HostInstallationOperations,
} from "./host-executor.js";

const archive = Buffer.from("validated bundle bytes");
const model: NormalizedModel = {
  contextWindowTokens: 128_000,
  defaultReasoningOption: { effort: "high", type: "effort" },
  displayName: "DeepSeek Reasoner",
  id: "deepseek-reasoner",
  maxOutputTokens: 16_000,
  protocol: "openai-chat-completions",
  reasoningOptions: [{ effort: "high", type: "effort" }],
  supportsImageInput: false,
  supportsTools: true,
};

function input(overrides: Partial<InstallationExecutionInput> = {}): InstallationExecutionInput {
  return {
    assets: {
      archive,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      version: "0.15.3",
    },
    groqApiKey: null,
    hostname: "8-8-8-8.sslip.io",
    tlsMode: "managed",
    internalSecrets: {
      invitationSigningSecret: "invitation_secret_abcdefghijklmnopqrstuvwxyz",
      postgresPassword: "postgres_secret_abcdefghijklmnopqrstuvwxyz",
      telegramWebhookSecretToken: "webhook_secret_abcdefghijklmnopqrstuvwxyz",
      workflowPostgresPassword: "workflow_postgres_secret_abcdefghijklmnopqrstuvwxyz",
    },
    model,
    modelApiKey: "model-secret",
    provider: "deepseek",
    publicIpv4: "8.8.8.8",
    reasoning: { effort: "high", type: "effort" },
    reasoningSelection: "automatic-single",
    telegramBotToken: "123456:Abc_def-123",
    telegramBotUsername: "Osinara_Test_Bot",
    ...overrides,
  };
}

function operations(events: string[]): HostInstallationOperations {
  const event = <T>(name: string, result?: T) => vi.fn(async () => {
    events.push(name);
    return result as T;
  });
  return {
    acquireLock: event("lock", event("unlock")),
    assertCleanState: event("clean"),
    assertHostPrerequisites: event("prerequisites"),
    commit: event("commit"),
    configureWebhook: event("webhook"),
    createOwnerBootstrap: event("bootstrap", {
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-13T12:15:00.000Z",
    }),
    markMigrationStarted: event("migration-marker"),
    preflight: event("preflight"),
    pullImages: event("pull"),
    rollbackPreparedState: event("rollback"),
    stage: event("stage"),
    startApplication: event("application"),
    startTls: event("tls"),
    validateBundle: event("bundle"),
    waitForPublicHttps: event("https"),
  };
}

describe("createHostInstallationExecutor", () => {
  it("installs in the exact trust order and generates no legacy proxy credentials", async () => {
    const events: string[] = [];
    const ops = operations(events);
    const executeInstallation = createHostInstallationExecutor(ops);

    await expect(executeInstallation(input())).resolves.toEqual({
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-13T12:15:00.000Z",
    });

    expect(events).toEqual([
      "bundle", "prerequisites", "lock", "clean", "stage", "preflight", "pull",
      "migration-marker", "application", "tls", "https", "bootstrap", "webhook", "commit", "unlock",
    ]);
    const staged = vi.mocked(ops.stage).mock.calls[0]?.[0];
    expect(Buffer.from(staged!.archive).equals(archive)).toBe(true);
    expect(staged).toMatchObject({
      hostname: "8-8-8-8.sslip.io",
      releaseVersion: "0.15.3",
      tlsMode: "managed",
    });
    expect(ops.preflight).toHaveBeenCalledWith({ hostname: "8-8-8-8.sslip.io", tlsMode: "managed" });
    expect(ops.pullImages).toHaveBeenCalledWith({ hostname: "8-8-8-8.sslip.io", tlsMode: "managed" });
    const environment = staged?.environmentBytes.toString("utf8");
    expect(environment).toContain("MODEL_API_KEY='model-secret'\n");
    expect(environment).toContain("PUBLIC_BASE_URL='https://8-8-8-8.sslip.io'\n");
    expect(environment).toContain(
      "WORKFLOW_POSTGRES_URL='postgresql://osinara_workflow:workflow_postgres_secret_abcdefghijklmnopqrstuvwxyz@postgres:5432/osinara_workflow'\n",
    );
    expect(environment).not.toContain("CLI_PROXY_API_KEY");
    expect(environment).not.toContain("MODEL_UPSTREAM_API_KEY");
    expect(JSON.parse(staged!.modelConfigBytes.toString("utf8"))).toMatchObject({
      provider: "deepseek",
      schemaVersion: 4,
      voice: { enabled: false },
    });
  });

  it("never starts the bundled Traefik when the operator chose an external proxy", async () => {
    const events: string[] = [];
    const ops = operations(events);

    await createHostInstallationExecutor(ops)({ ...input(), tlsMode: "external" });

    expect(ops.startTls).not.toHaveBeenCalled();
    expect(ops.preflight).toHaveBeenCalledWith({ hostname: "8-8-8-8.sslip.io", tlsMode: "external" });
    expect(events).toEqual([
      "bundle", "prerequisites", "lock", "clean", "stage", "preflight", "pull",
      "migration-marker", "application", "https", "bootstrap", "webhook", "commit", "unlock",
    ]);
    expect(vi.mocked(ops.stage).mock.calls[0]?.[0]).toMatchObject({ tlsMode: "external" });
  });

  it("removes attempt-created state when preflight fails before migration", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.preflight).mockRejectedValue(new Error("compose rejected candidate"));

    await expect(createHostInstallationExecutor(ops)(input())).rejects.toMatchObject({
      code: "OSINARA_INSTALL_HOST_PREPARE_FAILED",
    });
    expect(ops.rollbackPreparedState).toHaveBeenCalledOnce();
    expect(ops.startApplication).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("does not clean an existing installation when the clean-state check fails", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.assertCleanState).mockRejectedValue(new Error("existing installation"));

    await expect(createHostInstallationExecutor(ops)(input())).rejects.toThrow("existing installation");
    expect(ops.stage).not.toHaveBeenCalled();
    expect(ops.rollbackPreparedState).not.toHaveBeenCalled();
  });

  it("never destroys state after migration may have started", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.startApplication).mockRejectedValue(new Error("migration container failed"));

    await expect(createHostInstallationExecutor(ops)(input())).rejects.toMatchObject({
      code: "OSINARA_INSTALL_STATE_AMBIGUOUS",
    });
    expect(ops.rollbackPreparedState).not.toHaveBeenCalled();
    expect(ops.startTls).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("fails closed when the durable migration marker cannot be completed", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.markMigrationStarted).mockRejectedValue(new Error("directory fsync failed"));

    await expect(createHostInstallationExecutor(ops)(input())).rejects.toMatchObject({
      code: "OSINARA_INSTALL_STATE_AMBIGUOUS",
    });
    expect(ops.startApplication).not.toHaveBeenCalled();
    expect(ops.rollbackPreparedState).not.toHaveBeenCalled();
  });

  it("does not let release-lock cleanup mask an ambiguous installation state", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.startApplication).mockRejectedValue(new Error("migration container failed"));
    vi.mocked(ops.acquireLock).mockResolvedValue(async () => {
      throw new Error("release lock cleanup failed");
    });

    await expect(createHostInstallationExecutor(ops)(input())).rejects.toMatchObject({
      code: "OSINARA_INSTALL_STATE_AMBIGUOUS",
      cause: expect.objectContaining({ message: "migration container failed" }),
    });
  });

  it("does not lose a successful bootstrap result when lock cleanup reports an error", async () => {
    const events: string[] = [];
    const ops = operations(events);
    vi.mocked(ops.acquireLock).mockResolvedValue(async () => {
      events.push("unlock");
      throw new Error("lock cleanup failed");
    });

    await expect(createHostInstallationExecutor(ops)(input())).resolves.toMatchObject({
      bootstrapCode: "bootstrap_secret-123",
    });
  });

  it("enables voice in the persisted model config only with an explicit Groq key", async () => {
    const events: string[] = [];
    const ops = operations(events);

    await createHostInstallationExecutor(ops)(input({ groqApiKey: "groq-secret" }));

    const staged = vi.mocked(ops.stage).mock.calls[0]?.[0];
    expect(staged?.environmentBytes.toString("utf8")).toContain("GROQ_API_KEY='groq-secret'\n");
    expect(JSON.parse(staged!.modelConfigBytes.toString("utf8"))).toMatchObject({
      voice: { enabled: true, transcriptionModelId: "whisper-large-v3-turbo" },
    });
  });

  it("quotes dollar-bearing credentials so Compose preserves their exact bytes", async () => {
    const events: string[] = [];
    const ops = operations(events);

    await createHostInstallationExecutor(ops)(input({ modelApiKey: "key$LITERAL" }));

    expect(vi.mocked(ops.stage).mock.calls[0]?.[0].environmentBytes.toString("utf8")).toContain(
      "MODEL_API_KEY='key$LITERAL'\n",
    );
  });
});
