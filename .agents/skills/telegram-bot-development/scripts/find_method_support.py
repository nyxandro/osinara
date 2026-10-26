#!/usr/bin/env python3
"""Does the Telegram library installed in this project know a Bot API method, type or field?

A library can lag behind the Bot API for months. Before writing a call, check the
installed code itself — it is the only thing the project will actually run.

Usage:
  find_method_support.py QUERY [QUERY ...] [--root DIR] [--lib PATH ...]

QUERY is a method, type or field in any spelling (sendMessageDraft,
send_message_draft, EphemeralMessageParameters), or METHOD.PARAMETER
(sendMessage.ephemeral_message_parameters) to ask whether the library accepts
that parameter on that method. A bare name only says the library mentions it
somewhere — the same name can be alive on one method and replaced on another.

It finds Telegram libraries under --root (default: the current directory):
JavaScript/TypeScript packages in node_modules (pnpm layout included), Python
packages in a project virtualenv or the active interpreter, Go modules in
vendor/ or the module cache. Anything else — PHP, Rust, .NET, Java, a monorepo
in an odd layout — pass with --lib. It prints each library with its version,
the Bot API version it declares when it declares one, and for each query where
it occurs, with the line. Standard library only.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Package names (or name fragments) of Bot API libraries; MTProto user-account
# libraries are left out on purpose: they speak a different API.
JS_NAMES = re.compile(
    r"^(grammy|@grammyjs/.+|telegraf|@telegraf/.+|typegram|gramio|@gramio/.+|"
    r"node-telegram-bot-api|puregram|@puregram/.+|telegram-bot-api|.*telegram-bot.*|@tma\.js/.+)$"
)
PY_NAMES = re.compile(r"^(aiogram|telegram|telebot|aiotg|.*telegram_bot.*)$")
GO_PATH = re.compile(r"(telegram|tgbotapi|telebot|go-telegram)", re.I)
CODE_SUFFIXES = {".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs", ".php", ".cs", ".java", ".kt", ".rb", ".dart"}
MAX_FILE_BYTES = 6_000_000
SEARCH_DEPTH = 4
LOCATIONS_SHOWN = 3
SNIPPET_CHARS = 110
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
# A name followed on its line by one of these opens a definition or a call that lists parameters:
# `sendMessage(args: {`, `def send_message(`, `sendMessage: (args`, `struct SendMessage {`.
DEFINITION_TAIL = re.compile(r"[ \t]*(?:[(<{]|:[ \t]*\()")
# A name after one of these is a container whose body holds the parameters: a class per method
# (aiogram), a parameters struct (Go), a TypeScript interface.
CONTAINER_KEYWORD = re.compile(r"\b(?:class|struct|interface|type|record|object)\s+$")
# What may precede a name that is declared, not mentioned, on its line: `async def `, `export function `.
DECLARATION_PREFIX = re.compile(r"^\s*(?:[a-z]+\s+)*$")
# Libraries that take one parameters object name it after the method: SendMessageParams.
PARAMETER_OBJECT_SUFFIXES = ("Params", "Parameters", "Options", "Request", "Args")
# Comments and docstrings name words that are not parameters ("after entities parsing"), and doc
# examples look like calls: they are blanked out, keeping every offset, before definitions are read.
NON_CODE = re.compile(r'"""[\s\S]*?"""|' + r"'''[\s\S]*?'''|/\*[\s\S]*?\*/|(?:^|(?<=\s))(?://|#)[^\n]*", re.M)
MAX_SIGNATURE_CHARS = 20_000
MAX_DEFINITION_LINES = 400
# Minified bundles put a whole library on one line; read only this much of a container's own line.
CONTAINER_LINE_CHARS = 400
# Declarations start near the beginning of their line: look this far back for keywords, no further,
# so a long line is not re-read for every match on it.
PREFIX_CHARS = 80

def words_of(name: str) -> list[str]:
    return [w.lower() for w in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", name.replace("-", "_")) if w]


def spellings(name: str) -> set[str]:
    words = words_of(name)
    if not words:
        return {name}
    camel = words[0] + "".join(w.capitalize() for w in words[1:])
    pascal = "".join(w.capitalize() for w in words)
    snake = "_".join(words)
    return {name, camel, pascal, snake}

def node_packages(root: Path) -> list[Path]:
    found: dict[str, Path] = {}
    for modules in root.rglob("node_modules"):
        try:
            depth = len(modules.relative_to(root).parts)
        except ValueError:
            continue
        if depth > SEARCH_DEPTH or not modules.is_dir() or "node_modules" in modules.parent.parts[len(root.parts):]:
            continue
        for package_json in list(modules.glob("*/package.json")) + list(modules.glob("@*/*/package.json")):
            name = package_json.parent.relative_to(modules).as_posix()
            if JS_NAMES.match(name):
                found.setdefault(str(package_json.parent.resolve()), package_json.parent.resolve())
        pnpm = modules / ".pnpm"
        if pnpm.is_dir():
            for package_json in list(pnpm.glob("*/node_modules/*/package.json")) + list(pnpm.glob("*/node_modules/@*/*/package.json")):
                name = package_json.parent.relative_to(package_json.parents[2] if package_json.parent.parent.name.startswith("@") else package_json.parents[1]).as_posix()
                if JS_NAMES.match(name):
                    found.setdefault(str(package_json.parent.resolve()), package_json.parent.resolve())
    return list(found.values())


def python_site_dirs(root: Path) -> list[Path]:
    dirs: list[Path] = []
    for venv in [root / ".venv", root / "venv", Path(os.environ["VIRTUAL_ENV"]) if os.environ.get("VIRTUAL_ENV") else None]:
        if venv and venv.is_dir():
            dirs += list(venv.glob("lib/python*/site-packages")) + list(venv.glob("Lib/site-packages"))
    try:
        out = subprocess.run(
            [sys.executable, "-c", "import site, json; print(json.dumps(site.getsitepackages() + [site.getusersitepackages()]))"],
            capture_output=True, text=True, timeout=20, check=True,
        )
        dirs += [Path(p) for p in json.loads(out.stdout)]
    except (subprocess.SubprocessError, ValueError):
        pass
    return [d for d in dict.fromkeys(dirs) if d.is_dir()]


def python_packages(root: Path) -> list[Path]:
    found = []
    for site in python_site_dirs(root):
        for child in site.iterdir():
            if child.is_dir() and PY_NAMES.match(child.name) and not child.name.endswith((".dist-info", ".egg-info")):
                found.append(child)
    return found


def go_modules(root: Path) -> list[Path]:
    found = []
    vendor = root / "vendor"
    if vendor.is_dir():
        found += [p for p in vendor.rglob("*") if p.is_dir() and GO_PATH.search(p.name) and p.parent.name != p.name][:20]
    go_mod = root / "go.mod"
    if go_mod.exists():
        try:
            cache = subprocess.run(["go", "env", "GOMODCACHE"], capture_output=True, text=True, timeout=20, check=True).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            cache = ""
        for line in go_mod.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^\s*(?:require\s+)?(\S+)\s+(v\S+)", line)
            if cache and match and GO_PATH.search(match.group(1)):
                path = Path(cache) / f"{match.group(1)}@{match.group(2)}"
                if path.is_dir():
                    found.append(path)
    return found


def describe(lib: Path) -> tuple[str, str, str | None]:
    """(name, version, declared Bot API version or None)."""
    package_json = lib / "package.json"
    if package_json.exists():
        data = json.loads(package_json.read_text(encoding="utf-8"))
        name, version = data.get("name", lib.name), data.get("version", "?")
        # @gramio/types follows the Bot API version number.
        declared = ".".join(version.split(".")[:2]) if name == "@gramio/types" else None
        return name, version, declared
    version, declared, return_name = "?", None, lib.name
    # The distribution may be named differently from its package (python-telegram-bot → telegram):
    # the one whose RECORD lists files of this package owns it.
    for record in lib.parent.glob("*.dist-info/RECORD"):
        if f"\n{lib.name}/" not in "\n" + record.read_text(encoding="utf-8", errors="ignore"):
            continue
        meta = (record.parent / "METADATA").read_text(encoding="utf-8", errors="ignore")
        name_match = re.search(r"^Name:\s*(.+)$", meta, re.M)
        version_match = re.search(r"^Version:\s*(.+)$", meta, re.M)
        return_name = name_match.group(1).strip() if name_match else lib.name
        version = version_match.group(1).strip() if version_match else "?"
        break
    for candidate, pattern in (
        (lib / "__meta__.py", r"__api_version__\s*=\s*['\"]([\d.]+)"),  # aiogram
        (lib / "constants.py", r"BOT_API_VERSION_INFO[^\n]*major=(\d+),\s*minor=(\d+)"),  # python-telegram-bot
    ):
        if candidate.exists():
            match = re.search(pattern, candidate.read_text(encoding="utf-8", errors="ignore"))
            if match:
                declared = ".".join(match.groups())
    return return_name, version, declared


class Query:
    """A bare name, or METHOD.PARAMETER."""

    def __init__(self, text: str) -> None:
        method, dot, name = text.rpartition(".")
        if not all(NAME.match(part) for part in ([method, name] if dot else [text])):
            raise argparse.ArgumentTypeError(f"'{text}' is not a name or METHOD.PARAMETER (e.g. sendMessage.ephemeral_message_parameters)")
        self.text = text
        self.method = method if dot else None
        self.name = name if dot else text


def alternation(forms: set[str]) -> str:
    return "|".join(map(re.escape, sorted(forms)))


def name_pattern(name: str) -> re.Pattern[str]:
    return re.compile(r"(?<![A-Za-z0-9_])(" + alternation(spellings(name)) + r")(?![A-Za-z0-9_])")


def method_pattern(method: str) -> re.Pattern[str]:
    pascal = "".join(w.capitalize() for w in words_of(method))
    forms = spellings(method) | {pascal + suffix for suffix in PARAMETER_OBJECT_SUFFIXES}
    return re.compile(r"(?<![A-Za-z0-9_])(" + alternation(forms) + r")(?![A-Za-z0-9_])")


def parameter_pattern(name: str) -> re.Pattern[str]:
    """The parameter as it is declared or passed: `chat_id: int`, `can_stop?:`, `text=`, `(e, text)`,
    a quoted key (`"chat_id": …`) or a struct tag (`json:"chat_id,omitempty"`). A quoted word alone is
    a value (`"static" | "video"`), not a parameter. PascalCase is left out on purpose: it is how
    types are named, and `message_id` must not match `MessageId`."""
    forms = alternation({form for form in spellings(name) if not form[:1].isupper()} | {name})
    return re.compile(
        r"(?<![\w.\"'`])(?:" + forms + r")[ \t]*\??[ \t]*[:=,)]"
        r"|[\"'](?:" + forms + r")[\"'][ \t]*:"
        r"|\b[a-z]+:\"(?:" + forms + r")(?:,[^\"\n]*)?\""
    )


def blank(match: re.Match[str]) -> str:
    return re.sub(r"[^\n]", " ", match.group())


def indentation(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip())


def block_lines(lines: list[str], start: int) -> range:
    """The body of the container declared on line `start`: the deeper-indented lines after it and
    the bracket that closes it at its own indentation."""
    base = indentation(lines[start])
    end = start + 1
    limit = min(len(lines), start + 1 + MAX_DEFINITION_LINES)
    while end < limit:
        line = lines[end]
        if line.strip() and indentation(line) <= base:
            if line.lstrip()[0] in ")]}":
                end += 1
            break
        end += 1
    return range(start + 1, end)


def signature_end(code: str, start: int) -> int:
    """Offset just past the brackets that open right after a definition's name: the parameter list,
    without the body or the return type that follow it."""
    depth = 0
    limit = min(len(code), start + MAX_SIGNATURE_CHARS)
    for index in range(start, limit):
        char = code[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth <= 0:
                return index + 1
        elif depth == 0 and char in ";\n":
            return index
    return limit


class SourceFile:
    def __init__(self, relative: str, text: str) -> None:
        self.relative = relative
        self.text = text
        # Split on "\n" only, so line numbers agree with the offsets (splitlines also breaks on   and others).
        self.lines = text.split("\n")
        self.line_starts = [0] + [match.end() for match in re.finditer("\n", text)]
        self._code: str | None = None

    @property
    def code(self) -> str:
        """The text with comments and docstrings blanked out: same length, same line breaks."""
        if self._code is None:
            self._code = NON_CODE.sub(blank, self.text)
        return self._code

    def line_of(self, offset: int) -> int:
        return bisect.bisect_right(self.line_starts, offset) - 1

    def line_end(self, line: int) -> int:
        return self.line_starts[line + 1] - 1 if line + 1 < len(self.line_starts) else len(self.text)

    def location(self, offset: int) -> str:
        line = self.line_of(offset)
        text = self.lines[line].rstrip()
        if len(text.strip()) <= SNIPPET_CHARS:
            snippet = text.strip()
        else:  # a long line, often minified: show the match, not the start of the line
            start = max(0, offset - self.line_starts[line] - SNIPPET_CHARS // 3)
            snippet = ("…" if start else "") + text[start : start + SNIPPET_CHARS].strip() + "…"
        return f"{self.relative}:{line + 1}  {snippet}"

    def definitions(self, method: re.Pattern[str]):
        """(match, is a container, is declared on its line) for every definition-like occurrence."""
        code = self.code
        for match in method.finditer(code):
            line_start = self.line_starts[self.line_of(match.start())]
            near_start = match.start() - line_start <= PREFIX_CHARS
            prefix = code[max(line_start, match.start() - PREFIX_CHARS) : match.start()]
            container = bool(CONTAINER_KEYWORD.search(prefix))
            if container or DEFINITION_TAIL.match(code, match.end()):
                yield match, container, container or (near_start and bool(DECLARATION_PREFIX.match(prefix)))

    def declaration(self, method: re.Pattern[str]) -> tuple[int, bool] | None:
        """The definition to show the reader: a declaration if there is one, else the first call-like use."""
        first = None
        for match, _, declared in self.definitions(method):
            if declared:
                return match.start(), True
            if first is None:
                first = match.start()
        return (first, False) if first is not None else None

    def spans(self, match: re.Match[str], container: bool):
        if not container:
            yield match.end(), signature_end(self.code, match.end())
            return
        line = self.line_of(match.start())
        yield match.end(), min(self.line_end(line), match.end() + CONTAINER_LINE_CHARS)
        body = block_lines(self.code.split("\n"), line)
        if body:
            yield self.line_starts[body.start], self.line_end(body.stop - 1)

    def parameter_in_definition(self, method: re.Pattern[str], parameter: re.Pattern[str]) -> tuple[int, int] | None:
        """(definition offset, parameter offset) of the first definition of `method` that lists `parameter`."""
        for match, container, _ in self.definitions(method):
            for start, end in self.spans(match, container):
                found = parameter.search(self.code, start, end)
                if found:
                    return match.start(), found.start()
        return None


class Finding:
    def __init__(self, query: Query) -> None:
        self.query = query
        self.locations: list[str] = []  # bare name: where it occurs
        self.together: tuple[str, str] | None = None  # METHOD.PARAMETER: (parameter, definition)
        self.method_at: str | None = None  # its declaration; a call-like use or a mention until one is seen
        self.method_defined = False
        self.name_at: str | None = None

    @property
    def found(self) -> bool:
        return bool(self.locations) if self.query.method is None else self.together is not None

    @property
    def anything(self) -> bool:
        return bool(self.locations or self.together or self.method_at or self.name_at)

    @property
    def settled(self) -> bool:
        return len(self.locations) >= LOCATIONS_SHOWN if self.query.method is None else self.together is not None

    def report(self) -> list[str]:
        query = self.query
        if query.method is None:
            if not self.locations:
                return [f"  MISSING {query.text}"]
            return [f"  found   {query.text}"] + [f"            {where}" for where in self.locations]
        if self.together:
            parameter_at, definition_at = self.together
            if parameter_at == definition_at:
                return [f"  found   {query.text}  (on the definition line)", f"            {parameter_at}"]
            return [f"  found   {query.text}", f"            {parameter_at}", f"            inside {definition_at}"]
        if self.method_at is None:
            return [f"  MISSING {query.text}  ({query.method} not found)"]
        lines = [f"  MISSING {query.text}  ({query.name} is not a parameter of any definition of {query.method})", f"            {query.method}: {self.method_at}"]
        lines.append(f"            {query.name}: {self.name_at}" if self.name_at else f"            {query.name}: not mentioned anywhere")
        return lines


def search(lib: Path, queries: list[Query]) -> list[Finding]:
    findings = [Finding(query) for query in queries]
    names = {query.name: name_pattern(query.name) for query in queries}
    methods = {query.method: method_pattern(query.method) for query in queries if query.method}
    parameters = {query.name: parameter_pattern(query.name) for query in queries if query.method}
    for path in sorted(lib.rglob("*")):
        if all(finding.settled for finding in findings):
            break
        if path.suffix not in CODE_SUFFIXES or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            continue
        relative = path.relative_to(lib)
        if "node_modules" in relative.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if not any(pattern.search(text) for pattern in [*names.values(), *methods.values()]):
            continue
        source = SourceFile(relative.as_posix(), text)
        for finding in findings:
            if finding.settled:
                continue
            query, name = finding.query, names[finding.query.name]
            if query.method is None:
                for match in name.finditer(text):
                    where = source.location(match.start())
                    if where not in finding.locations:
                        finding.locations.append(where)
                    if finding.settled:
                        break
                continue
            method = methods[query.method]
            if not finding.method_defined:
                shown = source.declaration(method)
                if shown and (shown[1] or finding.method_at is None):
                    finding.method_at, finding.method_defined = source.location(shown[0]), shown[1]
                elif finding.method_at is None and (match := method.search(text)):
                    finding.method_at = source.location(match.start())
            if finding.name_at is None and (match := name.search(text)):
                finding.name_at = source.location(match.start())
            pair = source.parameter_in_definition(method, parameters[query.name])
            if pair:
                finding.together = (source.location(pair[1]), source.location(pair[0]))
    return findings


def utf8_output() -> None:
    """Print UTF-8 whatever the platform. A Windows pipe defaults to the ANSI code page (cp1251,
    cp1252), which cannot encode the emoji and symbols on Telegram's pages and in library code,
    and the agent reading the output decodes UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure") and (stream.encoding or "").lower().replace("-", "") != "utf8":
            stream.reconfigure(encoding="utf-8")


def main() -> int:
    utf8_output()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("queries", nargs="+", type=Query, metavar="QUERY", help="NAME or METHOD.PARAMETER")
    parser.add_argument("--root", default=".", help="project directory to look in")
    parser.add_argument("--lib", action="append", default=[], help="a library directory to search as well")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    libs = node_packages(root) + python_packages(root) + go_modules(root) + [Path(p).resolve() for p in args.lib]
    libs = list(dict.fromkeys(libs))
    if not libs:
        print("No Telegram library found. Pass its directory with --lib, or check the project root (--root).")
        return 2

    missing_everywhere = {query.text for query in args.queries}
    silent: list[str] = []
    for lib in libs:
        name, version, declared = describe(lib)
        findings = search(lib, args.queries)
        if not any(finding.anything for finding in findings):
            silent.append(f"{name} {version}")
            continue
        api = f", declares Bot API {declared}" if declared else ""
        print(f"{name} {version}{api}  [{lib}]")
        for finding in findings:
            print("\n".join(finding.report()))
            if finding.found:
                missing_everywhere.discard(finding.query.text)
    if silent:
        print("No match at all in: " + ", ".join(silent))
    if any(query.method for query in args.queries):
        print("\nMETHOD.PARAMETER is read from the code around each definition, not by parsing the language:")
        print("open the lines shown before relying on a verdict. found = the library can send it, not that Telegram")
        print("still accepts it: libraries keep replaced parameters as deprecated, and the method page decides.")
        print("A library that takes optional parameters as one object typed elsewhere (grammY core's `other`,")
        print("node-telegram-bot-api's `form`, PHP arrays) shows MISSING here: look at its types package or its code.")
    if missing_everywhere:
        print("\nNot known to any installed library: " + ", ".join(sorted(missing_everywhere)))
        for query in args.queries:
            if query.text not in missing_everywhere:
                continue
            if query.method:
                print(f"  {query.text}: on the method page? tgdocs.py method {query.method} · renamed or replaced? tgdocs.py history {query.name}")
            else:
                print(f"  {query.text}: in the docs? tgdocs.py search {query.text} · renamed or replaced? tgdocs.py history {query.text}")
        print("If the docs list it, check the library's changelog for a newer release, otherwise call the method raw")
        print("(references/freshness.md).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
