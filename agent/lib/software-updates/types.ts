/**
 * Software update domain contracts.
 *
 * Exports:
 * - `SoftwareUpdateManifest`: validated deployment manifest schema version 1.
 * - `SoftwareRelease`: accepted stable GitHub release and its pinned images.
 * - `SoftwareUpdateOwner`: current database owner identity used for exact binding.
 * - Repository, delivery, callback, and transport input/result contracts.
 */
export interface SoftwareUpdateManifest {
  commitSha: string;
  composeSha256: string;
  images: {
    app: string;
    edge: string;
    sandboxEgressProxy: string;
    sandboxRunner: string;
    sandboxRuntime: string;
  };
  schemaVersion: 1;
  version: string;
}

export interface SoftwareRelease {
  manifest: SoftwareUpdateManifest;
  releaseUrl: string;
  version: string;
}

export interface SoftwareUpdateOwner {
  familyId: string;
  telegramUserId: string;
  userId: string;
}

export interface PrepareSoftwareUpdateProposalInput {
  callbackTokenHash: string;
  owner: SoftwareUpdateOwner;
  release: SoftwareRelease;
}

export type PrepareSoftwareUpdateProposalResult =
  | { proposalId: string; status: "created" }
  | { status: "duplicate" };

export interface BindSoftwareUpdateTelegramMessageInput {
  chatId: string;
  chatType: "private";
  messageId: string;
  proposalId: string;
}

export interface SoftwareUpdateDeliveryFailureInput {
  code: string;
  message: string;
  proposalId: string;
  status: "delivery_ambiguous" | "delivery_failed";
}

export interface ClaimSoftwareUpdateDecisionInput {
  action: "approve" | "decline";
  callbackQueryId: string;
  callbackToken: string;
  telegramChatId: string;
  telegramChatType: "channel" | "group" | "private" | "supergroup";
  telegramMessageId: string;
  telegramUserId: string;
}

export type SoftwareUpdateDecisionClaim =
  | { decisionId: string; proposalId: string; status: "approved" | "declined" }
  | { status: "expired" }
  | { status: "forbidden" };

export interface SoftwareUpdateRepository {
  bindPendingTelegramMessage(
    input: BindSoftwareUpdateTelegramMessageInput,
  ): Promise<"bound" | "rejected">;
  claimDecision(input: ClaimSoftwareUpdateDecisionInput): Promise<SoftwareUpdateDecisionClaim>;
  findCurrentOwner(): Promise<SoftwareUpdateOwner | null>;
  markDeliveryFailure(input: SoftwareUpdateDeliveryFailureInput): Promise<void>;
  prepareProposal(
    input: PrepareSoftwareUpdateProposalInput,
  ): Promise<PrepareSoftwareUpdateProposalResult>;
  recordDecisionUiFailure(input: {
    code: string;
    message: string;
    proposalId: string;
  }): Promise<void>;
}

export interface DeliverSoftwareUpdateProposalInput {
  callbackToken: string;
  owner: SoftwareUpdateOwner;
  proposalId: string;
  release: SoftwareRelease;
}

export interface SoftwareUpdateTelegramTransport {
  answerCallback(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text: string;
  }): Promise<void>;
  editProposal(input: {
    chatId: string;
    messageId: string;
    replyMarkup: Readonly<Record<string, unknown>>;
    text: string;
  }): Promise<void>;
  removeKeyboard(input: { chatId: string; messageId: string }): Promise<void>;
  sendPlaceholder(input: { chatId: string; text: string }): Promise<{
    chatId: string;
    chatType: "private";
    messageId: string;
  }>;
}
