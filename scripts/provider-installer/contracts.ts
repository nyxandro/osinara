/**
 * Dependency-injected provider installer contracts.
 *
 * Exports:
 * - Address, provider, normalized model, prompt, Telegram, release asset, and dependency types.
 * - Executor input/output contracts separating setup validation from host mutation.
 */
export type AddressMode = "sslip-io" | "custom-domain";
export type ModelProvider = "deepseek" | "minimax" | "neuraldeep" | "opencode-go" | "openrouter";
export type ModelProtocol = "anthropic-messages" | "openai-chat-completions";
export type ReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal";
export type ReasoningSelection =
  | { readonly type: "none" }
  | { readonly effort: ReasoningEffort; readonly type: "effort" }
  | { readonly mode: "adaptive" | "enabled"; readonly type: "enabled" };
export type ReasoningSelectionMarker = "unavailable" | "automatic-single" | "explicit";

/** Catalog callbacks must return complete installer-ready metadata without null capability fields. */
export interface NormalizedModel {
  readonly contextWindowTokens: number;
  readonly defaultReasoningOption: ReasoningSelection | null;
  readonly displayName: string;
  readonly id: string;
  readonly maxOutputTokens: number;
  readonly protocol: ModelProtocol;
  readonly reasoningOptions: readonly ReasoningSelection[];
  readonly supportsImageInput: boolean;
  readonly supportsTools: true;
}

export type ListModels = (
  provider: ModelProvider,
  apiKey: string,
) => Promise<readonly NormalizedModel[]>;
export type ValidateModel = (
  provider: ModelProvider,
  apiKey: string,
  model: NormalizedModel,
  reasoning: ReasoningSelection | null,
) => Promise<void>;
export type ValidateGroq = (apiKey: string) => Promise<void>;

export interface PublicIpv4Source {
  id: string;
  observe: () => Promise<string>;
}

export interface PromptOption<T extends string> {
  label: string;
  value: T;
}

export interface PromptAdapter {
  confirm: (message: string) => Promise<boolean>;
  secret: (message: string) => Promise<string>;
  select: <T extends string>(message: string, options: readonly PromptOption<T>[]) => Promise<T>;
  text: (message: string) => Promise<string>;
}

export type ResolveIpv4 = (hostname: string) => Promise<string[]>;

export interface TelegramGetMeSuccess {
  ok: true;
  result: {
    id: number;
    is_bot: boolean;
    username?: string;
  };
}

export interface TelegramGetMeFailure {
  ok: false;
  description?: string;
}

export type TelegramGetMeResponse = TelegramGetMeSuccess | TelegramGetMeFailure;
export type GetTelegramMe = (token: string) => Promise<TelegramGetMeResponse>;

export interface ReleaseAssets {
  archive: Uint8Array;
  archiveSha256: string;
  version: string;
}

export interface InternalSecrets {
  invitationSigningSecret: string;
  postgresPassword: string;
  telegramWebhookSecretToken: string;
}

export interface InstallationExecutionInput {
  assets: ReleaseAssets;
  groqApiKey: string | null;
  hostname: string;
  internalSecrets: InternalSecrets;
  modelApiKey: string;
  model: NormalizedModel;
  provider: ModelProvider;
  publicIpv4: string;
  reasoning: ReasoningSelection | null;
  reasoningSelection: ReasoningSelectionMarker;
  telegramBotToken: string;
  telegramBotUsername: string;
}

export interface InstallationExecutionResult {
  bootstrapCode: string;
  bootstrapExpiresAt: string;
}

export interface InstallerDependencies {
  executeInstallation: (
    input: InstallationExecutionInput,
  ) => Promise<InstallationExecutionResult>;
  generateSecret: (purpose: string) => string;
  getTelegramMe: GetTelegramMe;
  listModels: ListModels;
  now: () => Date;
  prompts: PromptAdapter;
  publicIpv4Sources: readonly PublicIpv4Source[];
  resolveIpv4: ResolveIpv4;
  resolveReleaseAssets: () => Promise<ReleaseAssets | null>;
  validateModel: ValidateModel;
  validateGroq: ValidateGroq;
}

export interface OwnerBootstrapOutput {
  code: "OSINARA_OWNER_BOOTSTRAP_READY";
  expiresAt: string;
  url: string;
}

export interface InstallerResult {
  address: string;
  botUsername: string;
  model: NormalizedModel;
  ownerBootstrap: OwnerBootstrapOutput;
  provider: ModelProvider;
  reasoning: ReasoningSelection | null;
  reasoningSelection: ReasoningSelectionMarker;
  releaseVersion: string;
}
