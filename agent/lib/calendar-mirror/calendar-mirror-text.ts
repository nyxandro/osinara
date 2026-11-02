/**
 * Reminder text as Google Calendar shows it, and back.
 *
 * Exports:
 * - `reminderPlainText`: the reminder without markup; links keep their address, files become «📎 подпись».
 * - `copyTitle`: «🔔 » and the first line, bounded for the calendar grid.
 * - `titleFromSummary`, `contentWithTitle`: a title a person typed in Google, put back as the first line.
 * - `contentFromEvent`: text of a reminder made from a person's own event, or null without words.
 */
import type { Nodes } from "mdast";

import { REMINDER_CONTENT_MAX_LENGTH } from "../reminders/reminder-config.js";
import { readMarkdownTree } from "../markdown-syntax.js";
import { stripTelegramAsideDirectives } from "../telegram-authored-split.js";
import {
  CALENDAR_MIRROR_COPY_FOOTER,
  CALENDAR_MIRROR_TITLE_MAX,
  CALENDAR_MIRROR_TITLE_PREFIX,
} from "./calendar-mirror-config.js";

// A label for the calendar grid only; the reminder itself keeps its text.
const EMPTY_TITLE = "Напоминание";

function inlineText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "break":
      return "\n";
    case "image":
      return `📎 ${node.alt?.trim() || "файл"}`;
    case "link": {
      const label = node.children.map(inlineText).join("");
      return label === node.url || label === "" ? node.url : `${label} (${node.url})`;
    }
    case "html":
      return "";
    default:
      return "children" in node ? (node.children as Nodes[]).map(inlineText).join("") : "";
  }
}

function blockLines(node: Nodes): string[] {
  if (node.type === "list") {
    return node.children.flatMap((item) => blockLines(item).map((line, index) => index === 0 ? `• ${line}` : line));
  }
  if (node.type === "listItem" || node.type === "blockquote") {
    return node.children.flatMap(blockLines);
  }
  if (node.type === "thematicBreak") return [];
  return inlineText(node).split("\n");
}

export function reminderPlainText(content: string): string {
  const tree = readMarkdownTree(stripTelegramAsideDirectives(content));
  return tree.children
    .flatMap(blockLines)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function bounded(text: string): string {
  const characters = [...text];
  return characters.length <= CALENDAR_MIRROR_TITLE_MAX
    ? text
    : `${characters.slice(0, CALENDAR_MIRROR_TITLE_MAX - 1).join("")}…`;
}

export function copyTitle(content: string): string {
  const firstLine = reminderPlainText(content).split("\n")[0] ?? "";
  return `${CALENDAR_MIRROR_TITLE_PREFIX}${bounded(firstLine.trim() || EMPTY_TITLE)}`;
}

/** The title a person left in Google, without the bell the bot puts in front. */
export function titleFromSummary(summary: string | undefined): string {
  const text = (summary ?? "").replace(/^\s*🔔\s*/u, "").replace(/\s+/gu, " ").trim();
  return text;
}

/**
 * The reminder text with a title renamed in Google. The first line is replaced only when it is the
 * line the calendar showed; a first line it does not show (a file, a directive) stays, and the new
 * title goes above it.
 */
export function contentWithTitle(content: string, title: string): string {
  const lines = content.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return title;
  const shownFirst = reminderPlainText(content).split("\n")[0] ?? "";
  if (reminderPlainText(lines[first]!) === shownFirst && !/!\[[^\]]*\]\(/u.test(lines[first]!)) {
    lines[first] = title;
    return lines.join("\n").slice(0, REMINDER_CONTENT_MAX_LENGTH);
  }
  return `${title}\n${content}`.slice(0, REMINDER_CONTENT_MAX_LENGTH);
}

/**
 * Text of a reminder made from a person's own event: the title, then the event's notes. A copy the
 * person brought back from Google's bin carries the bot's own description: its footer and the
 * repeated title are dropped. Null when the event has no words at all; nothing is made up for it.
 */
export function contentFromEvent(summary: string | undefined, description: string | undefined): string | null {
  const title = titleFromSummary(summary);
  const lines = (description ?? "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .filter((line) => line !== CALENDAR_MIRROR_COPY_FOOTER);
  while (lines[0] === "") lines.shift();
  if (title !== "" && lines[0] === title) lines.shift();
  const notes = lines.join("\n").trim();
  const text = [title, notes].filter((part) => part !== "").join("\n\n");
  return text === "" ? null : text.slice(0, REMINDER_CONTENT_MAX_LENGTH);
}
