/**
 * Dependency-injected installer orchestration tests.
 *
 * Constructs covered:
 * - `runInteractiveInstaller`: collects and validates setup input before execution.
 * - Immutable release boundary: absent or corrupt assets fail without invoking installation.
 * - Successful owner bootstrap output originates only from the installation executor.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  InstallerDependencies,
  NormalizedModel,
  PromptAdapter,
  ReleaseAssets,
} from "./contracts.js";
import { runInteractiveInstaller } from "./installer.js";

const archive = Buffer.from("immutable release archive");
const releaseAssets: ReleaseAssets = {
  archive,
  archiveSha256: createHash("sha256").update(archive).digest("hex"),
  version: "1.2.3",
};

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

function prompts(overrides: Partial<PromptAdapter> = {}): PromptAdapter {
  return {
    confirm: vi.fn().mockResolvedValue(false),
    secret: vi
      .fn()
      .mockResolvedValueOnce("123456:Abc_def-123")
      .mockResolvedValueOnce("model-key"),
    select: vi
      .fn()
      .mockResolvedValueOnce("sslip-io")
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("deepseek")
      .mockResolvedValueOnce(model.id),
    text: vi.fn(),
    ...overrides,
  };
}

function dependencies(overrides: Partial<InstallerDependencies> = {}): InstallerDependencies {
  return {
    executeInstallation: vi.fn().mockResolvedValue({
      bootstrapCode: "bootstrap_secret-123",
      bootstrapExpiresAt: "2026-08-12T12:15:00.000Z",
    }),
    generateSecret: vi.fn((purpose: string) => `secret-${purpose}-abcdefghijklmnopqrstuvwxyz`),
    getTelegramMe: vi.fn().mockResolvedValue({
      ok: true,
      result: { id: 123456, is_bot: true, username: "Osinara_Test_Bot" },
    }),
    listModels: vi.fn().mockResolvedValue([model]),
    now: vi.fn(() => new Date("2026-08-12T12:00:00.000Z")),
    prompts: prompts(),
    publicIpv4Sources: [
      { id: "first", observe: vi.fn().mockResolvedValue("8.8.8.8") },
      { id: "second", observe: vi.fn().mockResolvedValue("8.8.8.8") },
    ],
    resolveIpv4: vi.fn(),
    resolveReleaseAssets: vi.fn().mockResolvedValue(releaseAssets),
    validateModel: vi.fn().mockResolvedValue(undefined),
    validateGroq: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("provider installer orchestration", () => {
  it("installs a validated sslip.io setup and returns executor-issued bootstrap output", async () => {
    const deps = dependencies();

    await expect(runInteractiveInstaller(deps)).resolves.toEqual({
      address: "https://8-8-8-8.sslip.io",
      botUsername: "Osinara_Test_Bot",
      ownerBootstrap: {
        code: "OSINARA_OWNER_BOOTSTRAP_READY",
        expiresAt: "2026-08-12T12:15:00.000Z",
        url: "https://t.me/Osinara_Test_Bot?start=bootstrap_secret-123",
      },
      provider: "deepseek",
      model,
      reasoning: { effort: "high", type: "effort" },
      reasoningSelection: "automatic-single",
      releaseVersion: "1.2.3",
    });

    expect(deps.executeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "8-8-8-8.sslip.io",
        tlsMode: "managed",
        groqApiKey: null,
        modelApiKey: "model-key",
        model,
        provider: "deepseek",
        publicIpv4: "8.8.8.8",
        reasoning: { effort: "high", type: "effort" },
        reasoningSelection: "automatic-single",
        telegramBotToken: "123456:Abc_def-123",
      }),
    );
    expect(deps.listModels).toHaveBeenCalledWith("deepseek", "model-key");
    expect(deps.validateModel).toHaveBeenCalledWith(
      "deepseek",
      "model-key",
      model,
      { effort: "high", type: "effort" },
    );
    expect(deps.resolveReleaseAssets).toHaveBeenCalledWith();
  });

  it("supports a DNS-validated custom hostname and optional Groq credential", async () => {
    const customPrompts = prompts({
      confirm: vi.fn().mockResolvedValue(true),
      secret: vi
        .fn()
        .mockResolvedValueOnce("123456:Abc_def-123")
        .mockResolvedValueOnce("model-key")
        .mockResolvedValueOnce("groq-key"),
      select: vi
        .fn()
        .mockResolvedValueOnce("custom-domain")
        .mockResolvedValueOnce("managed")
        .mockResolvedValueOnce("deepseek")
        .mockResolvedValueOnce(model.id),
      text: vi.fn().mockResolvedValue("Bot.Example.com"),
    });
    const deps = dependencies({
      prompts: customPrompts,
      resolveIpv4: vi.fn().mockResolvedValue(["8.8.8.8"]),
    });

    await runInteractiveInstaller(deps);

    expect(deps.executeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "bot.example.com", groqApiKey: "groq-key" }),
    );
  });

  it("prompts for an exact model and reasoning when multiple values are available", async () => {
    const secondModel: NormalizedModel = {
      ...model,
      defaultReasoningOption: null,
      displayName: "Router Model",
      id: "vendor/router-model",
      reasoningOptions: [
        { effort: "low", type: "effort" },
        { mode: "adaptive", type: "enabled" },
      ],
    };
    const multiPrompts = prompts({
      select: vi
        .fn()
        .mockResolvedValueOnce("sslip-io")
        .mockResolvedValueOnce("managed")
        .mockResolvedValueOnce("openrouter")
        .mockResolvedValueOnce(secondModel.id)
        .mockResolvedValueOnce("enabled:adaptive"),
    });
    const deps = dependencies({
      listModels: vi.fn().mockResolvedValue([model, secondModel]),
      prompts: multiPrompts,
    });

    await runInteractiveInstaller(deps);

    expect(deps.validateModel).toHaveBeenCalledWith(
      "openrouter",
      "model-key",
      secondModel,
      { mode: "adaptive", type: "enabled" },
    );
    expect(deps.executeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        model: secondModel,
        reasoning: { mode: "adaptive", type: "enabled" },
        reasoningSelection: "explicit",
      }),
    );
    expect(multiPrompts.select).toHaveBeenNthCalledWith(
      5,
      "Выберите reasoning для Router Model",
      [
        { label: "Низкое усилие рассуждений", value: "effort:low" },
        { label: "Адаптивные рассуждения", value: "enabled:adaptive" },
      ],
    );
  });

  it("uses null reasoning without prompting when the selected model exposes no options", async () => {
    const modelWithoutReasoning: NormalizedModel = {
      ...model,
      defaultReasoningOption: null,
      reasoningOptions: [],
    };
    const select = vi
      .fn()
      .mockResolvedValueOnce("sslip-io")
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("minimax")
      .mockResolvedValueOnce(modelWithoutReasoning.id);
    const deps = dependencies({
      listModels: vi.fn().mockResolvedValue([modelWithoutReasoning]),
      prompts: prompts({ select }),
    });

    await runInteractiveInstaller(deps);

    expect(select).toHaveBeenCalledTimes(4);
    expect(deps.validateModel).toHaveBeenCalledWith(
      "minimax",
      "model-key",
      modelWithoutReasoning,
      null,
    );
    expect(deps.executeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: null, reasoningSelection: "unavailable" }),
    );
  });

  it("rejects a reasoning prompt result outside the selected model allowlist", async () => {
    const executeInstallation = vi.fn();
    const modelWithChoices: NormalizedModel = {
      ...model,
      reasoningOptions: [
        { effort: "low", type: "effort" },
        { effort: "high", type: "effort" },
      ],
    };
    const deps = dependencies({
      executeInstallation,
      listModels: vi.fn().mockResolvedValue([modelWithChoices]),
      prompts: prompts({
        select: vi
          .fn()
          .mockResolvedValueOnce("sslip-io")
          .mockResolvedValueOnce("managed")
          .mockResolvedValueOnce("deepseek")
          .mockResolvedValueOnce(modelWithChoices.id)
          .mockResolvedValueOnce("effort:max"),
      }),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_REASONING_SELECTION_INVALID",
    });
    expect(deps.validateModel).not.toHaveBeenCalled();
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("fails before smoke validation and host mutation when the catalog is empty", async () => {
    const executeInstallation = vi.fn();
    const validateModel = vi.fn();
    const deps = dependencies({
      executeInstallation,
      listModels: vi.fn().mockResolvedValue([]),
      validateModel,
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_MODEL_CATALOG_EMPTY",
    });
    expect(validateModel).not.toHaveBeenCalled();
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("rejects duplicate or malformed normalized model metadata", async () => {
    const executeInstallation = vi.fn();
    const deps = dependencies({
      executeInstallation,
      listModels: vi.fn().mockResolvedValue([
        model,
        { ...model, contextWindowTokens: -1, displayName: "Duplicate" },
      ]),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_MODEL_CATALOG_INVALID",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("rejects structurally duplicate reasoning selections from the catalog", async () => {
    const executeInstallation = vi.fn();
    const deps = dependencies({
      executeInstallation,
      listModels: vi.fn().mockResolvedValue([{
        ...model,
        reasoningOptions: [
          { effort: "high", type: "effort" },
          { effort: "high", type: "effort" },
        ],
      }]),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_MODEL_CATALOG_INVALID",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it.each([
    { contextWindowTokens: null },
    { contextWindowTokens: 0 },
    { maxOutputTokens: null },
    { maxOutputTokens: -1 },
    { supportsImageInput: null },
    { supportsTools: false },
    { supportsTools: null },
  ] satisfies readonly Record<string, unknown>[])(
    "rejects catalog metadata that is not installer-ready: %#",
    async (invalidMetadata) => {
      const executeInstallation = vi.fn();
      const deps = dependencies({
        executeInstallation,
        listModels: vi.fn().mockResolvedValue([
          { ...model, ...invalidMetadata } as unknown as NormalizedModel,
        ]),
      });

      await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
        code: "OSINARA_INSTALL_MODEL_CATALOG_INVALID",
      });
      expect(executeInstallation).not.toHaveBeenCalled();
    },
  );

  it("rejects a prompt result outside the current model catalog", async () => {
    const executeInstallation = vi.fn();
    const deps = dependencies({
      executeInstallation,
      prompts: prompts({
        select: vi
          .fn()
          .mockResolvedValueOnce("sslip-io")
          .mockResolvedValueOnce("managed")
          .mockResolvedValueOnce("deepseek")
          .mockResolvedValueOnce("stale-model-id"),
      }),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_MODEL_SELECTION_INVALID",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("does not mutate the host when model smoke validation fails", async () => {
    const executeInstallation = vi.fn();
    const generateSecret = vi.fn();
    const deps = dependencies({
      executeInstallation,
      generateSecret,
      validateModel: vi.fn().mockRejectedValue(new Error("provider rejected smoke request")),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toThrowError(
      "provider rejected smoke request",
    );
    expect(generateSecret).not.toHaveBeenCalled();
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("fails clearly and never executes when provider release assets are unavailable", async () => {
    const executeInstallation = vi.fn();
    const deps = dependencies({
      executeInstallation,
      resolveReleaseAssets: vi.fn().mockResolvedValue(null),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_ASSETS_UNAVAILABLE",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("rejects checksum-mismatched assets before installation", async () => {
    const executeInstallation = vi.fn();
    const deps = dependencies({
      executeInstallation,
      resolveReleaseAssets: vi.fn().mockResolvedValue({
        ...releaseAssets,
        archiveSha256: "0".repeat(64),
      }),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_CHECKSUM_MISMATCH",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("rejects an empty release archive even when its checksum matches", async () => {
    const executeInstallation = vi.fn();
    const emptyArchive = Buffer.alloc(0);
    const deps = dependencies({
      executeInstallation,
      resolveReleaseAssets: vi.fn().mockResolvedValue({
        ...releaseAssets,
        archive: emptyArchive,
        archiveSha256: createHash("sha256").update(emptyArchive).digest("hex"),
      }),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_METADATA_INVALID",
    });
    expect(executeInstallation).not.toHaveBeenCalled();
  });

  it("rejects executor output that is expired instead of printing a dead link", async () => {
    const deps = dependencies({
      executeInstallation: vi.fn().mockResolvedValue({
        bootstrapCode: "bootstrap_secret-123",
        bootstrapExpiresAt: "2026-08-12T11:59:59.000Z",
      }),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
    });
  });

  it("rejects a malformed executor response with a stable boundary error", async () => {
    const deps = dependencies({
      executeInstallation: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runInteractiveInstaller(deps)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
    });
  });
});
