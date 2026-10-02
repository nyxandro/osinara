import { describe, expect, it } from "vitest";

import {
  normalizeReferenceCalls,
  packReferenceFile,
  type ReferenceCall,
  unpackReferenceFile,
} from "./model-request-reference.js";

const SESSION = "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR";
const OTHER_SESSION = "wrun_01M3YNG3S1T7CPBD0TV0GEZHXC";
const FAMILY = "6e9f3db8-0c56-453a-b8a7-aaf458f4baeb";

function call(request: unknown, agent: ReferenceCall["agent"] = "root"): ReferenceCall {
  return { agent, kind: "stream", request };
}

describe("golden model request normalization", () => {
  it("keeps equal run-specific values equal and different ones different across a scenario", () => {
    const [first, second] = normalizeReferenceCalls([
      call({ prompt: [{ role: "user", content: `session ${SESSION} family ${FAMILY} at 2026-10-02T03:00:07.000Z` }] }),
      call({ prompt: [{ role: "user", content: `session ${OTHER_SESSION} then ${SESSION}, marker 642c7813a29361ae8861585d` }] }),
    ]);

    expect(first!.request).toEqual({ prompt: [{ role: "user", content: "session <id-1> family <uuid-1> at <time-1>" }] });
    expect(second!.request).toEqual({ prompt: [{ role: "user", content: "session <id-2> then <id-1>, marker <hex-1>" }] });
  });

  it("replaces a prefixed hex reference as one value, not as its hex tail", () => {
    const [normalized] = normalizeReferenceCalls([call({ text: "mem_6bd86ca56e09db278e14a24b13b1b050 and 6bd86ca56e09db278e14a24b13b1b050" })]);

    expect(normalized!.request).toEqual({ text: "<ref-1> and <hex-1>" });
  });

  it("replaces AI SDK generated ids and local wall-clock times", () => {
    const [normalized] = normalizeReferenceCalls([call({
      text: '{"requestId":"aitxt-s5xKwNFIo4bzcXoWCejMFcMS"} scheduled_for_local: 2026-10-02 19:10:40 Europe/Moscow',
    })]);

    expect(normalized!.request).toEqual({ text: '{"requestId":"<aisdk-1>"} scheduled_for_local: <local-time-1> Europe/Moscow' });
  });

  it("leaves stable content untouched", () => {
    const request = { prompt: [{ role: "system", content: "Instructions (instructions)\nchat_id: 912\nmessage_id: 1" }], toolChoice: { type: "auto" } };

    expect(normalizeReferenceCalls([call(request)])[0]!.request).toEqual(request);
  });
});

describe("golden model request file", () => {
  const system = { role: "system", content: "Instructions (instructions)\nlong prompt" };
  const tools = [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: {}, timeout: {} } } }];
  const calls = [
    call({ tools, toolChoice: { type: "auto" }, prompt: [system, { role: "user", content: "first" }] }),
    call({ tools, toolChoice: { type: "auto" }, prompt: [system, { role: "user", content: "second" }] }, "child"),
    call({ tools: [], toolChoice: { type: "none" }, prompt: [{ role: "system", content: "other" }] }),
  ];

  it("stores each shared system prompt and tool set once and restores the exact requests", () => {
    const file = packReferenceFile("private-first", calls);

    expect(Object.keys(file.shared)).toEqual(["tools-1", "system-1", "tools-2", "system-2"]);
    expect(JSON.stringify(unpackReferenceFile(JSON.parse(JSON.stringify(file))))).toBe(JSON.stringify(calls));
  });

  it("rejects a request that already contains the shared-value marker", () => {
    expect(() => packReferenceFile("broken", [call({ prompt: [{ $shared: "system-1" }] })]))
      .toThrow("TEST_REFERENCE_SHARED_KEY_COLLISION");
  });

  it("fails on a reference to a missing shared value", () => {
    expect(() => unpackReferenceFile({ scenario: "broken", shared: {}, calls: [call({ tools: { $shared: "tools-9" } })] }))
      .toThrow("TEST_REFERENCE_SHARED_MISSING");
  });
});
