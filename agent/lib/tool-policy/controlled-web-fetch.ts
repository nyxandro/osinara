/**
 * Controlled external-group web fetch.
 *
 * Exports:
 * - Resource-limit and proxy constants used by policy tests and runtime wiring.
 * - `CONTROLLED_WEB_FETCH_INPUT_SCHEMA`: validated input contract, the same as the native `web_fetch`.
 * - `createControlledWebFetch`: injectable secure HTTP executor for isolated tests.
 * - `controlledWebFetchTool`: custom `web_fetch` definition, compatible with the native one.
 *
 * A page is read in portions of at most `CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES` and
 * `CONTROLLED_WEB_FETCH_MAX_MODEL_LINES`. Everything past the first portion used to be lost: a
 * release list on GitHub ended mid-page (12.10.2026) and the agent went around through the API.
 * `offset` continues from `nextOffset` of the previous answer; the page is downloaded again each
 * time, so nothing is kept between calls and the tool stays a plain read.
 *
 * A site that does not open — no connection, no answer in time, a redirect loop, a file or an
 * oversized page — is the outside world's answer: it is recorded as an expected refusal with its
 * origin and no alert counts it (#499). An egress proxy the agent cannot reach stays a failure.
 */
import { Buffer } from "node:buffer";

import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type RequestInit,
  type Response,
} from "undici";
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";

export const CONTROLLED_WEB_FETCH_PROXY_URL = "http://sandbox-egress-proxy:3128";
export const CONTROLLED_WEB_FETCH_MAX_REDIRECTS = 5;
export const CONTROLLED_WEB_FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES = 50 * 1024;
export const CONTROLLED_WEB_FETCH_MAX_MODEL_LINES = 2_000;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MILLISECONDS_PER_SECOND = 1_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPE = "text/html";
const STRUCTURED_TEXT_CONTENT_TYPES = new Set(["application/json", "application/xml"]);
const STRUCTURED_TEXT_CONTENT_TYPE_SUFFIX = /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

export const CONTROLLED_WEB_FETCH_INPUT_SCHEMA = z.object({
  url: z.string(),
  format: z.enum(["html", "extracted_text"])
    .describe("html returns the original HTML markup; extracted_text strips HTML tags and returns plain text")
    .optional(),
  timeout: z.number().positive().max(MAX_TIMEOUT_SECONDS).optional(),
  // A character takes at least one byte, so no page text is longer than the body limit.
  offset: z.number().int().min(0).max(CONTROLLED_WEB_FETCH_MAX_BODY_BYTES)
    .describe("Where to start reading the page text, in characters: pass nextOffset from the previous answer to read the next portion, with the same format. The page is downloaded again, so if it changed meanwhile the portions may not line up. 0 by default")
    .optional(),
}).strict();

type ControlledWebFetchInput = z.infer<typeof CONTROLLED_WEB_FETCH_INPUT_SCHEMA>;

interface ControlledWebFetchResult {
  content: string;
  contentType: string;
  finalUrl: string;
  /** Where the next portion starts, or null when this one reaches the end of the page. */
  nextOffset: number | null;
  offset: number;
  totalCharacters: number;
  truncated: boolean;
}

type Fetch = (input: URL | string, init?: RequestInit) => Promise<Response>;

interface ControlledWebFetchDependencies {
  dispatcher: Dispatcher;
  fetch: Fetch;
}

interface ExecuteOptions {
  abortSignal?: AbortSignal;
}

const controlledWebFetchDispatcher = new ProxyAgent(CONTROLLED_WEB_FETCH_PROXY_URL);

// undici 8 keeps only the status of a refused tunnel, under fetch's own "fetch failed"; the egress
// proxy answers 404 to a name public DNS does not know (services/sandbox-egress-proxy/server.ts).
const EGRESS_HOST_NOT_FOUND_TUNNEL = /^Proxy response \(404\) !== 200 when HTTP Tunneling$/u;
const EGRESS_HOST_NOT_FOUND_STATUS_TEXT = "Host Not Found";

// How long the reason of a failed request may be in the log; it is undici's own message, never the URL.
const MAX_CAUSE_CHARACTERS = 200;

/**
 * A site that did not open is the outside world's answer, not a failure of the application: the tool
 * boundary records it as one line with its code, and no alert counts it (#499). Only the origin reaches
 * the log, because the path and query may carry tokens.
 */
function siteRefusal(
  code: string,
  message: string,
  url: URL,
  options: { readonly cause?: unknown; readonly details?: Readonly<Record<string, string | number>> } = {},
): AppError {
  return new AppError(code, message, {
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    details: { origin: url.origin, ...options.details },
    isExpectedRefusal: true,
  });
}

// A mistyped or retired address, not an outage: "try later" made the model repeat it (#436). A name
// with only an IPv6 address lands here too, and this deployment has no IPv6 route to it.
function hostNotFound(url: URL): AppError {
  return siteRefusal(
    "AGENT_WEB_FETCH_HOST_NOT_FOUND",
    "Адрес недоступен: у этого домена нет IPv4-адреса в публичном DNS, такого домена нет или он не работает. Проверьте написание адреса",
    url,
  );
}

function redirectLimit(url: URL): AppError {
  return siteRefusal(
    "AGENT_WEB_FETCH_REDIRECT_LIMIT",
    "Страница перенаправляет слишком много раз. Укажите конечный адрес",
    url,
  );
}

// The agent opens a connection only to its own egress proxy, never to a site: failing to resolve or
// connect to it means no site was asked, which is the application's own failure (#499).
const PROXY_UNREACHABLE_SYSCALLS: ReadonlySet<string> = new Set(["connect", "getaddrinfo"]);

// undici reports every network failure as a TypeError: "fetch failed" from fetch itself, "terminated"
// when the body stops arriving. Anything else thrown while reading a page is a defect of this code.
const NETWORK_FAILURE_MESSAGES: ReadonlySet<string> = new Set(["fetch failed", "terminated"]);

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE_MESSAGES.has(error.message);
}

// undici wraps the reason in "fetch failed" and a cancellation; the innermost error names it, such as
// the status the egress proxy refused the tunnel with.
function innermostError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause instanceof Error; depth += 1) {
    current = current.cause;
  }
  return current;
}

function requestFailed(url: URL, error: unknown): AppError {
  const innermost = innermostError(error);
  const cause = (innermost instanceof Error ? innermost.message : String(innermost)).slice(0, MAX_CAUSE_CHARACTERS);
  const syscall = (innermost as NodeJS.ErrnoException | undefined)?.syscall;
  const message = "Не удалось загрузить страницу через защищённый шлюз. Попробуйте позже";
  if (syscall !== undefined && PROXY_UNREACHABLE_SYSCALLS.has(syscall)) {
    return new AppError("AGENT_WEB_FETCH_REQUEST_FAILED", message, { cause: error, details: { cause, origin: url.origin } });
  }
  return siteRefusal("AGENT_WEB_FETCH_REQUEST_FAILED", message, url, { cause: error, details: { cause } });
}

function isEgressHostNotFound(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
    if (EGRESS_HOST_NOT_FOUND_TUNNEL.test(current.message)) return true;
  }
  return false;
}

function parseInput(input: unknown): ControlledWebFetchInput {
  const parsed = CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_WEB_FETCH_INPUT_INVALID",
      "Параметры загрузки страницы некорректны. Проверьте адрес, формат и таймаут",
    );
  }
  return parsed.data;
}

function validateUrl(value: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value, base);
  } catch {
    throw new AppError(
      "AGENT_WEB_FETCH_URL_INVALID",
      "Адрес страницы некорректен. Укажите полный адрес HTTP или HTTPS",
    );
  }

  // Credentials and uncommon ports must never cross the egress boundary.
  const validProtocol = url.protocol === "http:" || url.protocol === "https:";
  if (!validProtocol || url.username !== "" || url.password !== "" || !ALLOWED_PORTS.has(url.port)) {
    throw new AppError(
      "AGENT_WEB_FETCH_URL_FORBIDDEN",
      "Этот адрес нельзя загрузить. Используйте HTTP или HTTPS без учётных данных и нестандартного порта",
    );
  }
  return url;
}

function textContentType(response: Response, url: URL): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const supported = value !== undefined && MEDIA_TYPE_PATTERN.test(value) && (
    value.startsWith("text/") ||
    STRUCTURED_TEXT_CONTENT_TYPES.has(value) ||
    STRUCTURED_TEXT_CONTENT_TYPE_SUFFIX.test(value)
  );
  if (!supported) {
    void response.body?.cancel();
    throw siteRefusal(
      "AGENT_WEB_FETCH_CONTENT_TYPE_UNSUPPORTED",
      "Сайт вернул не текстовую страницу. Загрузка файлов через веб-доступ запрещена",
      url,
    );
  }
  return value;
}

function bodyTooLarge(url: URL): AppError {
  return siteRefusal(
    "AGENT_WEB_FETCH_BODY_TOO_LARGE",
    "Страница слишком большая для безопасной загрузки. Выберите более компактный источник",
    url,
  );
}

async function readBoundedBody(response: Response, url: URL): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > CONTROLLED_WEB_FETCH_MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw bodyTooLarge(url);
  }

  // Read incrementally so a misleading or absent Content-Length cannot force unbounded buffering.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > CONTROLLED_WEB_FETCH_MAX_BODY_BYTES) {
      await reader.cancel();
      throw bodyTooLarge(url);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes);
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu, (entity, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return namedEntities[String(named).toLowerCase()] ?? entity;
  });
}

function htmlToText(html: string): string {
  // Remove non-content blocks before tags; no DOM dependency is needed for bounded model-safe text.
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<!--([\s\S]*?)-->/gu, " ")
      .replace(/<\s*br\s*\/?>/giu, "\n")
      .replace(/<\/\s*(?:p|div|article|section|li|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " "),
  )
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;

  // TextDecoder drops an incomplete trailing code point rather than emitting malformed UTF-8. A
  // portion may open with U+FEFF, which is text here, not a byte order mark to strip.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/\uFFFD$/u, "");
}

/**
 * The portion is always a prefix of the text from where it starts: the line bound keeps whole lines and the
 * byte bound drops an incomplete trailing code point, so the next portion starts exactly at its end
 * and the portions together are the whole page.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function boundModelContent(
  value: string,
  offset: number,
): Pick<ControlledWebFetchResult, "content" | "nextOffset" | "offset" | "totalCharacters" | "truncated"> {
  const safeText = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  if (offset > 0 && offset >= safeText.length) {
    throw new AppError(
      "AGENT_WEB_FETCH_INPUT_INVALID",
      `Указанное место за концом страницы: сейчас в ней ${safeText.length} знаков. Если страница изменилась, прочитайте её заново с начала`,
    );
  }
  // An offset of the model's own may fall between the two halves of a character; start at its first.
  const start = offset > 0 && isLowSurrogate(safeText.charCodeAt(offset)) && isHighSurrogate(safeText.charCodeAt(offset - 1))
    ? offset - 1
    : offset;
  const lines = safeText.slice(start).split("\n");
  const lineBounded = lines.slice(0, CONTROLLED_WEB_FETCH_MAX_MODEL_LINES).join("\n");
  const content = truncateUtf8(lineBounded, CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES);
  const end = start + content.length;
  return {
    content,
    nextOffset: end < safeText.length ? end : null,
    offset: start,
    totalCharacters: safeText.length,
    truncated: end < safeText.length,
  };
}

function requestSignal(timeoutSeconds: number, abortSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * MILLISECONDS_PER_SECOND);
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

export function createControlledWebFetch(dependencies: ControlledWebFetchDependencies) {
  return async (
    rawInput: ControlledWebFetchInput,
    options: ExecuteOptions = {},
  ): Promise<ControlledWebFetchResult> => {
    const input = parseInput(rawInput);
    const signal = requestSignal(input.timeout ?? DEFAULT_TIMEOUT_SECONDS, options.abortSignal);
    let currentUrl = validateUrl(input.url);

    try {
      for (let redirectCount = 0; redirectCount <= CONTROLLED_WEB_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        // Every hop explicitly carries the same proxy dispatcher and total-deadline signal.
        const response = await dependencies.fetch(currentUrl, {
          dispatcher: dependencies.dispatcher,
          redirect: "manual",
          signal,
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          if (redirectCount === CONTROLLED_WEB_FETCH_MAX_REDIRECTS) throw redirectLimit(currentUrl);
          const location = response.headers.get("location");
          if (!location) {
            throw siteRefusal(
              "AGENT_WEB_FETCH_REDIRECT_INVALID",
              "Страница вернула некорректное перенаправление. Укажите другой адрес",
              currentUrl,
            );
          }
          currentUrl = validateUrl(location, currentUrl);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          // On a plain HTTP address the proxy answers itself, with the status its tunnel refusal has;
          // through an HTTPS tunnel the answer is the site's own, whatever its status text says.
          if (currentUrl.protocol === "http:" && response.status === 404 &&
            response.statusText === EGRESS_HOST_NOT_FOUND_STATUS_TEXT) {
            throw hostNotFound(currentUrl);
          }
          // The status tells a blocked site from an invented address or an outage; the path and
          // query may carry tokens, so only the origin reaches the log. A site's answer is not an
          // application failure, so the tool boundary records it without a stack.
          throw siteRefusal(
            "AGENT_WEB_FETCH_RESPONSE_FAILED",
            `Сайт не отдал доступную страницу: HTTP ${response.status}. Проверьте адрес или попробуйте позже`,
            currentUrl,
            { details: { status: response.status } },
          );
        }

        // Reject files before buffering; web access is intentionally limited to model-readable text.
        const responseContentType = textContentType(response, currentUrl);
        const body = await readBoundedBody(response, currentUrl);
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(body);
        const requestedFormat = input.format ?? "extracted_text";
        const formatted = responseContentType === HTML_CONTENT_TYPE && requestedFormat !== "html"
          ? htmlToText(decoded)
          : decoded;
        const bounded = boundModelContent(formatted, input.offset ?? 0);
        return {
          ...bounded,
          contentType: responseContentType,
          finalUrl: currentUrl.toString(),
        };
      }
    } catch (error) {
      if (isAppError(error)) throw error;
      if (signal.aborted) {
        // The turn's own cancellation is not the site's answer and stays as it was.
        if (options.abortSignal?.aborted === true) {
          throw new AppError("AGENT_WEB_FETCH_CANCELLED", "Загрузка страницы отменена");
        }
        throw siteRefusal(
          "AGENT_WEB_FETCH_TIMEOUT",
          "Страница не загрузилась за отведённое время. Попробуйте другой источник",
          currentUrl,
        );
      }
      if (isEgressHostNotFound(error)) throw hostNotFound(currentUrl);
      // Not the site's answer: the tool boundary reports it as a failure, with its cause.
      if (!isNetworkFailure(error)) throw error;
      throw requestFailed(currentUrl, error);
    }

    throw redirectLimit(currentUrl);
  };
}

export const executeControlledWebFetch = createControlledWebFetch({
  dispatcher: controlledWebFetchDispatcher,
  fetch: undiciFetch,
});

export const controlledWebFetchTool = defineTool({
  description: [
    "Load an HTTP(S) page through the protected network gateway.",
    "The extracted_text format strips HTML tags and returns plain text; the html format returns the original markup.",
    "extracted_text is used by default. The timeout is at most 120 seconds.",
    "The answer is bounded by safe size and line limits and reports the final URL, the original Content-Type and a truncation flag; a longer page is read on with offset set to the returned nextOffset.",
  ].join(" "),
  inputSchema: CONTROLLED_WEB_FETCH_INPUT_SCHEMA,
  async execute(input, ctx) {
    return await executeControlledWebFetch(input, { abortSignal: ctx.abortSignal });
  },
  // Preserve bounded content metadata so the model can assess redirects, representation, and truncation.
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});
