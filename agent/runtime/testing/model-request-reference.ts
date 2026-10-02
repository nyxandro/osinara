/**
 * Golden language-model requests: normalization and the stored file format.
 *
 * Exports:
 * - `ReferenceCall`, `ReferenceFile`: one recorded model call, and one scenario as stored.
 * - `normalizeReferenceCalls`: replaces run-specific values with stable placeholders.
 * - `packReferenceFile` / `unpackReferenceFile`: store each repeated system prompt and tool set once.
 *
 * The golden requests in `eve-0.40-requests/` were recorded from native Eve 0.40.0 by
 * `stress/telegram-conversation/evals/reference.eval.ts`. Identifiers, random markers and clock
 * values differ on every run, so each distinct value becomes a numbered placeholder in order of
 * first appearance within one scenario: equal values stay equal, different values stay different,
 * and everything else is compared verbatim. The own runtime normalizes its requests the same way.
 *
 * Comparison contract:
 * - Tool definitions are static text and are compared verbatim, including the UUID patterns and
 *   example dates in their schemas and descriptions.
 * - The bench registers one extra static tool, `probe_workspace`; the runtime's bench registers the
 *   same tool at the same place in the tool set instead of the recording being edited.
 * - Placeholders are typed by format, so the runtime must produce ids of the same shape: session
 *   ids `wrun_<ULID>`, approval request ids as AI SDK generates them (`aitxt-…`).
 * - Two independent values that happen to be equal (two timestamps of the same millisecond) share
 *   a placeholder; a scenario where that matters must make them differ.
 */
export interface ReferenceCall {
  readonly agent: "child" | "root";
  readonly kind: "generate" | "stream";
  readonly request: unknown;
}

export interface ReferenceFile {
  readonly calls: readonly ReferenceCall[];
  readonly scenario: string;
  /** System prompt texts and tool sets that several calls share, keyed by `system-N` / `tools-N`. */
  readonly shared: Readonly<Record<string, unknown>>;
}

const SHARED_KEY = "$shared";

// Order matters: a UUID or prefixed id is replaced before the bare hex rule could split it.
const VOLATILE_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu },
  { label: "id", pattern: /\b[a-z]+_[0-9A-HJKMNP-TV-Z]{26}\b/gu },
  { label: "ref", pattern: /\b[a-z]+_[0-9a-f]{16,}\b/gu },
  { label: "hex", pattern: /\b[0-9a-f]{16,}\b/gu },
  { label: "aisdk", pattern: /\bai[a-z]*-[A-Za-z0-9]{16,}\b/gu },
  { label: "time", pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu },
  { label: "local-time", pattern: /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/gu },
  // Group timeline context (telegram-group-journal-context.ts): a day line and each entry's clock.
  { label: "timeline-day", pattern: /(?<=^-- )\d{4}-\d{2}-\d{2}(?= UTC --$)/gmu },
  { label: "timeline-clock", pattern: /(?<=^#\d+ \[[a-z:_]+\] "(?:[^"\\]|\\.)*"(?: reply:#\d+)? )\d{2}:\d{2}(?= )/gmu },
];

type Registry = Map<string, Map<string, string>>;

function placeholderFor(registry: Registry, label: string, value: string): string {
  let values = registry.get(label);
  if (values === undefined) {
    values = new Map();
    registry.set(label, values);
  }
  let placeholder = values.get(value);
  if (placeholder === undefined) {
    placeholder = `<${label}-${values.size + 1}>`;
    values.set(value, placeholder);
  }
  return placeholder;
}

function normalizeValue(registry: Registry, value: unknown): unknown {
  if (typeof value === "string") {
    return VOLATILE_PATTERNS.reduce(
      (text, { label, pattern }) => text.replace(pattern, (match) => placeholderFor(registry, label, match)),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(registry, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(registry, item)]));
  }
  return value;
}

export function normalizeReferenceCalls(calls: readonly ReferenceCall[]): ReferenceCall[] {
  const registry: Registry = new Map();
  return calls.map((call) => {
    if (!isRecord(call.request)) return { ...call, request: normalizeValue(registry, call.request) };
    const request = Object.fromEntries(Object.entries(call.request).map(([key, value]) =>
      [key, key === "tools" ? value : normalizeValue(registry, value)]));
    return { ...call, request };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNoSharedToken(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(requireNoSharedToken);
    return;
  }
  if (!isRecord(value)) return;
  if (SHARED_KEY in value) throw new Error(`TEST_REFERENCE_SHARED_KEY_COLLISION: request already holds ${SHARED_KEY}`);
  Object.values(value).forEach(requireNoSharedToken);
}

/** Replaces each system prompt text and tool set by a reference to its single stored copy. */
export function packReferenceFile(scenario: string, calls: readonly ReferenceCall[]): ReferenceFile {
  const shared: Record<string, unknown> = {};
  const keys = new Map<string, string>();
  const counts = { system: 0, tools: 0 };
  const share = (kind: keyof typeof counts, value: unknown) => {
    const identity = `${kind}:${JSON.stringify(value)}`;
    let key = keys.get(identity);
    if (key === undefined) {
      counts[kind] += 1;
      key = `${kind}-${counts[kind]}`;
      keys.set(identity, key);
      shared[key] = value;
    }
    return { [SHARED_KEY]: key };
  };
  const packed = calls.map((call) => {
    requireNoSharedToken(call.request);
    if (!isRecord(call.request)) throw new Error("TEST_REFERENCE_REQUEST_INVALID: a model request is not an object");
    // Entries are rebuilt in place, so the stored request keeps the recorded key order.
    const request = Object.fromEntries(Object.entries(call.request).map(([key, value]) => {
      if (key === "tools") return [key, share("tools", value)];
      if (key !== "prompt" || !Array.isArray(value)) return [key, value];
      return [key, value.map((message: unknown) =>
        isRecord(message) && message.role === "system" ? { ...message, content: share("system", message.content) } : message)];
    }));
    return { ...call, request };
  });
  return { scenario, shared, calls: packed };
}

function expandValue(shared: Readonly<Record<string, unknown>>, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => expandValue(shared, item));
  if (!isRecord(value)) return value;
  if (SHARED_KEY in value) {
    const key = value[SHARED_KEY];
    if (typeof key !== "string" || !(key in shared)) throw new Error(`TEST_REFERENCE_SHARED_MISSING: ${String(key)}`);
    // Each call gets its own copy, so editing one call's request never changes another.
    return structuredClone(shared[key]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(shared, item)]));
}

export function unpackReferenceFile(file: ReferenceFile): ReferenceCall[] {
  return file.calls.map((call) => ({ ...call, request: expandValue(file.shared, call.request) }));
}
