import { describe, expect, it } from "vitest";

import { memoryToolState } from "../session/tool-state.test-fixtures.js";
import { executeBashOnSandbox } from "./bash.js";
import { executeGlobOnSandbox } from "./glob.js";
import { executeGrepOnSandbox } from "./grep.js";
import { loadSkill } from "./load-skill.js";
import { executeReadFileOnSandbox } from "./read-file.js";
import { executeTodoTool } from "./todo.js";
import { executeWriteFileOnSandbox } from "./write-file.js";

// A sandbox with a home directory and in-memory files; other commands answer as scripted.
function fakeSandbox(files: Record<string, string> = {}, home = "/home/agent", command?: (line: string) => { exitCode: number; stderr: string; stdout: string }) {
  const contents = new Map(Object.entries(files));
  return {
    contents,
    sandbox: {
      id: "sandbox-1",
      async readTextFile({ path }: { path: string }) { return contents.get(path) ?? null; },
      async run({ command: line }: { command: string }) {
        if (line === `printf '%s\\n' "$HOME"`) return { exitCode: 0, stderr: "", stdout: `${home}\n` };
        if (command) return command(line);
        throw new Error(`TEST_UNEXPECTED_COMMAND: ${line}`);
      },
      async writeTextFile({ content, path }: { content: string; path: string }) { contents.set(path, content); },
    },
  };
}

describe("read_file and write_file", () => {
  it("numbers lines and records what was read, so the file may then be overwritten", async () => {
    const { contents, sandbox } = fakeSandbox({ "/home/agent/notes.txt": "один\nдва\n" });
    const tool = memoryToolState();

    expect(await executeReadFileOnSandbox(sandbox, tool.state, { filePath: "$HOME/notes.txt" }))
      .toEqual({ content: "1: один\n2: два", path: "/home/agent/notes.txt", totalLines: 2, truncated: false });
    expect(await executeWriteFileOnSandbox(sandbox, tool.state, { content: "три\n", filePath: "/home/agent/notes.txt" }))
      .toEqual({ existed: true, path: "/home/agent/notes.txt" });
    expect(contents.get("/home/agent/notes.txt")).toBe("три\n");
  });

  it("refuses to overwrite a file the model has not read, or that changed after it read it", async () => {
    const { contents, sandbox } = fakeSandbox({ "/workspace/a.txt": "старое" });
    const tool = memoryToolState();

    await expect(executeWriteFileOnSandbox(sandbox, tool.state, { content: "x", filePath: "/workspace/a.txt" }))
      .rejects.toThrow("You must read file /workspace/a.txt before overwriting it. Use the read_file tool first.");
    await executeReadFileOnSandbox(sandbox, tool.state, { filePath: "/workspace/a.txt" });
    contents.set("/workspace/a.txt", "чужая правка");
    await expect(executeWriteFileOnSandbox(sandbox, tool.state, { content: "x", filePath: "/workspace/a.txt" }))
      .rejects.toThrow("File /workspace/a.txt has been modified since it was last read.");
  });

  it("creates a new file without a prior read and lets the next write follow it", async () => {
    const { sandbox } = fakeSandbox();
    const tool = memoryToolState();

    expect(await executeWriteFileOnSandbox(sandbox, tool.state, { content: "v1", filePath: "/workspace/new.txt" })).toEqual({ existed: false, path: "/workspace/new.txt" });
    expect(await executeWriteFileOnSandbox(sandbox, tool.state, { content: "v2", filePath: "/workspace/new.txt" })).toEqual({ existed: true, path: "/workspace/new.txt" });
  });

  it("pages a long file and never records a read that failed", async () => {
    const { sandbox } = fakeSandbox({ "/workspace/long.txt": Array.from({ length: 5 }, (_, index) => `l${index + 1}`).join("\n") });
    const tool = memoryToolState();

    expect(await executeReadFileOnSandbox(sandbox, tool.state, { filePath: "/workspace/long.txt", limit: 2, offset: 2 }))
      .toEqual({ content: "2: l2\n3: l3", nextOffset: 4, path: "/workspace/long.txt", totalLines: 5, truncated: true });
    const fresh = memoryToolState();
    await expect(executeReadFileOnSandbox(sandbox, fresh.state, { filePath: "/workspace/long.txt", offset: 9 }))
      .rejects.toThrow("offset 9 is past the end of the file (5 lines).");
    expect(fresh.stamps.size).toBe(0);
    await expect(executeReadFileOnSandbox(sandbox, fresh.state, { filePath: "relative.txt" })).rejects.toThrow("filePath must be an absolute path.");
  });
});

describe("todo", () => {
  it("replaces the whole list and returns it with counts; without todos it only reads", async () => {
    const tool = memoryToolState();
    const items = [
      { content: "проверить", priority: "high" as const, status: "in_progress" as const },
      { content: "готово", priority: "low" as const, status: "completed" as const },
    ];

    expect(await executeTodoTool(tool.state, { todos: items })).toEqual({
      counts: { cancelled: 0, completed: 1, in_progress: 1, pending: 0, total: 2 }, todos: items,
    });
    expect(await executeTodoTool(tool.state, {})).toEqual({ counts: expect.objectContaining({ total: 2 }), todos: items });
    expect(await executeTodoTool(memoryToolState().state, {})).toEqual({
      counts: { cancelled: 0, completed: 0, in_progress: 0, pending: 0, total: 0 }, todos: [],
    });
  });
});

describe("load_skill", () => {
  function context(skills: string[], files: Record<string, string>, home = "/home/agent") {
    const { sandbox } = fakeSandbox(files, home);
    return { getSandbox: async () => sandbox, skills } as never;
  }

  it("loads a listed skill from the sandbox skill root without its front matter", async () => {
    const ctx = context(["pohuy"], { "/home/agent/.agents/skills/pohuy/SKILL.md": "---\nname: pohuy\n---\nОтвечай прямо." });

    expect(await loadSkill.execute({ skill: "pohuy" }, ctx)).toBe("Отвечай прямо.");
  });

  it("names the available skills when asked for another one", async () => {
    await expect(loadSkill.execute({ skill: "secret" }, context(["pohuy", "digest"], {})))
      .rejects.toThrow('No skill named "secret". Available skills: digest, pohuy.');
  });

  it("uses the documented /workspace/skills root when the sandbox has no usable home", async () => {
    const ctx = context(["pohuy"], { "/workspace/skills/pohuy/SKILL.md": "текст" }, "");

    expect(await loadSkill.execute({ skill: "pohuy" }, ctx)).toBe("текст");
  });
});

describe("bash", () => {
  it("keeps the tail of a long output and says how much was cut", async () => {
    const stdout = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
    const { sandbox } = fakeSandbox({}, "/home/agent", () => ({ exitCode: 3, stderr: "warn", stdout }));

    const result = await executeBashOnSandbox(sandbox, { command: "seq" });

    expect(result).toMatchObject({ exitCode: 3, stderr: "warn", truncated: true });
    expect(result.stdout).toMatch(/^\[stdout truncated: showing last 2000 of 2500 lines\]\nline 501\n/u);
    expect(result.stdout.endsWith("line 2500")).toBe(true);
  });
});

describe("glob and grep", () => {
  function searchSandbox(id: string, ripgrep: boolean, output: string) {
    const commands: string[] = [];
    const { sandbox } = fakeSandbox({}, "/home/agent", (line) => {
      commands.push(line);
      if (line.startsWith("command -v rg")) return ripgrep ? { exitCode: 1, stderr: "", stdout: "" } : { exitCode: 127, stderr: "", stdout: "" };
      return { exitCode: 0, stderr: "", stdout: output };
    });
    return { commands, sandbox: { ...sandbox, id } };
  }

  it("lists files with ripgrep, quoting the pattern and the path", async () => {
    const { commands, sandbox } = searchSandbox("glob-rg", true, "/workspace/a.ts\n/workspace/b.ts\n");

    expect(await executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }))
      .toEqual({ content: "/workspace/a.ts\n/workspace/b.ts", count: 2, path: "/workspace", truncated: false });
    expect(commands.at(-1)).toBe("rg --files --hidden --glob '!.git/*' --glob '**/*.ts' '/workspace'");
  });

  it("falls back to POSIX grep without ripgrep and counts the matching lines", async () => {
    const { commands, sandbox } = searchSandbox("grep-posix", false, "/workspace/a.ts:3:const x = 1\n/workspace/b.ts:9:const y = 2\n");

    expect(await executeGrepOnSandbox(sandbox, { ignoreCase: true, pattern: "const" })).toMatchObject({ matchCount: 2, truncated: false });
    expect(commands.at(-1)).toBe("grep -r -n --exclude-dir=.git -i -E -m 100 -e 'const' '/workspace'");
  });
});
