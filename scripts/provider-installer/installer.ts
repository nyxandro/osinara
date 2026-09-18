/**
 * Interactive provider installer orchestration.
 *
 * Exports:
 * - `runInteractiveInstaller`: validates network, credentials, provider catalog, model smoke,
 *   immutable assets, host mutation, and the executor-issued owner bootstrap link.
 */
import { createHash } from "node:crypto";

import { discoverPublicIpv4, normalizeSslipHostname, validateCustomHostname } from "./address.ts";
import {
  ADDRESS_MODE_OPTIONS,
  TLS_MODE_OPTIONS,
  MODEL_PROVIDER_OPTIONS,
  buildOwnerBootstrapOutput,
  generateInternalSecrets,
  requireCredential,
} from "./configuration.ts";
import type {
  InstallationExecutionResult,
  InstallerDependencies,
  InstallerResult,
  NormalizedModel,
  ReasoningSelection,
  ReasoningSelectionMarker,
  ReleaseAssets,
} from "./contracts.ts";
import { InstallerError } from "./errors.ts";
import {
  decodeReasoningSelection,
  encodeReasoningSelection,
  isReasoningSelection,
  reasoningSelectionLabel,
} from "./reasoning-selection.ts";
import { validateTelegramBot } from "./telegram.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function requireVerifiedAssets(assets: ReleaseAssets | null): ReleaseAssets {
  if (!assets) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_ASSETS_UNAVAILABLE",
      "Отсутствуют обязательные immutable release assets для установки Osinara",
    );
  }
  if (
    assets.archive.byteLength === 0 ||
    !STABLE_SEMVER_PATTERN.test(assets.version) ||
    !SHA256_PATTERN.test(assets.archiveSha256)
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_METADATA_INVALID",
      "Release assets содержат некорректную версию или SHA-256",
    );
  }
  const actualSha256 = createHash("sha256").update(assets.archive).digest("hex");
  if (actualSha256 !== assets.archiveSha256) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_CHECKSUM_MISMATCH",
      "SHA-256 release asset не совпадает с опубликованным значением",
    );
  }
  return assets;
}

function requireModelCatalog(models: readonly NormalizedModel[]): readonly NormalizedModel[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new InstallerError(
      "OSINARA_INSTALL_MODEL_CATALOG_EMPTY",
      "Поставщик не вернул ни одной доступной модели для этого API-ключа",
    );
  }

  // Duplicate IDs make an exact prompt selection ambiguous; malformed metadata violates the callback contract.
  const ids = new Set<string>();
  for (const candidate of models as readonly unknown[]) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new InstallerError(
        "OSINARA_INSTALL_MODEL_CATALOG_INVALID",
        "Каталог поставщика содержит некорректные или неоднозначные данные моделей",
      );
    }
    const model = candidate as Partial<NormalizedModel>;
    const contextWindowValid =
      typeof model.contextWindowTokens === "number" &&
      Number.isInteger(model.contextWindowTokens) &&
      model.contextWindowTokens > 0;
    const maxOutputValid =
      typeof model.maxOutputTokens === "number" &&
      Number.isInteger(model.maxOutputTokens) &&
      model.maxOutputTokens > 0;
    const imageCapabilityValid = typeof model.supportsImageInput === "boolean";
    const toolCapabilityValid = model.supportsTools === true;
    const reasoningOptionsValid =
      Array.isArray(model.reasoningOptions) && model.reasoningOptions.every(isReasoningSelection);
    const reasoningOptionIds = reasoningOptionsValid
      ? model.reasoningOptions.map(encodeReasoningSelection)
      : [];
    const defaultReasoningValid =
      model.defaultReasoningOption === null ||
      (isReasoningSelection(model.defaultReasoningOption) &&
        reasoningOptionIds.includes(encodeReasoningSelection(model.defaultReasoningOption)));
    const metadataValid =
      contextWindowValid &&
      maxOutputValid &&
      imageCapabilityValid &&
      toolCapabilityValid &&
      typeof model.id === "string" &&
      model.id.trim().length > 0 &&
      typeof model.displayName === "string" &&
      model.displayName.trim().length > 0 &&
      (model.protocol === "anthropic-messages" || model.protocol === "openai-chat-completions") &&
      reasoningOptionsValid &&
      new Set(reasoningOptionIds).size === reasoningOptionIds.length &&
      defaultReasoningValid;
    if (!metadataValid || ids.has(model.id as string)) {
      throw new InstallerError(
        "OSINARA_INSTALL_MODEL_CATALOG_INVALID",
        "Каталог поставщика содержит некорректные или неоднозначные данные моделей",
      );
    }
    ids.add(model.id as string);
  }
  return models;
}

async function selectModel(
  models: readonly NormalizedModel[],
  dependencies: InstallerDependencies,
): Promise<NormalizedModel> {
  const modelId = await dependencies.prompts.select(
    "Выберите модель",
    models.map((model) => ({ label: model.displayName, value: model.id })),
  );
  const model = models.find(({ id }) => id === modelId);
  if (!model) {
    throw new InstallerError(
      "OSINARA_INSTALL_MODEL_SELECTION_INVALID",
      "Выбранная модель отсутствует в актуальном каталоге поставщика",
    );
  }
  return model;
}

async function selectReasoning(
  model: NormalizedModel,
  dependencies: InstallerDependencies,
): Promise<{
  reasoning: ReasoningSelection | null;
  selection: ReasoningSelectionMarker;
}> {
  if (model.reasoningOptions.length === 0) {
    return { reasoning: null, selection: "unavailable" };
  }
  if (model.reasoningOptions.length === 1) {
    return { reasoning: model.reasoningOptions[0] as ReasoningSelection, selection: "automatic-single" };
  }

  const selectedId = await dependencies.prompts.select(
    `Выберите reasoning для ${model.displayName}`,
    model.reasoningOptions.map((option) => ({
      label: reasoningSelectionLabel(option),
      value: encodeReasoningSelection(option),
    })),
  );
  const selected = decodeReasoningSelection(selectedId);
  const selectedCanonicalId = encodeReasoningSelection(selected);
  if (!model.reasoningOptions.some(
    (option) => encodeReasoningSelection(option) === selectedCanonicalId,
  )) {
    throw new InstallerError(
      "OSINARA_INSTALL_REASONING_SELECTION_INVALID",
      "Выбранный reasoning недоступен для этой модели",
    );
  }
  return { reasoning: selected, selection: "explicit" };
}

function requireExecutionResult(value: unknown): InstallationExecutionResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("bootstrapCode" in value) ||
    !("bootstrapExpiresAt" in value) ||
    typeof value.bootstrapCode !== "string" ||
    typeof value.bootstrapExpiresAt !== "string"
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
      "Executor не вернул обязательные данные первичной привязки владельца",
    );
  }
  return {
    bootstrapCode: value.bootstrapCode,
    bootstrapExpiresAt: value.bootstrapExpiresAt,
  };
}

export async function runInteractiveInstaller(
  dependencies: InstallerDependencies,
): Promise<InstallerResult> {
  const publicIpv4 = await discoverPublicIpv4(dependencies.publicIpv4Sources);
  const addressMode = await dependencies.prompts.select(
    "Выберите публичный адрес Osinara",
    ADDRESS_MODE_OPTIONS,
  );
  const hostname =
    addressMode === "sslip-io"
      ? normalizeSslipHostname(publicIpv4)
      : await validateCustomHostname(
          await dependencies.prompts.text("Введите DNS-имя без протокола"),
          publicIpv4,
          dependencies.resolveIpv4,
        );
  // The host decides nothing here: an occupied port 443 is verified later against this explicit choice.
  const tlsMode = await dependencies.prompts.select(
    "Как публиковать HTTPS для Osinara",
    TLS_MODE_OPTIONS,
  );
  const provider = await dependencies.prompts.select(
    "Выберите поставщика модели",
    MODEL_PROVIDER_OPTIONS,
  );

  // One immutable release supports every provider; it is never selected from provider input.
  const assets = requireVerifiedAssets(await dependencies.resolveReleaseAssets());

  // Telegram username is never accepted as input: getMe is the sole trusted identity source.
  const telegramBotToken = requireCredential(
    await dependencies.prompts.secret("Введите токен Telegram-бота"),
    "токен Telegram-бота",
  );
  const telegramBot = await validateTelegramBot(telegramBotToken, dependencies.getTelegramMe);
  const modelApiKey = requireCredential(
    await dependencies.prompts.secret("Введите API-ключ выбранного поставщика модели"),
    "API-ключ модели",
  );
  const models = requireModelCatalog(await dependencies.listModels(provider, modelApiKey));
  const model = await selectModel(models, dependencies);
  const { reasoning, selection: reasoningSelection } = await selectReasoning(model, dependencies);

  // A real provider request must pass before any generated secret or host mutation reaches the executor.
  await dependencies.validateModel(provider, modelApiKey, model, reasoning);
  const groqEnabled = await dependencies.prompts.confirm(
    "Включить расшифровку голосовых сообщений через Groq?",
  );
  const groqApiKey = groqEnabled
    ? requireCredential(await dependencies.prompts.secret("Введите Groq API key"), "Groq API key")
    : null;
  if (groqApiKey !== null) await dependencies.validateGroq(groqApiKey);

  const execution = requireExecutionResult(
    await dependencies.executeInstallation({
      assets,
      groqApiKey,
      hostname,
      internalSecrets: generateInternalSecrets(dependencies.generateSecret),
      modelApiKey,
      model,
      provider,
      publicIpv4,
      reasoning,
      reasoningSelection,
      telegramBotToken,
      telegramBotUsername: telegramBot.username,
      tlsMode,
    }),
  );
  const ownerBootstrap = buildOwnerBootstrapOutput({
    botUsername: telegramBot.username,
    code: execution.bootstrapCode,
    expiresAt: execution.bootstrapExpiresAt,
  });
  if (new Date(ownerBootstrap.expiresAt).getTime() <= dependencies.now().getTime()) {
    throw new InstallerError(
      "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
      "Executor вернул уже истекший код первичной привязки владельца",
    );
  }

  return {
    address: `https://${hostname}`,
    botUsername: telegramBot.username,
    model,
    ownerBootstrap,
    provider,
    reasoning,
    reasoningSelection,
    releaseVersion: assets.version,
  };
}
