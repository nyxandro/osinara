/**
 * Code-reviewed Google Workspace command policy.
 *
 * Exports:
 * - `GoogleWorkspaceCommandKind`: read-only or externally mutating operation.
 * - `classifyGoogleWorkspaceCommand`: validates an exact gws argv and fails closed when unknown.
 * - `classifyModelFacingGoogleWorkspaceCommand`: reserves structured application-owned actions.
 * - `fitsApprovableGoogleWorkspaceArguments`: whether a mutation argv can be shown before approval.
 *
 * The allowlist is pinned to the installed gws 0.22.5 command tree. Command meaning is never
 * inferred from model prose, JSON bodies, flag names, or substrings in user-controlled values.
 */
import {
  googleWorkspaceArgumentsTooLarge,
  googleWorkspaceCommandForbidden as forbidden,
  validateGoogleWorkspaceArgv,
} from "./google-workspace-command-errors.js";

export type GoogleWorkspaceCommandKind = "mutation" | "read";

const MAX_APPROVABLE_ARGUMENTS_LENGTH = 3_000;

const READ_ROUTES = [
  // Calendar API and reviewed read helpers.
  "calendar +agenda",
  "calendar acl get",
  "calendar acl list",
  "calendar calendarList get",
  "calendar calendarList list",
  "calendar calendars get",
  "calendar colors get",
  "calendar events get",
  "calendar events instances",
  "calendar events list",
  "calendar freebusy query",
  "calendar settings get",
  "calendar settings list",

  // Docs and Sheets reads.
  "docs documents get",
  "sheets +read",
  "sheets spreadsheets get",
  "sheets spreadsheets getByDataFilter",
  "sheets spreadsheets developerMetadata get",
  "sheets spreadsheets developerMetadata search",
  "sheets spreadsheets values batchGet",
  "sheets spreadsheets values batchGetByDataFilter",
  "sheets spreadsheets values get",

  // Drive reads, downloads, and long-running operation inspection.
  "drive about get",
  "drive accessproposals get",
  "drive accessproposals list",
  "drive approvals get",
  "drive approvals list",
  "drive apps get",
  "drive apps list",
  "drive changes getStartPageToken",
  "drive changes list",
  "drive comments get",
  "drive comments list",
  "drive drives get",
  "drive drives list",
  "drive files generateIds",
  "drive files get",
  "drive files list",
  "drive files listLabels",
  "drive operations get",
  "drive permissions get",
  "drive permissions list",
  "drive replies get",
  "drive replies list",
  "drive revisions get",
  "drive revisions list",

  // Gmail reads and local presentation helpers.
  "gmail +read",
  "gmail +triage",
  "gmail users getProfile",
  "gmail users drafts get",
  "gmail users drafts list",
  "gmail users history list",
  "gmail users labels get",
  "gmail users labels list",
  "gmail users messages attachments get",
  "gmail users messages get",
  "gmail users messages list",
  "gmail users settings getAutoForwarding",
  "gmail users settings getImap",
  "gmail users settings getLanguage",
  "gmail users settings getPop",
  "gmail users settings getVacation",
  "gmail users settings delegates get",
  "gmail users settings delegates list",
  "gmail users settings filters get",
  "gmail users settings filters list",
  "gmail users settings forwardingAddresses get",
  "gmail users settings forwardingAddresses list",
  "gmail users settings sendAs get",
  "gmail users settings sendAs list",
  "gmail users settings sendAs smimeInfo get",
  "gmail users settings sendAs smimeInfo list",
  "gmail users threads get",
  "gmail users threads list",

  // People reads.
  "people contactGroups batchGet",
  "people contactGroups get",
  "people contactGroups list",
  "people otherContacts list",
  "people otherContacts search",
  "people people get",
  "people people getBatchGet",
  "people people listDirectoryPeople",
  "people people searchContacts",
  "people people searchDirectoryPeople",
  "people people connections list",
] as const;

const MUTATION_ROUTES = [
  // Calendar mutations, including subscriptions and destructive clears.
  "calendar +insert",
  "calendar acl delete",
  "calendar acl insert",
  "calendar acl patch",
  "calendar acl update",
  "calendar acl watch",
  "calendar calendarList delete",
  "calendar calendarList insert",
  "calendar calendarList patch",
  "calendar calendarList update",
  "calendar calendarList watch",
  "calendar calendars clear",
  "calendar calendars delete",
  "calendar calendars insert",
  "calendar calendars patch",
  "calendar calendars update",
  "calendar channels stop",
  "calendar events delete",
  "calendar events import",
  "calendar events insert",
  "calendar events move",
  "calendar events patch",
  "calendar events quickAdd",
  "calendar events update",
  "calendar events watch",
  "calendar settings watch",

  // Docs and Sheets mutations.
  "docs +write",
  "docs documents batchUpdate",
  "docs documents create",
  "sheets +append",
  "sheets spreadsheets batchUpdate",
  "sheets spreadsheets create",
  "sheets spreadsheets sheets copyTo",
  "sheets spreadsheets values append",
  "sheets spreadsheets values batchClear",
  "sheets spreadsheets values batchClearByDataFilter",
  "sheets spreadsheets values batchUpdate",
  "sheets spreadsheets values batchUpdateByDataFilter",
  "sheets spreadsheets values clear",
  "sheets spreadsheets values update",

  // Drive mutations and subscriptions.
  "drive accessproposals resolve",
  "drive changes watch",
  "drive channels stop",
  "drive comments create",
  "drive comments delete",
  "drive comments update",
  "drive drives create",
  "drive drives hide",
  "drive drives unhide",
  "drive drives update",
  "drive files copy",
  "drive files create",
  "drive files modifyLabels",
  "drive files update",
  "drive files watch",
  "drive permissions create",
  "drive permissions delete",
  "drive permissions update",
  "drive replies create",
  "drive replies delete",
  "drive replies update",
  "drive revisions delete",
  "drive revisions update",

  // Gmail side effects. Draft creation is still a durable external mutation.
  "gmail +forward",
  "gmail +reply",
  "gmail +reply-all",
  "gmail +send",
  "gmail +watch",
  "gmail users stop",
  "gmail users watch",
  "gmail users drafts create",
  "gmail users drafts delete",
  "gmail users drafts send",
  "gmail users drafts update",
  "gmail users labels create",
  "gmail users labels delete",
  "gmail users labels patch",
  "gmail users labels update",
  "gmail users messages batchDelete",
  "gmail users messages batchModify",
  "gmail users messages delete",
  "gmail users messages import",
  "gmail users messages insert",
  "gmail users messages modify",
  "gmail users messages send",
  "gmail users messages trash",
  "gmail users messages untrash",
  "gmail users settings updateAutoForwarding",
  "gmail users settings updateImap",
  "gmail users settings updateLanguage",
  "gmail users settings updatePop",
  "gmail users settings updateVacation",
  "gmail users settings delegates create",
  "gmail users settings delegates delete",
  "gmail users settings filters create",
  "gmail users settings filters delete",
  "gmail users settings forwardingAddresses create",
  "gmail users settings forwardingAddresses delete",
  "gmail users settings sendAs create",
  "gmail users settings sendAs delete",
  "gmail users settings sendAs patch",
  "gmail users settings sendAs update",
  "gmail users settings sendAs verify",
  "gmail users settings sendAs smimeInfo delete",
  "gmail users settings sendAs smimeInfo insert",
  "gmail users settings sendAs smimeInfo setDefault",
  "gmail users threads delete",
  "gmail users threads modify",
  "gmail users threads trash",
  "gmail users threads untrash",

  // People contact mutations.
  "people contactGroups create",
  "people contactGroups delete",
  "people contactGroups update",
  "people contactGroups members modify",
  "people otherContacts copyOtherContactToMyContactsGroup",
  "people people batchCreateContacts",
  "people people batchDeleteContacts",
  "people people batchUpdateContacts",
  "people people createContact",
  "people people deleteContact",
  "people people deleteContactPhoto",
  "people people updateContact",
  "people people updateContactPhoto",
] as const;

const READ_ROUTE_SET = new Set<string>(READ_ROUTES);
const MUTATION_ROUTE_SET = new Set<string>(MUTATION_ROUTES);
const REVIEWED_ROUTES = [...READ_ROUTES, ...MUTATION_ROUTES]
  .map((route) => ({ route, segments: route.split(" ") }))
  .sort((left, right) => right.segments.length - left.segments.length);
const SERVICE_NAMES = new Set(["calendar", "docs", "drive", "gmail", "people", "sheets"]);
const GMAIL_MESSAGE_BATCH_ROUTE = "manage_gmail_message: все messageId одной пачкой до 30 за вызов";
const GMAIL_THREAD_BATCH_ROUTE = "manage_gmail_message: messageId писем цепочки одной пачкой до 30 за вызов";
const STRUCTURED_APPLICATION_ROUTES: Readonly<Record<string, string>> = {
  "gmail users messages batchDelete": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users messages batchModify": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users messages delete": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users messages modify": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users messages trash": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users messages untrash": GMAIL_MESSAGE_BATCH_ROUTE,
  "gmail users threads delete": GMAIL_THREAD_BATCH_ROUTE,
  "gmail users threads modify": GMAIL_THREAD_BATCH_ROUTE,
  "gmail users threads trash": GMAIL_THREAD_BATCH_ROUTE,
  "gmail users threads untrash": GMAIL_THREAD_BATCH_ROUTE,
};
const FILE_PATH_FLAGS = new Set([
  "-a",
  "-o",
  "--attach",
  "--output",
  "--output-dir",
  "--upload",
]);
type FlagArity = "boolean" | "value";

const API_FLAGS: Readonly<Record<string, FlagArity>> = {
  "--format": "value",
  "--json": "value",
  "--page-all": "boolean",
  "--page-delay": "value",
  "--page-limit": "value",
  "--params": "value",
};

const HELPER_FLAGS: Readonly<Record<string, Readonly<Record<string, FlagArity>>>> = {
  "calendar +agenda": {
    "--calendar": "value", "--days": "value", "--today": "boolean",
    "--tomorrow": "boolean", "--timezone": "value", "--week": "boolean",
  },
  "calendar +insert": {
    "--attendee": "value", "--calendar": "value", "--description": "value",
    "--end": "value", "--location": "value", "--meet": "boolean", "--start": "value",
    "--summary": "value",
  },
  "docs +write": { "--document": "value", "--text": "value" },
  "gmail +forward": {
    "--bcc": "value", "--body": "value", "--cc": "value", "--draft": "boolean",
    "--dry-run": "boolean", "--from": "value", "--html": "boolean",
    "--message-id": "value", "--no-original-attachments": "boolean", "--to": "value",
  },
  "gmail +read": {
    "--dry-run": "boolean", "--format": "value", "--headers": "boolean",
    "--html": "boolean", "--id": "value",
  },
  "gmail +reply": {
    "--bcc": "value", "--body": "value", "--cc": "value", "--draft": "boolean",
    "--dry-run": "boolean", "--from": "value", "--html": "boolean",
    "--message-id": "value", "--to": "value",
  },
  "gmail +reply-all": {
    "--bcc": "value", "--body": "value", "--cc": "value", "--draft": "boolean",
    "--dry-run": "boolean", "--from": "value", "--html": "boolean",
    "--message-id": "value", "--remove": "value", "--to": "value",
  },
  "gmail +send": {
    "--bcc": "value", "--body": "value", "--cc": "value", "--draft": "boolean",
    "--dry-run": "boolean", "--from": "value", "--html": "boolean",
    "--subject": "value", "--to": "value",
  },
  "gmail +triage": { "--labels": "boolean", "--max": "value", "--query": "value" },
  "gmail +watch": {
    "--cleanup": "boolean", "--label-ids": "value", "--max-messages": "value",
    "--msg-format": "value", "--once": "boolean", "--poll-interval": "value",
    "--project": "value", "--subscription": "value", "--topic": "value",
  },
  "sheets +append": {
    "--json-values": "value", "--range": "value", "--spreadsheet": "value",
    "--values": "value",
  },
  "sheets +read": { "--range": "value", "--spreadsheet": "value" },
};

export function fitsApprovableGoogleWorkspaceArguments(argv: readonly string[]): boolean {
  return JSON.stringify(argv).length <= MAX_APPROVABLE_ARGUMENTS_LENGTH;
}

function classifyRoute(route: string): GoogleWorkspaceCommandKind {
  if (READ_ROUTE_SET.has(route)) return "read";
  if (MUTATION_ROUTE_SET.has(route)) return "mutation";
  throw forbidden();
}

function isFilePathFlag(argument: string): boolean {
  const flag = argument.split("=", 1)[0]!;
  return FILE_PATH_FLAGS.has(flag) ||
    (argument.length > 2 && (argument.startsWith("-a") || argument.startsWith("-o")));
}

function resolveReviewedRoute(argv: readonly string[]): {
  argumentOffset: number;
  kind: GoogleWorkspaceCommandKind;
  route: string;
} {
  const match = REVIEWED_ROUTES.find(({ segments }) =>
    segments.every((segment, index) => argv[index] === segment)
  );
  if (!match) {
    const dotted = argv.some((argument) => argument.includes("."));
    throw forbidden(
      dotted
        ? "API resource и method объединены через точку или route не существует."
        : "Route не найден в проверенном allowlist.",
      "Передайте service, resource, optional sub-resource и method отдельными argv элементами. Точка допустима только во втором аргументе top-level schema; отказ не означает read-only OAuth.",
      SERVICE_NAMES.has(argv[0]!) ? { argv: [argv[0], "--help"] } : undefined,
    );
  }
  return {
    argumentOffset: match.segments.length,
    kind: classifyRoute(match.route),
    route: match.route,
  };
}

function validateRouteArguments(route: string, argv: readonly string[]): void {
  const flags = route.includes(" +") ? HELPER_FLAGS[route] : API_FLAGS;
  if (!flags) throw forbidden();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (isFilePathFlag(argument)) {
      throw forbidden(
        `Файловый flag ${argument.split("=", 1)[0]} запрещён в credentialed runner.`,
        "Удалите файловый flag и используйте только non-file API поля или отдельный application tool.",
      );
    }
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const arity = flags[flag];
    if (!arity || !flag.startsWith("--")) {
      throw forbidden(
        `Flag или positional argument ${flag} не разрешён для route ${route}.`,
        "Сверьте flags в exact trusted skill этого route; не применяйте flags из другого helper.",
      );
    }
    if (separator !== -1) {
      if (arity !== "value" || separator === argument.length - 1) {
        throw forbidden(`Flag ${flag} получил неверную inline-форму.`, "Передайте непустое значение отдельным argv элементом.");
      }
      if (argument.slice(separator + 1).startsWith("-")) {
        throw forbidden(
          `Значение flag ${flag} похоже на отдельный flag.`,
          `Передайте корректное значение ${flag}; не скрывайте другой flag внутри его значения.`,
        );
      }
      continue;
    }
    if (arity === "boolean") continue;
    const value = argv[index + 1];
    if (value === undefined) {
      throw forbidden(`Для flag ${flag} отсутствует значение.`, `Добавьте значение сразу после ${flag}.`);
    }
    if (value.startsWith("-")) {
      throw forbidden(
        `Значение flag ${flag} похоже на отдельный flag.`,
        `Передайте корректное значение ${flag}; не скрывайте другой flag внутри его значения.`,
      );
    }
    index += 1;
  }
}

export function classifyGoogleWorkspaceCommand(
  argv: readonly string[],
): GoogleWorkspaceCommandKind {
  validateGoogleWorkspaceArgv(argv);

  // Service-level help and reviewed schema discovery are local reads and never need credentials.
  if (argv.length === 2 && SERVICE_NAMES.has(argv[0]!) && argv[1] === "--help") return "read";
  if (argv[0] === "schema" && argv.length === 2) {
    const route = argv[1]!.split(".").join(" ");
    if (!READ_ROUTE_SET.has(route) && !MUTATION_ROUTE_SET.has(route)) {
      const service = argv[1]!.split(".")[0]!;
      throw forbidden("Запрошенный schema route отсутствует в allowlist.",
        "Получите справку сервиса, затем вызовите schema с точным путём API метода.",
        SERVICE_NAMES.has(service) ? { argv: [service, "--help"] } : undefined);
    }
    classifyRoute(route);
    return "read";
  }

  // Help for an allowlisted route is local metadata, even when the route itself mutates data.
  if (argv.at(-1) === "--help") {
    const route = argv.slice(0, -1).join(" ");
    if (READ_ROUTE_SET.has(route) || MUTATION_ROUTE_SET.has(route)) return "read";
    throw forbidden();
  }

  const reviewed = resolveReviewedRoute(argv);
  const argumentsAfterRoute = argv.slice(reviewed.argumentOffset);

  // API routes accept only option arguments after their exact command path. File-consuming options
  // stay unavailable until files can be copied into a credential-free staging mount; otherwise a
  // model could upload `/proc/self/environ` and exfiltrate the live OAuth token.
  if (argumentsAfterRoute[0] !== undefined && !argumentsAfterRoute[0].startsWith("-")) {
    throw forbidden(
      `После route передан positional argument ${argumentsAfterRoute[0]}.`,
      "После точного route используйте только документированные flags и их значения.",
    );
  }
  validateRouteArguments(reviewed.route, argumentsAfterRoute);
  if (reviewed.route === "gmail +watch" && !argumentsAfterRoute.includes("--once")) {
    throw forbidden(
      "gmail +watch без --once является долгоживущей командой, которую one-shot runner остановит через 60 секунд.",
      "Добавьте --once. После timeout не повторяйте setup вслепую: сначала проверьте фактические Pub/Sub resources.",
    );
  }
  // Telegram must be able to show every material mutation argument before approval.
  if (reviewed.kind === "mutation" && !fitsApprovableGoogleWorkspaceArguments(argv)) {
    throw googleWorkspaceArgumentsTooLarge();
  }
  return reviewed.kind;
}

export function classifyModelFacingGoogleWorkspaceCommand(
  argv: readonly string[],
): GoogleWorkspaceCommandKind {
  const kind = classifyGoogleWorkspaceCommand(argv);
  if (kind !== "mutation") return kind;

  const reviewed = resolveReviewedRoute(argv);
  const structuredTool = STRUCTURED_APPLICATION_ROUTES[reviewed.route];
  if (structuredTool) {
    throw forbidden(
      `Route ${reviewed.route} принадлежит структурированному прикладному действию.`,
      `Используйте ${structuredTool}; не передавайте эту mutation через execute_google_workspace.`,
    );
  }
  return kind;
}
