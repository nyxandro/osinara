/**
 * Persistent workspace PostgreSQL/filesystem integration tests.
 *
 * Constructs covered:
 * - Personal, family, and external-group isolation.
 * - Filesystem-first discovery, binary persistence, explicit cross-scope move, and deletion.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createWorkspaceDeletionWorker } from "./workspace-deletion.js";
import { createWorkspaceBinaryRepository } from "./workspace-binary-repository.js";
import { createWorkspaceFileDeliveryRepository } from "./workspace-file-delivery-repository.js";
import { createWorkspaceRepository } from "./workspace-repository.js";
import {
  listWorkspaceStoredFiles,
  readWorkspaceFile,
  workspaceDirectory,
  writeWorkspaceFile,
} from "./workspace-storage.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const roots: string[] = [];

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Workspace') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('workspace-owner', 'Владелец'), ('workspace-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const id = (telegramId: string) => users.rows.find((row) => row.telegram_user_id === telegramId)!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, id("workspace-owner"), id("workspace-member")],
  );
  const groups = await database().query<{ id: string; type: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-family-workspace', 'Семья', 'family_private', 'addressed_only'),
            ($1, '-100-external-workspace', 'Проект', 'external_private', 'addressed_only')
     RETURNING id, type`,
    [family.rows[0]!.id],
  );
  return {
    externalGroupId: groups.rows.find((row) => row.type === "external_private")!.id,
    familyGroupId: groups.rows.find((row) => row.type === "family_private")!.id,
    familyId: family.rows[0]!.id,
    memberId: id("workspace-member"),
    ownerId: id("workspace-owner"),
  };
}

describeWithDatabase("workspace repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE workspace_file_deliveries, workspace_deletion_jobs, workspace_operations, workspaces, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  afterAll(async () => closeDatabase());

  it("keeps personal files private while exposing one shared family mount", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const owner = {
      familyId: f.familyId,
      groupId: null,
      groupType: null,
      role: "owner" as const,
      telegramChatType: "private" as const,
      userId: f.ownerId,
    };
    const member = { ...owner, role: "member" as const, userId: f.memberId };

    const ownerMounts = await repository.mounts(owner);
    const ownerPersonal = ownerMounts.find((mount) => mount.mountPoint === "personal")!;
    const memberMounts = await repository.mounts(member);
    const memberPersonal = memberMounts.find((mount) => mount.mountPoint === "personal")!;
    await writeWorkspaceFile(root, ownerPersonal.workspaceId, "notes/private.txt", Buffer.from("секрет владельца"));
    await expect(listWorkspaceStoredFiles(root, memberPersonal.workspaceId)).resolves.toEqual([]);

    const ownerFamily = ownerMounts.find((mount) => mount.mountPoint === "family")!;
    await writeWorkspaceFile(
      root,
      ownerFamily.workspaceId,
      "shared/visible.txt",
      Buffer.from("общий файл"),
    );
    const memberFamily = memberMounts.find((mount) => mount.mountPoint === "family")!;
    await expect(readWorkspaceFile(root, memberFamily.workspaceId, "shared/visible.txt"))
      .resolves.toEqual(Buffer.from("общий файл"));
  });

  it("preserves exact binary bytes and media type for Telegram files", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const binaries = createWorkspaceBinaryRepository(root, repository);
    const owner = {
      familyId: f.familyId,
      groupId: null,
      groupType: null,
      role: "owner" as const,
      telegramChatType: "private" as const,
      userId: f.ownerId,
    };
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf9sAAAAASUVORK5CYII=",
      "base64",
    );

    const stored = await binaries.writeBinary(owner, {
      bytes,
      mediaType: "image/png",
      operationKey: "binary-write",
      path: "inbox/10/image.png",
      scope: "personal",
    });
    const read = await binaries.readBinary(owner, "personal", stored.path);
    expect(stored).toMatchObject({ byteSize: bytes.byteLength, mediaType: "image/png" });
    expect(typeof stored.updatedAt).toBe("string");
    expect(read.bytes).toEqual(bytes);
    expect(read.file).toMatchObject({ mediaType: "image/png", path: stored.path });
    expect(typeof read.file.updatedAt).toBe("string");
  });

  it("reserves one Telegram delivery and replays its completed result without resending", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const binaries = createWorkspaceBinaryRepository(root, repository);
    const deliveries = createWorkspaceFileDeliveryRepository(binaries);
    const owner = {
      familyId: f.familyId,
      groupId: null,
      groupType: null,
      role: "owner" as const,
      telegramChatType: "private" as const,
      userId: f.ownerId,
    };
    await binaries.writeBinary(owner, {
      bytes: Buffer.from("document"),
      mediaType: "text/plain",
      operationKey: "delivery-file-write",
      path: "out/report.txt",
      scope: "personal",
    });

    const first = await deliveries.begin(owner, {
      chatId: "101",
      operationKey: "delivery-operation",
      path: "out/report.txt",
      presentation: "document",
      scope: "personal",
    });
    expect(first.status).toBe("reserved");
    await deliveries.complete("delivery-operation", "77");
    const replay = await deliveries.begin(owner, {
      chatId: "101",
      operationKey: "delivery-operation",
      path: "out/report.txt",
      presentation: "document",
      scope: "personal",
    });

    expect(replay).toEqual({ status: "completed", telegramMessageId: "77" });
  });

  it("isolates an external group and deletes its physical file", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const external = {
      familyId: f.familyId,
      groupId: f.externalGroupId,
      groupType: "external_private" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const groupMount = (await repository.mounts(external))[0]!;
    await writeWorkspaceFile(root, groupMount.workspaceId, "project/data.txt", Buffer.from("данные проекта"));
    await repository.deleteFile(external, "group", "project/data.txt", "delete-group");
    await expect(listWorkspaceStoredFiles(root, groupMount.workspaceId)).resolves.toEqual([]);
  });

  it("physically deletes a group workspace after its trust zone is removed", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const external = {
      familyId: f.familyId,
      groupId: f.externalGroupId,
      groupType: "external_private" as const,
      role: "owner" as const,
      telegramChatType: "supergroup" as const,
      userId: f.ownerId,
    };
    const groupMount = (await repository.mounts(external))[0]!;
    await writeWorkspaceFile(root, groupMount.workspaceId, "project/private.txt", Buffer.from("удаляемые данные"));
    const workspace = await database().query<{ id: string }>(
      "SELECT id FROM workspaces WHERE group_id = $1",
      [f.externalGroupId],
    );
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [f.externalGroupId]);

    const deleteToolEnvironment = vi.fn(async () => undefined);
    await expect(createWorkspaceDeletionWorker(root, deleteToolEnvironment)()).resolves.toBe(1);
    expect(deleteToolEnvironment).toHaveBeenCalledWith(workspace.rows[0]!.id);
    await expect(access(workspaceDirectory(root, workspace.rows[0]!.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(database().query("SELECT * FROM workspace_deletion_jobs"))
      .resolves.toMatchObject({ rowCount: 0 });
  });

  it("uses shell-created files directly without a database synchronization step", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-"));
    roots.push(root);
    const repository = createWorkspaceRepository(root);
    const owner = {
      familyId: f.familyId,
      groupId: null,
      groupType: null,
      role: "owner" as const,
      telegramChatType: "private" as const,
      userId: f.ownerId,
    };
    const mounts = await repository.mounts(owner);
    const personal = mounts.find((mount) => mount.mountPoint === "personal")!;
    const directory = workspaceDirectory(root, personal.workspaceId);
    await mkdir(join(directory, "shell"), { recursive: true });
    await writeFile(join(directory, "shell", "notes.txt"), "индексируемая заметка");
    await writeFile(join(directory, "shell", "executable"), "#!/bin/sh\nprintf ready\n");

    await expect(listWorkspaceStoredFiles(root, personal.workspaceId)).resolves.toEqual([
      expect.objectContaining({ path: "shell/executable" }),
      expect.objectContaining({ path: "shell/notes.txt" }),
    ]);
    await expect(readWorkspaceFile(root, personal.workspaceId, "shell/notes.txt"))
      .resolves.toEqual(Buffer.from("индексируемая заметка"));
    await expect(readWorkspaceFile(root, personal.workspaceId, "shell/executable"))
      .resolves.toEqual(Buffer.from("#!/bin/sh\nprintf ready\n"));

    const deliveries = createWorkspaceFileDeliveryRepository(
      createWorkspaceBinaryRepository(root, repository),
    );
    await expect(deliveries.begin(owner, {
      chatId: "101",
      operationKey: "shell-file-delivery",
      path: "shell/notes.txt",
      presentation: "document",
      scope: "personal",
    })).resolves.toMatchObject({
      file: { path: "shell/notes.txt" },
      status: "reserved",
    });
  });
});
