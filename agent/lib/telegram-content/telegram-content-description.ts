/**
 * What the model reads for a Telegram message that is not plain text.
 *
 * Exports:
 * - `telegramContentDescription`: one line per kind of content Telegram sent — a place, a point, a
 *   contact, a poll, a die, a checklist, a sticker, a GIF, a video, a video note, a voice note,
 *   audio, a story and the rare kinds — or `null` when the message is text, a photo or a document,
 *   which reach the model by their own route.
 * - `telegramMessageContextNote`: who a message was forwarded from, a reply to another chat or to a
 *   story, or `null`.
 * - `isTelegramMediaPlaceholderOnly`: whether a text is nothing but media placeholders.
 *
 * Key constructs:
 * - The lines are written by the server from Telegram's fields, so they stay in Russian like every
 *   text the boundary puts in place of words a person did not write (`telegram-model-placeholders.ts`).
 * - A media placeholder is bracketed: `[стикер 😂]` says what arrived, not what it shows; a place,
 *   a contact or a poll carries its content and gets a marker instead.
 * - Every field a participant typed is folded to one line and bounded, and no file identifier is
 *   ever printed: the description is data for the model, never a handle on the file.
 */

const FIELD_MAX_LENGTH = 200;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
// Telegram marks a live location shared until it is stopped by hand with this period.
const LIVE_PERIOD_UNTIL_STOPPED = 0x7fffffff;
const MEDIA_PLACEHOLDER_LINE = /^\[[^\]\n]*\]$/u;

type Raw = Readonly<Record<string, unknown>>;

function record(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const folded = value.replace(/\s+/gu, " ").trim();
  if (!folded) return null;
  return folded.length > FIELD_MAX_LENGTH ? `${folded.slice(0, FIELD_MAX_LENGTH)}…` : folded;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function duration(value: unknown): string | null {
  const seconds = finite(value);
  if (seconds === null || seconds < 0) return null;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const rest = String(whole % SECONDS_PER_MINUTE).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function quoted(value: string | null): string | null {
  return value === null ? null : `«${value}»`;
}

function coordinates(location: Raw | null): string | null {
  const latitude = finite(location?.latitude);
  const longitude = finite(location?.longitude);
  return latitude === null || longitude === null ? null : `${latitude}, ${longitude}`;
}

function venue(raw: Raw): string {
  const title = quoted(text(raw.title));
  const address = text(raw.address);
  const type = text(raw.foursquare_type) ?? text(raw.google_place_type);
  const place = [title, address].filter(Boolean).join(", ");
  const point = coordinates(record(raw.location));
  return `📍 Место ${place || "без названия"}${type ? ` (${type})` : ""}${point ? ` — ${point}` : ""}`;
}

function location(raw: Raw): string {
  const parts = [`📍 Геопозиция ${coordinates(raw) ?? "без координат"}`];
  const accuracy = finite(raw.horizontal_accuracy);
  if (accuracy !== null && accuracy > 0) parts.push(`точность ±${Math.round(accuracy)} м`);
  const live = finite(raw.live_period);
  if (live !== null && live > 0) {
    parts.push(live >= LIVE_PERIOD_UNTIL_STOPPED ? "трансляция без срока" : `трансляция на ${Math.ceil(live / SECONDS_PER_MINUTE)} мин`);
  }
  return parts.join(", ");
}

function contact(raw: Raw): string {
  const name = [text(raw.first_name), text(raw.last_name)].filter(Boolean).join(" ");
  return `👤 Контакт: ${[name || null, text(raw.phone_number)].filter(Boolean).join(", ") || "без данных"}`;
}

function poll(raw: Raw): string {
  const votes = (finite(raw.total_voter_count) ?? 0) > 0;
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((option) => {
      const item = record(option);
      const label = text(item?.text);
      if (label === null) return null;
      const count = finite(item?.voter_count);
      return votes && count !== null ? `${label} — ${count}` : label;
    })
    .filter((option): option is string => option !== null);
  const flags = [
    raw.is_anonymous === false ? "открытый" : "анонимный",
    raw.allows_multiple_answers === true ? "можно несколько" : null,
    raw.type === "quiz" ? "викторина" : null,
    raw.is_closed === true ? "закрыт" : null,
  ].filter(Boolean).join(", ");
  return `📊 Опрос ${quoted(text(raw.question)) ?? "без вопроса"}: ${options.join(" / ") || "без вариантов"} (${flags})`;
}

function dice(raw: Raw): string {
  const emoji = text(raw.emoji) ?? "🎲";
  const value = finite(raw.value);
  return emoji === "🎲" ? `🎲 Кубик: выпало ${value ?? "?"}` : `${emoji} Бросок: ${value ?? "?"}`;
}

function checklist(raw: Raw): string {
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map((task) => {
      const item = record(task);
      const label = text(item?.text);
      if (label === null) return null;
      const done = item?.completion_date !== undefined || item?.completed_by_user !== undefined;
      return done ? `✓ ${label}` : label;
    })
    .filter((task): task is string => task !== null);
  return `☑️ Список ${quoted(text(raw.title)) ?? "без названия"}: ${tasks.join(" / ") || "пуст"}`;
}

function bracketed(label: string, details: readonly (string | null)[]): string {
  const filled = details.filter(Boolean).join(" ");
  return `[${filled ? `${label} ${filled}` : label}]`;
}

function audio(raw: Raw): string {
  const performer = text(raw.performer);
  const title = text(raw.title);
  const length = duration(raw.duration);
  if (performer || title) return `[аудио: ${[performer, title].filter(Boolean).join(" — ")}${length ? `, ${length}` : ""}]`;
  const file = quoted(text(raw.file_name));
  if (file) return `[аудио ${file}${length ? `, ${length}` : ""}]`;
  return bracketed("аудио", [length]);
}

function story(raw: Raw): string {
  const chat = record(raw.chat);
  const owner = quoted(text(chat?.title)) ?? (text(chat?.username) ? `@${text(chat?.username)}` : null);
  return bracketed("история", [owner ? `от ${owner}` : null]);
}

// The first matching field names the content; Telegram sends one kind per message.
const DESCRIBERS: readonly (readonly [string, (raw: Raw) => string])[] = [
  ["venue", venue],
  ["location", location],
  ["contact", contact],
  ["poll", poll],
  ["dice", dice],
  ["checklist", checklist],
  ["sticker", (raw) => bracketed("стикер", [text(raw.emoji), text(raw.set_name) ? `из набора «${text(raw.set_name)}»` : null])],
  ["animation", (raw) => bracketed("GIF", [duration(raw.duration)])],
  ["video_note", (raw) => bracketed("видеосообщение", [duration(raw.duration)])],
  ["video", (raw) => bracketed("видео", [duration(raw.duration)])],
  ["voice", (raw) => bracketed("голосовое", [duration(raw.duration)])],
  ["audio", audio],
  ["story", story],
  ["paid_media", () => "[платное медиа]"],
  ["game", (raw) => bracketed("игра", [quoted(text(raw.title))])],
  ["gift", () => "[подарок]"],
  ["unique_gift", () => "[подарок]"],
  ["giveaway", () => "[розыгрыш]"],
  ["invoice", (raw) => bracketed("счёт", [quoted(text(raw.title))])],
  ["live_photo", () => "[живое фото]"],
];

export function telegramContentDescription(raw: Raw): string | null {
  for (const [field, describe] of DESCRIBERS) {
    const value = record(raw[field]);
    if (value !== null) return describe(value);
  }
  return null;
}

/** The UTC calendar day, as the timeline's day separators name it. */
function day(value: unknown): string | null {
  const seconds = finite(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString().slice(0, 10);
}

function personName(user: Raw | null): string | null {
  const name = [text(user?.first_name), text(user?.last_name)].filter(Boolean).join(" ");
  const username = text(user?.username);
  if (!name) return username ? `@${username}` : null;
  return username ? `${name} (@${username})` : name;
}

function forwardNote(origin: Raw): string {
  const signature = text(origin.author_signature);
  const source = origin.type === "user"
    ? `от ${personName(record(origin.sender_user)) ?? "пользователя"}`
    : origin.type === "hidden_user"
      ? `от ${text(origin.sender_user_name) ?? "пользователя"}`
      : origin.type === "channel"
        ? `из канала ${quoted(text(record(origin.chat)?.title)) ?? "без названия"}`
        : `из ${quoted(text(record(origin.sender_chat)?.title)) ?? "чата"}`;
  return ["↪ Переслано " + source, signature ? `автор ${signature}` : null, day(origin.date)].filter(Boolean).join(", ");
}

export function telegramMessageContextNote(raw: Raw): string | null {
  const origin = record(raw.forward_origin);
  if (origin !== null) return forwardNote(origin);
  const external = record(raw.external_reply);
  if (external !== null) {
    const chat = quoted(text(record(external.chat)?.title));
    return `↩ Ответ на сообщение из ${chat ?? "другого чата"}`;
  }
  if (record(raw.reply_to_story) !== null) return "↩ Ответ на историю";
  return null;
}

export function isTelegramMediaPlaceholderOnly(value: string): boolean {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => MEDIA_PLACEHOLDER_LINE.test(line));
}
