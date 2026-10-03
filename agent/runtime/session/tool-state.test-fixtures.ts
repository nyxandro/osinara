/**
 * In-memory session tool state for unit tests of tools that read or write it.
 *
 * Export:
 * - `memoryToolState`: a `SessionToolState` over plain maps, with the maps exposed for assertions.
 *
 * Test-only: imported by `*.test.ts` files, never by runtime code.
 */
import type { ReadFileStamp, SessionToolState, TodoState } from "./tool-state.js";

export function memoryToolState(initial: { todo?: TodoState } = {}) {
  const stamps = new Map<string, ReadFileStamp>();
  let todo: TodoState | null = initial.todo ?? null;
  const state: SessionToolState = {
    readTodo: async () => todo,
    writeTodo: async (next) => { todo = next; },
    readFileStamp: async (path) => stamps.get(path),
    writeFileStamp: async (path, stamp) => { stamps.set(path, stamp); },
  };
  return { stamps, state, todo: () => todo };
}
