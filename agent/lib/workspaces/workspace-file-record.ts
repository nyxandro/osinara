/**
 * JSON-safe filesystem workspace file metadata contract.
 *
 * Exports:
 * - `WorkspaceScope`: authorized persistent file areas.
 * - `WorkspaceFileRecord`: metadata calculated from the current physical file.
 * - `createWorkspaceFileRecord`: plain JSON metadata for trusted boundary tools.
 */
export type WorkspaceScope = "family" | "group" | "personal";

export interface WorkspaceFileRecord {
  byteSize: number;
  contentSha256: string;
  mediaType: string;
  path: string;
  scope: WorkspaceScope;
  updatedAt: string;
}

export function createWorkspaceFileRecord(input: {
  byteSize: number;
  contentSha256: string;
  mediaType: string;
  path: string;
  scope: WorkspaceScope;
  updatedAt: Date;
}): WorkspaceFileRecord {
  // Eve accepts only plain JSON values, so filesystem timestamps cross as ISO strings.
  return {
    byteSize: input.byteSize,
    contentSha256: input.contentSha256,
    mediaType: input.mediaType,
    path: input.path,
    scope: input.scope,
    updatedAt: input.updatedAt.toISOString(),
  };
}
