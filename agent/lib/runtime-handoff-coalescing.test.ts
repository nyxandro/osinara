/** The pinned Eve coalescer must retain only receipts of deliveries actually consumed. */
import { describe, expect, it } from "vitest";
import { coalesceDeliveries } from "../../node_modules/eve/dist/src/harness/messages.js";

describe("native handoff coalescing", () => {
  it("keeps earlier handoff IDs when a real user response supplies the last auth", () => {
    const first = { authenticator: "telegram", principalId: "first", principalType: "user" as const,
      attributes: { osinaraRuntimeHandoffIds: ["one", "two"] } };
    const last = { authenticator: "telegram", principalId: "last", principalType: "user" as const,
      attributes: { role: "member" } };
    const result = coalesceDeliveries([{ kind: "deliver", auth: first, payloads: [] }, { kind: "deliver", auth: last, payloads: [] }]);
    expect(result.auth).toEqual({ ...last, attributes: { role: "member", osinaraRuntimeHandoffIds: ["one", "two"] } });
    expect(last.attributes).toEqual({ role: "member" });
  });
  it("does not manufacture authentication for an anonymous merged delivery", () => {
    const first = { authenticator: "telegram", principalId: "first", principalType: "user" as const,
      attributes: { osinaraRuntimeHandoffIds: ["one"] } };
    expect(coalesceDeliveries([{ kind: "deliver", auth: first, payloads: [] }, { kind: "deliver", auth: null, payloads: [] }]).auth).toBeNull();
  });
});
