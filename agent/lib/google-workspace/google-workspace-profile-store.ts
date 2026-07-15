/**
 * Native gws credential profile storage.
 *
 * Exports:
 * - `GoogleWorkspaceAuthorizedUserCredentials`: exact gws authorized-user credential contract.
 * - `createGoogleWorkspaceProfileStore`: atomic workspace-profile writer/remover.
 * - `googleWorkspaceProfileStore`: production store backed by its dedicated Docker volume.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

const DIRECTORY_MODE = 0o700;
const CREDENTIAL_MODE = 0o600;
const workspaceIdSchema = z.uuid();

export interface GoogleWorkspaceAuthorizedUserCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: "authorized_user";
}

function workspaceDirectory(root: string, workspaceId: string): string {
  return join(root, workspaceIdSchema.parse(workspaceId));
}

export function createGoogleWorkspaceProfileStore(root: string) {
  return {
    async remove(workspaceId: string): Promise<void> {
      await rm(workspaceDirectory(root, workspaceId), { force: true, recursive: true });
    },

    async write(
      workspaceId: string,
      credentials: GoogleWorkspaceAuthorizedUserCredentials,
    ): Promise<void> {
      const directory = workspaceDirectory(root, workspaceId);
      await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
      await chmod(directory, DIRECTORY_MODE);

      // A same-volume rename ensures gws never observes a partially written refresh token.
      const destination = join(directory, "credentials.json");
      const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
          flag: "wx",
          mode: CREDENTIAL_MODE,
        });
        await rename(temporary, destination);
        await chmod(destination, CREDENTIAL_MODE);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

export const googleWorkspaceProfileStore = createGoogleWorkspaceProfileStore(
  resolve("google-workspace-credentials"),
);
