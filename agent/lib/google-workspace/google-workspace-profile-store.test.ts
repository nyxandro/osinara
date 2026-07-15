/**
 * Native gws profile storage tests.
 *
 * Constructs covered:
 * - Credentials are atomically materialized in the exact workspace directory with private modes.
 * - Removing one profile cannot affect a sibling workspace profile.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGoogleWorkspaceProfileStore } from "./google-workspace-profile-store.js";

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Google Workspace profile store", () => {
  it("writes an authorized-user profile with private filesystem modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-gws-profiles-"));
    roots.push(root);
    const store = createGoogleWorkspaceProfileStore(root);

    await store.write(PERSONAL_WORKSPACE_ID, {
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-secret",
      type: "authorized_user",
    });

    const directory = join(root, PERSONAL_WORKSPACE_ID);
    const credentials = join(directory, "credentials.json");
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-secret",
      type: "authorized_user",
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  });

  it("removes only the selected workspace profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-gws-profiles-"));
    roots.push(root);
    const store = createGoogleWorkspaceProfileStore(root);
    const credentials = {
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-secret",
      type: "authorized_user" as const,
    };
    await store.write(PERSONAL_WORKSPACE_ID, credentials);
    await store.write(FAMILY_WORKSPACE_ID, credentials);

    await store.remove(PERSONAL_WORKSPACE_ID);

    await expect(stat(join(root, PERSONAL_WORKSPACE_ID))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, FAMILY_WORKSPACE_ID, "credentials.json"))).resolves.toBeDefined();
  });

  it("rejects an untrusted workspace path before filesystem access", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-gws-profiles-"));
    roots.push(root);
    const store = createGoogleWorkspaceProfileStore(root);

    await expect(store.write("../family", {
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-secret",
      type: "authorized_user",
    })).rejects.toThrow();
  });
});
