import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database.js", () => ({ database: () => ({ query: state.query }) }));
import { withRuntimeAdmission } from "./runtime-maintenance.js";

it("releases completed background work after a transient cleanup disconnect without executing it twice", async () => {
  state.query.mockReset();
  state.query.mockImplementationOnce(async (_sql, args) => ({ rows: [{ phase: "ready", id: args[0] }] }))
    .mockRejectedValueOnce(Object.assign(new Error("database restarting"), { code: "57P03" }))
    .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  const work = vi.fn().mockResolvedValue("done");
  await expect(withRuntimeAdmission("ordinary", work)).resolves.toBe("done");
  expect(work).toHaveBeenCalledOnce();
  // The recovery probe carries its own read timeout now, so it is a query config, not bare text.
  expect(state.query.mock.calls[2]?.[0]).toMatchObject({ text: "SELECT 1" });
  expect(state.query.mock.calls[3]?.[0]).toContain("DELETE FROM runtime_admission_holders");
});

it("removes its acknowledged-or-not holder when recovery observes draining before work starts", async () => {
  state.query.mockReset();
  let holder: string | undefined;
  state.query.mockImplementationOnce(async (_sql,args) => {
    holder=args[0];
    throw Object.assign(new Error("commit acknowledgement lost"),{ code: "08006" });
  }).mockResolvedValueOnce({ rows: [{ ok: 1 }] })
    .mockResolvedValueOnce({ rows: [{ phase: "draining",id: null }] })
    .mockResolvedValueOnce({ rows: [],rowCount: 1 });
  const work=vi.fn();
  expect(await withRuntimeAdmission("ordinary",work)).toBeNull();
  expect(work).not.toHaveBeenCalled();
  expect(state.query.mock.calls.at(-1)?.[0]).toContain("DELETE FROM runtime_admission_holders");
  expect(state.query.mock.calls.at(-1)?.[1][0]).toBe(holder);
});
