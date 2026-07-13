/**
 * Isolated PDF page-rendering HTTP service.
 *
 * Constructs:
 * - `readRequestBody`: bounded raw PDF input.
 * - `renderPdf`: page count validation and at-most-three-page PNG rendering.
 * - HTTP routes: `GET /health` and `POST /render-pdf`.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const HTTP_PORT = 8080;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_PAGES_PER_REQUEST = 3;
const PROCESS_TIMEOUT_MS = 20_000;

class ParserError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-length": body.byteLength,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) {
      throw new ParserError("DOCUMENT_INPUT_TOO_LARGE", "PDF exceeds 20 MB", 413);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ParserError("DOCUMENT_INPUT_EMPTY", "PDF body is empty", 400);
  return Buffer.concat(chunks);
}

async function pdfPageCount(path) {
  const { stdout } = await execute("pdfinfo", [path], {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    timeout: PROCESS_TIMEOUT_MS,
  });
  const match = /^Pages:\s+(\d+)$/mu.exec(stdout);
  if (!match) throw new ParserError("DOCUMENT_PAGE_COUNT_INVALID", "PDF page count is unavailable");
  return Number(match[1]);
}

function pageNumber(fileName) {
  const match = /-(\d+)\.png$/u.exec(fileName);
  if (!match) throw new ParserError("DOCUMENT_RENDER_OUTPUT_INVALID", "Rendered page name is invalid");
  return Number(match[1]);
}

async function renderPdf(bytes, startPage) {
  const directory = await mkdtemp(join(tmpdir(), "osinara-document-"));
  try {
    const source = join(directory, "source.pdf");
    const outputPrefix = join(directory, "page");
    await writeFile(source, bytes, { flag: "wx" });
    const totalPages = await pdfPageCount(source);
    if (startPage > totalPages) {
      throw new ParserError("DOCUMENT_PAGE_OUT_OF_RANGE", "Requested page is outside the PDF");
    }
    const endPage = Math.min(totalPages, startPage + MAX_PAGES_PER_REQUEST - 1);
    await execute("pdftoppm", [
      "-f", String(startPage), "-l", String(endPage), "-png", "-r", "120", source, outputPrefix,
    ], {
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      timeout: PROCESS_TIMEOUT_MS,
    });
    const names = (await readdir(directory))
      .filter((name) => /^page-\d+\.png$/u.test(name))
      .sort((left, right) => pageNumber(left) - pageNumber(right));
    const pages = [];
    let outputBytes = 0;
    for (const name of names) {
      const content = await readFile(join(directory, name));
      outputBytes += content.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        throw new ParserError("DOCUMENT_RENDER_TOO_LARGE", "Rendered pages exceed 20 MB");
      }
      pages.push({ contentBase64: content.toString("base64"), pageNumber: pageNumber(name) });
    }
    if (pages.length === 0) throw new ParserError("DOCUMENT_RENDER_EMPTY", "PDF rendered no pages");
    return { pages, totalPages };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://document-parser");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ready" });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/render-pdf") {
    sendJson(response, 404, { code: "DOCUMENT_ROUTE_NOT_FOUND" });
    return;
  }
  if (request.headers["content-type"] !== "application/pdf") {
    throw new ParserError("DOCUMENT_CONTENT_TYPE_INVALID", "Expected application/pdf", 415);
  }
  const startPage = Number(request.headers["x-start-page"]);
  if (!Number.isSafeInteger(startPage) || startPage <= 0) {
    throw new ParserError("DOCUMENT_START_PAGE_INVALID", "x-start-page must be a positive integer", 400);
  }
  sendJson(response, 200, await renderPdf(await readRequestBody(request), startPage));
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const known = error instanceof ParserError;
    console.error(JSON.stringify({
      code: known ? error.code : "DOCUMENT_RENDER_INTERNAL_FAILURE",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    sendJson(response, known ? error.status : 500, {
      code: known ? error.code : "DOCUMENT_RENDER_INTERNAL_FAILURE",
    });
  });
});

server.listen(HTTP_PORT, "0.0.0.0");
