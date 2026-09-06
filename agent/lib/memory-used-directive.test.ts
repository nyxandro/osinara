/**
 * `<memory-used>` directive tests.
 *
 * Constructs covered:
 * - A trailing directive is removed and its valid refs returned once each.
 * - A directive between words leaves readable text; malformed refs are ignored.
 * - Text without a directive is untouched; an empty directive counts as declared.
 */
import { describe, expect, it } from "vitest";

import { extractMemoryUsedDirective } from "./memory-used-directive.js";

const A = "mem_0123456789abcdef0123456789abcdef";
const B = "mem_fedcba9876543210fedcba9876543210";

describe("extractMemoryUsedDirective", () => {
  it("strips the trailing directive and returns unique valid refs", () => {
    expect(extractMemoryUsedDirective(`Гоша живёт дома.\n<memory-used>${A}, ${A},${B}</memory-used>`))
      .toEqual({ declared: true, memoryRefs: [A, B], message: "Гоша живёт дома." });
  });

  it("drops a directive placed mid-text and ignores malformed refs", () => {
    expect(extractMemoryUsedDirective("Да.<memory-used>x, mem_short</memory-used> Точно."))
      .toEqual({ declared: true, memoryRefs: [], message: "Да. Точно." });
  });

  it("leaves text without a directive untouched", () => {
    expect(extractMemoryUsedDirective("Просто ответ")).toEqual({ declared: false, memoryRefs: [], message: "Просто ответ" });
  });

  it("reports an empty directive as declared with no refs", () => {
    expect(extractMemoryUsedDirective("Ничего не пригодилось.\n<memory-used></memory-used>"))
      .toEqual({ declared: true, memoryRefs: [], message: "Ничего не пригодилось." });
  });
});
