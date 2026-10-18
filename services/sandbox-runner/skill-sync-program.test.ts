/** Real filesystem integrity checks, with no Docker or application processes. */
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_SYNC_PROGRAM } from "./skill-sync-program.js";

async function sync(home: string, packages: unknown[], keep?: string[], prefix = "") {
  const process = spawn(globalThis.process.execPath, ["--max-old-space-size=64", "-e", prefix + SKILL_SYNC_PROGRAM], { env: { ...globalThis.process.env, HOME: home } });
  let stdout = "", stderr = "";
  process.stdout.on("data", (data) => { stdout += data; }); process.stderr.on("data", (data) => { stderr += data; });
  process.stdin.end(JSON.stringify({ packages, ...(keep === undefined ? {} : { keep }) }));
  await new Promise<void>((resolve, reject) => { process.on("error", reject); process.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
  return JSON.parse(stdout);
}

describe("verified skill synchronization", () => {
  it("reclaims only its orphaned temporary files after a killed write", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }];
    try {
      await sync(home, packages);
      const root = join(home, ".agents/skills"), folder = join(root, "test");
      await writeFile(join(root, ".osinara-skill-user-note"), "kept");
      packages[0]!.files[0]!.contentBase64 = Buffer.from("updated").toString("base64");
      const prefix = `const testFs=require('node:fs/promises'),testRename=testFs.rename;testFs.rename=async function(from,to){if(String(from).includes('/.osinara-skill-'))process.kill(process.pid,'SIGKILL');return testRename.call(this,from,to)};`;
      await expect(sync(home, packages, undefined, prefix)).rejects.toThrow();
      const leftovers = async () => [...await readdir(root), ...await readdir(folder)].filter(name => /^\.osinara-skill-[0-9a-f]{8}-/u.test(name));
      expect(await leftovers()).toHaveLength(1);
      await sync(home, packages);
      expect(await leftovers()).toHaveLength(0);
      expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("updated");
      expect(await readFile(join(root, ".osinara-skill-user-note"), "utf8")).toBe("kept");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("repairs an oversized managed file without reading gigabytes into memory", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
    try {
      await sync(home, packages);
      const path = join(home, ".agents/skills/test/SKILL.md");
      await truncate(path, 4 * 1024 ** 3);
      expect((await sync(home, packages)).written).toBe(1);
      expect(await readFile(path, "utf8")).toBe("reviewed");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("preserves supporting filenames when UTF-8 characters cross stdin chunks", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [
      { path: "SKILL.md", contentBase64: "b2s=" }, { path: "данные.txt", contentBase64: "b2s=" },
    ] }];
    const bytes = Buffer.from(JSON.stringify({ packages }));
    const split = bytes.indexOf(Buffer.from("данные")) + 1;
    const prefix = `Object.defineProperty(process,'stdin',{value:require('node:stream').Readable.from([Buffer.from('${bytes.subarray(0, split).toString("base64")}','base64'),Buffer.from('${bytes.subarray(split).toString("base64")}','base64')])});`;
    try {
      await sync(home, packages, undefined, prefix);
      expect(await readFile(join(home, ".agents/skills/test/данные.txt"), "utf8")).toBe("ok");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("does not follow a parent directory swapped to a symlink after it was opened", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }];
    try {
      await sync(home, packages);
      const original = join(home, ".agents/skills/test"), moved = join(home, "moved"), outside = join(home, "outside");
      await mkdir(outside); await writeFile(join(outside, "SKILL.md"), "private");
      const prefix = `const testFs=require('node:fs/promises'),testOpen=testFs.open;let testSwapped=false;testFs.open=async function(path,...args){const handle=await testOpen.call(this,path,...args);if(!testSwapped&&String(path).endsWith('/test')){testSwapped=true;await testFs.rename(${JSON.stringify(original)},${JSON.stringify(moved)});await testFs.symlink(${JSON.stringify(outside)},${JSON.stringify(original)});}return handle;};`;
      await expect(sync(home, packages, undefined, prefix)).rejects.toThrow("AGENT_SKILL_SYNC_PATH_CHANGED");
      expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe("private");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("leaves a written package as an exact copy and keeps other skills when nothing is to be tidied", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const root = join(home, ".agents/skills");
    const packages = [{ name: "test", files: [
      { path: "SKILL.md", contentBase64: Buffer.from("v2").toString("base64") },
      { path: "scripts/run.py", contentBase64: Buffer.from("print()").toString("base64") },
    ] }];
    try {
      await sync(home, [{ name: "other", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }]);
      await mkdir(join(root, "test/scripts"), { recursive: true });
      await mkdir(join(root, "test/references/old"), { recursive: true });
      await writeFile(join(root, "test/scripts/removed-in-v2.py"), "old");
      await writeFile(join(root, "test/references/old/notes.md"), "old");
      await writeFile(join(root, "test/added-by-model.sh"), "echo");
      expect((await sync(home, packages)).removed).toBe(3);
      expect((await readdir(join(root, "test"))).sort()).toEqual(["SKILL.md", "scripts"]);
      expect(await readdir(join(root, "test/scripts"))).toEqual(["run.py"]);
      // Without a keep list a delegated child only adds: another skill stays.
      expect(await readdir(root)).toContain("other");
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("removes every skill root entry outside the keep list, without following symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const root = join(home, ".agents/skills");
    const outside = join(home, "outside");
    try {
      await sync(home, [{ name: "granted", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }]);
      await mkdir(join(root, "native-skill-authoring"));
      await writeFile(join(root, "native-skill-authoring/SKILL.md"), "stale");
      await writeFile(join(root, "stray.txt"), "stray");
      await mkdir(outside); await writeFile(join(outside, "private.txt"), "private");
      await symlink(outside, join(root, "linked"));
      expect(await sync(home, [], ["granted"])).toEqual({ checked: 0, written: 0, removed: 3 });
      expect(await readdir(root)).toEqual(["granted"]);
      expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("private");
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("refuses a keep list holding something that is not a skill name", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    try {
      await expect(sync(home, [], ["../escape"])).rejects.toThrow("AGENT_SKILL_SYNC_NAME_INVALID");
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("does not rewrite intact files, repairs tampering, and removes skills no longer granted only", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
    try {
      expect(await sync(home, packages)).toEqual({ checked: 1, written: 1, removed: 0 });
      const path = join(home, ".agents/skills/test/SKILL.md");
      const first = await stat(path);
      expect(await sync(home, packages)).toEqual({ checked: 1, written: 0, removed: 0 });
      expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);
      await writeFile(path, "tampered");
      expect((await sync(home, packages)).written).toBe(1);
      expect(await readFile(path, "utf8")).toBe("reviewed");
      await writeFile(join(home, "user-data.txt"), "kept");
      expect((await sync(home, [], [])).removed).toBe(1);
      expect(await readFile(join(home, "user-data.txt"), "utf8")).toBe("kept");
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("replaces a symlink with the reviewed file without reading or overwriting its target", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    try {
      const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
      await sync(home, packages);
      const path = join(home, ".agents/skills/test/SKILL.md");
      const target = join(home, "private-data"); await writeFile(target, "secret");
      await rm(path); await symlink(target, path);
      await sync(home, packages);
      expect((await lstat(path)).isFile()).toBe(true);
      expect(await readFile(path, "utf8")).toBe("reviewed");
      expect(await readFile(target, "utf8")).toBe("secret");
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("writes a version where a file became a folder, a folder a file, or the skill directory a link", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const root = join(home, ".agents/skills");
    const outside = join(home, "outside");
    const file = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text).toString("base64") });
    try {
      await sync(home, [{ name: "test", files: [file("SKILL.md", "v1"), file("templates", "flat"), file("data/a.md", "a")] }]);
      await sync(home, [{ name: "test", files: [file("SKILL.md", "v2"), file("templates/a.md", "nested"), file("data", "flat")] }], ["test"]);
      expect(await readFile(join(root, "test/templates/a.md"), "utf8")).toBe("nested");
      expect(await readFile(join(root, "test/data"), "utf8")).toBe("flat");

      await mkdir(outside); await writeFile(join(outside, "SKILL.md"), "private");
      await rm(join(root, "test"), { recursive: true }); await symlink(outside, join(root, "test"));
      await symlink(outside, join(root, "kept-link"));
      await sync(home, [{ name: "test", files: [file("SKILL.md", "v3")] }], ["test", "kept-link"]);
      expect((await lstat(join(root, "test"))).isDirectory()).toBe(true);
      expect(await readFile(join(root, "test/SKILL.md"), "utf8")).toBe("v3");
      expect(await readdir(root)).toEqual(["test"]);
      expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe("private");
    } finally { await rm(home, { force: true, recursive: true }); }
  });
});
