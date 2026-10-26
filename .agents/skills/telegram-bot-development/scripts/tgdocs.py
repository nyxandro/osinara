#!/usr/bin/env python3
"""Read the official Telegram documentation live, in its Markdown form.

Telegram serves almost every page of core.telegram.org as Markdown at the same
URL plus `.md` (see https://core.telegram.org/llms.txt). This tool fetches those
pages so that an agent works from the current Bot API instead of its memory.

Commands:
  latest [--count N]            newest Bot API versions with their dates
  changes --since VERSION       everything the changelog added after VERSION
  changes --version VERSION     one changelog entry
  method NAME                   one method page, e.g. sendMessageDraft
  type NAME                     one type page, e.g. EphemeralMessageParameters
  search TERM                   methods and types whose name or summary match, across
                                the index and every reference page it links to
  history TERM                  every changelog line that mentions TERM, by version
  page PATH [--toc] [--section TITLE]
                                any page, e.g. bots/features, bots/webapps, bots/faq
  index                         the official map of documentation pages (llms.txt)
  terms [--toc] [--section NUMBER]
                                the Bot Platform Developer Terms (telegram.org, HTML only),
                                one clause verbatim, e.g. --section 6.2.6

Pages are cached for a few hours in ~/.cache/telegram-bot-docs; pass --fresh
to bypass the cache. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import os
import re
import shlex
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

BASE = "https://core.telegram.org/"
# The developer terms live outside the docs and have no Markdown form: telegram.org answers
# `bot-developers.md` with a redirect to the general Terms of Service and a 200.
TERMS_URL = "https://telegram.org/tos/bot-developers"
TERMS_TITLE = "Telegram Bot Platform Developer Terms of Service"
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "telegram-bot-docs"
# Long enough to make a working session cheap, short enough to see a release the same day.
CACHE_TTL_SECONDS = 6 * 3600
TIMEOUT_SECONDS = 30
USER_AGENT = "telegram-bot-development-skill/1 (+https://core.telegram.org/llms.txt)"

DATE_HEADING = re.compile(r"^####\s+(.+?)\s*$")
VERSION_LINE = re.compile(r"^\*\*Bot API (\d+(?:\.\d+)*)\*\*\s*$")
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
# A heading may also open a list item, as on bots/webhooks: "* #### An open port".
SECTION_HEADING = re.compile(r"^(?:[*+-][ \t]+)?(#{1,6})\s+(.+?)\s*$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


class DocsError(Exception):
    pass


class PageNotFound(DocsError):
    pass


def page_url(path: str) -> str:
    path = path.strip()
    if re.search(r"[\s\x00-\x1f\x7f]", path):
        raise DocsError(f"{path!r} is not a docs path: it has spaces or control characters (paths look like bots/webhooks).")
    if path.startswith("https://telegram.org/"):
        return path  # outside the docs, such as TERMS_URL: fetched as it is
    if path.startswith(BASE):
        path = path[len(BASE):]
    path = path.lstrip("/").split("#", 1)[0]
    if not path.endswith((".md", ".txt")):
        path += ".md"
    return BASE + path


def fetch(path: str, fresh: bool, allow_stale: bool) -> str:
    url = page_url(path)
    cached = CACHE_DIR / (hashlib.sha256(url.encode()).hexdigest()[:24] + ".md")
    # A 404 is remembered as long as a page is, so probing for a name that has no page costs nothing twice.
    missing = cached.with_suffix(".404")
    if not fresh and missing.exists() and time.time() - missing.stat().st_mtime < CACHE_TTL_SECONDS:
        raise PageNotFound(f"{url} does not exist (404, remembered). Try `search` or `index` to find the page.")
    if not fresh and cached.exists() and time.time() - cached.stat().st_mtime < CACHE_TTL_SECONDS:
        return cached.read_text(encoding="utf-8")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            update_cache("remember the 404 in the cache", lambda: touch(missing))
            raise PageNotFound(f"{url} does not exist (404). Try `search` or `index` to find the page.") from error
        failure, hint, cause = f"{url} answered HTTP {error.code}", "", error
    # Besides a failed connection (URLError), a download can break off midway: a reset, a short
    # read, or a read timeout — which on Python 3.8 is socket.timeout, not a TimeoutError.
    except (OSError, http.client.HTTPException) as error:
        failure, hint, cause = f"cannot reach {url}: {error}", "", error
        if isinstance(getattr(error, "reason", None), ssl.SSLCertVerificationError):
            # The network is fine; this Python cannot verify HTTPS certificates.
            hint = (
                " This Python does not trust the site's certificate. On macOS with Python from python.org, run"
                " 'Install Certificates.command' in its Applications folder; behind a corporate proxy, point"
                " SSL_CERT_FILE at the proxy's CA bundle."
            )
    else:
        update_cache("update the cache", lambda: write_cache(cached, text))
        if missing.exists():
            update_cache("clear the remembered 404", missing.unlink)
        return text
    # The page could not be had now: a server error or a broken connection, not a missing page.
    if allow_stale and cached.exists():
        age_h = (time.time() - cached.stat().st_mtime) / 3600
        print(f"[tgdocs] {failure}; using a cached copy {age_h:.1f} h old", file=sys.stderr)
        return cached.read_text(encoding="utf-8")
    if cached.exists():
        hint += " A cached copy exists: rerun with --allow-stale and say so."
    raise DocsError(f"{failure}.{hint}") from cause


def update_cache(action: str, change: Callable[[], object]) -> None:
    """Make one change to the cache. The cache only saves downloads: when it cannot be written —
    a read-only folder, or Windows refusing to replace a file another run has open — say so and
    carry on with the answer, which is current either way."""
    try:
        change()
    except OSError as error:
        print(f"[tgdocs] could not {action} ({error}); the answer itself is current", file=sys.stderr)


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()


def write_cache(path: Path, text: str) -> None:
    """Replace a cached page in one step, so that another run reading it — or the next run after
    a crash — never sees half a page."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, str(path))
    except BaseException:
        os.unlink(temporary)
        raise


VERSION_ARGUMENT = re.compile(r"^\d+(?:\.\d+)*$")


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def version_argument(value: str) -> str:
    if not VERSION_ARGUMENT.match(value):
        raise argparse.ArgumentTypeError(f"'{value}' is not a Bot API version; pass a number like 9.6 or 10.3 (see `latest`)")
    return value


def changelog_entries(text: str) -> list[dict]:
    """Changelog entries, newest first: date, version (None for old unnumbered ones), lines."""
    entries: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        date = DATE_HEADING.match(line)
        if date:
            current = {"date": date.group(1), "version": None, "lines": []}
            entries.append(current)
            continue
        if line.startswith("### ") and current is not None:
            current = None  # a year heading closes the entry
            continue
        if current is None:
            continue
        version = VERSION_LINE.match(line)
        if version and current["version"] is None:
            current["version"] = version.group(1)
            continue
        current["lines"].append(line)
    return entries


def print_entry(entry: dict) -> None:
    title = f"Bot API {entry['version']}" if entry["version"] else "(unnumbered)"
    print(f"## {title} — {entry['date']}")
    body = "\n".join(entry["lines"]).strip()
    print(re.sub(r"\n{3,}", "\n\n", body))
    print()


def cmd_latest(args: argparse.Namespace) -> None:
    entries = [e for e in changelog_entries(fetch("bots/api-changelog", args.fresh, args.allow_stale)) if e["version"]]
    if not entries:
        raise DocsError("no versions found in the changelog: its format may have changed; read `page bots/api-changelog`.")
    print(f"Latest Bot API: {entries[0]['version']} ({entries[0]['date']})")
    for entry in entries[1 : args.count]:
        print(f"  {entry['version']} — {entry['date']}")


def cmd_changes(args: argparse.Namespace) -> None:
    entries = changelog_entries(fetch("bots/api-changelog", args.fresh, args.allow_stale))
    if args.version:
        found = [e for e in entries if e["version"] == args.version]
        if not found:
            raise DocsError(f"no changelog entry for Bot API {args.version}; run `latest` to see the versions.")
        print_entry(found[0])
        return
    since = version_key(args.since)
    newer = [e for e in entries if e["version"] and version_key(e["version"]) > since]
    if not newer:
        print(f"Nothing newer than Bot API {args.since}.")
        return
    for entry in newer:
        print_entry(entry)


def cmd_method(args: argparse.Namespace) -> None:
    print(fetch(f"bots/api/methods/{args.name.lower()}", args.fresh, args.allow_stale))


def cmd_type(args: argparse.Namespace) -> None:
    print(fetch(f"bots/api/types/{args.name.lower()}", args.fresh, args.allow_stale))


INDEX_LINE = re.compile(r"^- \[([^\]]+)\]\((/bots/api/(methods|types)/[^)]+)\)(?::\s*(.*))?$")
# Reference pages the main index links to (types, rich messages, …). Telegram keeps some families
# off the main indexes — every rich-message method and type lives only on its own page — so the
# search follows the links instead of trusting a fixed list.
INDEX_SUBPAGE_LINK = re.compile(r"\(/bots/api/([a-z0-9-]+)\.md(?:#[^)]*)?\)")
KIND_BY_DIRECTORY = {"methods": "method", "types": "type"}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def index_pages(fresh: bool, allow_stale: bool) -> list[str]:
    main = fetch("bots/api", fresh, allow_stale)
    pages = [main]
    linked = [f"bots/api/{name}" for name in INDEX_SUBPAGE_LINK.findall(main)]
    for path in dict.fromkeys(["bots/api/types", *linked]):
        try:
            pages.append(fetch(path, fresh, allow_stale))
        except PageNotFound:
            # A dead link on Telegram's side must not hide the pages that do exist.
            print(f"[tgdocs] the index links to {path}, which is gone (404); searched the other pages", file=sys.stderr)
    return pages


def exact_page(name: str, fresh: bool, allow_stale: bool) -> tuple[str, str, str] | None:
    """(kind, title, url) of the method or type page with exactly this name, if one exists."""
    slug = name.lower().replace("_", "")
    for directory, kind in KIND_BY_DIRECTORY.items():
        path = f"bots/api/{directory}/{slug}"
        try:
            text = fetch(path, fresh, allow_stale)
        except PageNotFound:
            continue
        except DocsError as error:
            raise DocsError(f"the indexes have no '{name}', and I could not check whether a page with that name exists: {error}") from error
        title = next((m.group(2) for m in map(HEADING.match, text.splitlines()) if m), name)
        return kind, title, page_url(path)
    return None


def cmd_search(args: argparse.Namespace) -> None:
    term = args.term.lower().replace("_", "")
    seen: set[str] = set()
    exact_hit = False
    for text in index_pages(args.fresh, args.allow_stale):
        for line in text.splitlines():
            match = INDEX_LINE.match(line.strip())
            if not match:
                continue
            name, link, directory, summary = match.group(1), match.group(2), match.group(3), match.group(4) or ""
            if link in seen or not (term in name.lower().replace("_", "") or term in summary.lower()):
                continue
            seen.add(link)
            exact_hit = exact_hit or name.lower().replace("_", "") == term
            print(f"{KIND_BY_DIRECTORY[directory]:6} {name} — {summary}  ({BASE.rstrip('/')}{link})")
    # A name no index lists may still have its own page (whole families have been left off them).
    found = exact_page(args.term, args.fresh, args.allow_stale) if not exact_hit and IDENTIFIER.match(args.term) else None
    if found:
        kind, title, url = found
        print(f"{kind:6} {title} — not listed in the indexes, but its page exists  ({url})")
    elif not seen:
        print(f"No method or type is named or described by '{args.term}'.")
    print(f"(Names and one-line summaries only. Parameters and fields: `history {shlex.quote(args.term)}` and the method pages.)")


def cmd_history(args: argparse.Namespace) -> None:
    term = args.term.lower()
    hits = 0
    for entry in changelog_entries(fetch("bots/api-changelog", args.fresh, args.allow_stale)):
        for line in entry["lines"]:
            if term in line.lower():
                version = entry["version"] or "?"
                print(f"{version:>6} ({entry['date']}): {line.strip()}")
                hits += 1
    if hits == 0:
        print(f"The changelog never mentions '{args.term}' (it may be older than the changelog, or misspelled).")


def sections(text: str) -> list[tuple[int, str, int]]:
    """(level, title, line index) of every heading outside fenced code blocks, whose shell
    comments (`# install the CLI`) look like headings too."""
    found = []
    fence = None  # the marker that opened the code block we are in
    for index, line in enumerate(text.splitlines()):
        marker = FENCE.match(line)
        if fence:
            # Only a run of the same character, at least as long and alone on its line, closes it.
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and not line[marker.end():].strip():
                fence = None
            continue
        if marker and not (marker.group(1)[0] == "`" and "`" in line[marker.end():]):  # ```x``` is inline code
            fence = marker.group(1)
            continue
        match = SECTION_HEADING.match(line)
        if match:
            found.append((len(match.group(1)), match.group(2), index))
    return found


CLAUSE_NUMBER = re.compile(r"^(\d+(?:\.\d+)*)\.?(?=\s|$)")


def heading_matches(title: str, wanted: str, by_clause_number: bool) -> bool:
    wanted = wanted.strip().lower()
    if by_clause_number and re.fullmatch(r"\d+(?:\.\d+)*\.?", wanted):
        # A clause number names exactly one clause: 6.2 is not 6.2.6, and 2.1 is not 12.1.
        number = CLAUSE_NUMBER.match(title)
        return bool(number) and number.group(1) == wanted.rstrip(".")
    return title.lower() == wanted or (wanted in title.lower() and len(wanted) > 3)


def print_toc(text: str) -> None:
    for level, title, _ in sections(text):
        print("  " * (level - 1) + "- " + title)


def print_section(text: str, wanted: str, where: str, by_clause_number: bool = False) -> None:
    lines = text.splitlines()
    heads = sections(text)
    for position, (level, title, index) in enumerate(heads):
        if heading_matches(title, wanted, by_clause_number):
            end = len(lines)
            for later_level, _, later_index in heads[position + 1 :]:
                if later_level <= level:
                    end = later_index
                    break
            print("\n".join(lines[index:end]).strip())
            return
    raise DocsError(f"no section '{wanted}' in {where}; run with --toc to list them.")


def cmd_page(args: argparse.Namespace) -> None:
    if not page_url(args.path).startswith(BASE):
        raise DocsError(f"{args.path} is not a page of the docs; for the developer terms use `tgdocs.py terms`.")
    text = fetch(args.path, args.fresh, args.allow_stale)
    if args.toc:
        print_toc(text)
    elif args.section:
        print_section(text, args.section, args.path)
    else:
        print(text)


class TermsParser(HTMLParser):
    """The page title, and the content block of the terms page as blocks: (tag, list depth, lines),
    one per heading, paragraph, list item or run of loose text, with a line per <br>. Navigation and
    the footer, which has headings of its own, sit outside the content block and are skipped."""

    BLOCKS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "td", "th", "dt", "dd"}
    # Their edges end any text before them, so loose text on either side stays its own paragraph.
    CONTAINERS = {"div", "blockquote", "ul", "ol", "dl", "table", "tr", "section", "article"}
    SKIPPED = {"script", "style"}

    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.in_title = False
        self.skipping: str | None = None
        self.content_seen = False
        self.content_depth = 0  # <div>s open inside the content block; 0 outside it
        self.list_depth = 0
        self.block: str | None = None
        self.block_depth = 0
        self.parts: list[str] = []
        self.blocks: list[tuple[str, int, list[str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self.in_title = True
        elif tag in self.SKIPPED:
            self.skipping = tag
        elif tag == "div" and not self.content_depth and dict(attrs).get("id") == "dev_page_content":
            self.content_seen, self.content_depth = True, 1
        elif not self.content_depth:
            return
        elif tag in self.BLOCKS or tag in self.CONTAINERS:
            self.flush()  # a list nested in a list item ends the item's own text
            self.content_depth += tag == "div"
            self.list_depth += tag in ("ul", "ol")
            if tag in self.BLOCKS:
                self.block, self.block_depth = tag, self.list_depth
        elif tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        elif tag == self.skipping:
            self.skipping = None
        elif not self.content_depth:
            return
        elif tag == self.block or tag in self.CONTAINERS:
            self.flush()
            self.content_depth -= tag == "div"
            self.list_depth -= tag in ("ul", "ol") and self.list_depth > 0

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        elif self.skipping or not self.content_depth:
            return
        elif self.block:
            self.parts.append(data.replace("\n", " "))
        elif data.strip():
            # Text outside any paragraph — after a nested list, bare in a quote or a <div> — is part
            # of the terms too; dropping it would make a clause look complete when it is not.
            self.block, self.block_depth, self.parts = "text", self.list_depth, [data.replace("\n", " ")]

    def flush(self) -> None:
        lines = [" ".join(line.split()) for line in "".join(self.parts).split("\n")]
        lines = [line for line in lines if line]
        if self.block and lines:
            self.blocks.append((self.block, self.block_depth, lines))
        self.block, self.parts = None, []


def terms_markdown(page: str) -> str:
    """The developer terms as Markdown, with each clause a heading as deep as its number:
    6. is #, 6.2. is ##, 6.2.6. is ###. The page's own tags do not say this — it sets 6.2.6
    and 6.3 in the same <h4> — so sections are cut by number."""
    parser = TermsParser()
    parser.feed(page)
    parser.close()
    retry = " Retry once with --fresh (the answer is cached); if it persists, read the clause in a browser and say in the answer that this tool could not."
    title = " ".join(parser.title.split())
    if title != TERMS_TITLE:
        raise DocsError(f"{TERMS_URL} returned '{title or 'a page without a title'}', not the {TERMS_TITLE}.{retry}")
    if not parser.content_seen or parser.content_depth:
        # An unclosed content block means a page cut short, or a layout the parser no longer follows:
        # a clause printed from it could silently miss its end.
        state = "does not close" if parser.content_seen else "is missing"
        raise DocsError(f"the content block of {TERMS_URL} {state}: the page was cut short or its layout changed.{retry}")
    out = []
    for tag, list_depth, lines in parser.blocks:
        if tag[0] == "h":
            text = " ".join(lines)
            number = CLAUSE_NUMBER.match(text)
            # An unnumbered heading closes the clause before it rather than joining it.
            level = len(number.group(1).split(".")) if number else 1
            out.append("#" * min(level, 6) + " " + text)
            continue
        indent = "  " * max(list_depth - (tag == "li"), 0)
        first = indent + ("- " if tag == "li" else "")
        block = [first + lines[0]] + [" " * len(first) + line for line in lines[1:]]
        # A paragraph that reads like a Markdown heading or code fence must not cut or hide a section.
        out.append("\n".join("\\" + line if SECTION_HEADING.match(line) or FENCE.match(line) else line for line in block))
    if not any(line.startswith("#") for line in out):
        raise DocsError(f"no clauses found on {TERMS_URL}: the page layout may have changed; read it in a browser.")
    return "\n\n".join(out)


def cmd_terms(args: argparse.Namespace) -> None:
    try:
        page = fetch(TERMS_URL, args.fresh, args.allow_stale)
    except PageNotFound as error:
        raise DocsError(
            f"the developer terms are gone from {TERMS_URL} (404): Telegram may have moved them. Look for them"
            " from https://telegram.org/tos and say in the answer that this tool could not read them."
        ) from error
    text = terms_markdown(page)
    if args.toc:
        print_toc(text)
    elif args.section:
        print_section(text, args.section, "the developer terms", by_clause_number=True)
    else:
        print(text)
    print(f"\n(Source: {TERMS_TITLE}, {TERMS_URL})")


def cmd_index(args: argparse.Namespace) -> None:
    print(fetch("llms.txt", args.fresh, args.allow_stale))


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
    parser.add_argument("--fresh", action="store_true", help="bypass the cache")
    parser.add_argument("--allow-stale", action="store_true", help="use a cached copy when the network fails")
    commands = parser.add_subparsers(dest="command", required=True)

    latest = commands.add_parser("latest")
    latest.add_argument("--count", type=int, default=5)
    latest.set_defaults(run=cmd_latest)

    changes = commands.add_parser("changes")
    group = changes.add_mutually_exclusive_group(required=True)
    group.add_argument("--since", type=version_argument, help="print every version newer than this one, e.g. 9.6")
    group.add_argument("--version", type=version_argument, help="print exactly this version, e.g. 10.3")
    changes.set_defaults(run=cmd_changes)

    for name, run in (("method", cmd_method), ("type", cmd_type)):
        sub = commands.add_parser(name)
        sub.add_argument("name")
        sub.set_defaults(run=run)

    search = commands.add_parser("search")
    search.add_argument("term")
    search.set_defaults(run=cmd_search)

    history = commands.add_parser("history")
    history.add_argument("term")
    history.set_defaults(run=cmd_history)

    page = commands.add_parser("page")
    page.add_argument("path", help="e.g. bots/features, bots/webapps, bots/api/formatting")
    page.add_argument("--toc", action="store_true", help="list the headings only")
    page.add_argument("--section", help="print one section by its heading")
    page.set_defaults(run=cmd_page)

    index = commands.add_parser("index")
    index.set_defaults(run=cmd_index)

    terms = commands.add_parser("terms")
    terms.add_argument("--toc", action="store_true", help="list the numbered clauses only")
    terms.add_argument("--section", help="print one clause with its subclauses, e.g. 6.2.6, or by heading")
    terms.set_defaults(run=cmd_terms)

    args = parser.parse_args()
    try:
        args.run(args)
    except DocsError as error:
        print(f"[tgdocs] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
