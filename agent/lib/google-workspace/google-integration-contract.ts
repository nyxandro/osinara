/**
 * Workspace-bound Google integration contracts.
 *
 * Exports:
 * - `GoogleIntegrationScope`: personal or family Google profile boundary.
 * - `GoogleIntegrationAuthorization`: verified actor and exact personal/family workspace.
 * - `ClaimedGoogleAuthorization`: one-time OAuth claim bound to the target workspace.
 * - `GoogleIntegrationAccount`: safe connected-account metadata.
 * - `DecryptedGoogleAccount`: internal credential material used to provision native gws.
 */
import type { FamilyRole } from "../family-access.js";

export type GoogleIntegrationScope = "family" | "personal";

export interface GoogleIntegrationAuthorization {
  familyId: string;
  role: FamilyRole;
  scope: GoogleIntegrationScope;
  telegramUserId: string;
  userId: string;
  workspaceId: string;
}

export interface ClaimedGoogleAuthorization {
  actorUserId: string;
  authorizationId: string;
  familyId: string;
  scope: GoogleIntegrationScope;
  telegramUserId: string;
  workspaceId: string;
}

export interface GoogleIntegrationAccount {
  displayName: string;
  externalAccountId: string;
  id: string;
  isDefault: boolean;
  status: "active" | "reauth_required" | "revoked";
}

export interface DecryptedGoogleAccount extends GoogleIntegrationAccount {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  scopes: string[];
}
