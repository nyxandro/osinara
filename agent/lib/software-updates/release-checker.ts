/**
 * Application-owned proactive software update checker.
 *
 * Exports:
 * - `createSoftwareUpdateChecker`: dependency-injected latest-release proposal workflow.
 * - `runSoftwareUpdateCheck`: production six-hour schedule operation.
 */
import { createHash, randomBytes } from "node:crypto";

import { CURRENT_SOFTWARE_VERSION } from "./current-version.js";
import {
  githubSoftwareReleaseClient,
  type GitHubSoftwareReleaseClient,
} from "./github-release-client.js";
import { deliverSoftwareUpdateProposal } from "./proposal-delivery.js";
import { softwareUpdateRepository } from "./repository.js";
import type {
  DeliverSoftwareUpdateProposalInput,
  SoftwareUpdateRepository,
} from "./types.js";

interface SoftwareUpdateCheckerDependencies {
  createCallbackToken(): string;
  currentVersion: string;
  deliverProposal(input: DeliverSoftwareUpdateProposalInput): Promise<void>;
  releaseClient: GitHubSoftwareReleaseClient;
  repository: Pick<SoftwareUpdateRepository, "findCurrentOwner" | "prepareProposal">;
}

export type SoftwareUpdateCheckResult =
  | "duplicate"
  | "no_owner"
  | "no_update"
  | "proposed";

export function createSoftwareUpdateChecker(dependencies: SoftwareUpdateCheckerDependencies) {
  return async function checkSoftwareUpdate(): Promise<SoftwareUpdateCheckResult> {
    const release = await dependencies.releaseClient.latestNewerThan(dependencies.currentVersion);
    if (!release) return "no_update";
    const owner = await dependencies.repository.findCurrentOwner();
    if (!owner) return "no_owner";

    // Only the hash crosses the durable boundary; the random token exists until initial delivery.
    const callbackToken = dependencies.createCallbackToken();
    const prepared = await dependencies.repository.prepareProposal({
      callbackTokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      owner,
      release,
    });
    if (prepared.status === "duplicate") return "duplicate";
    await dependencies.deliverProposal({
      callbackToken,
      owner,
      proposalId: prepared.proposalId,
      release,
    });
    return "proposed";
  };
}

export const runSoftwareUpdateCheck = createSoftwareUpdateChecker({
  createCallbackToken: () => randomBytes(24).toString("base64url"),
  currentVersion: CURRENT_SOFTWARE_VERSION,
  deliverProposal: deliverSoftwareUpdateProposal,
  releaseClient: githubSoftwareReleaseClient,
  repository: softwareUpdateRepository,
});
