/**
 * The A2UI catalog of Telegram widgets: the components and functions a model may describe a widget with.
 *
 * Exports:
 * - `WIDGET_CATALOG_ID`: the catalog's A2UI `catalogId`.
 * - `PropSpec`, `ComponentSpec`, `FunctionSpec`: the declarative shape the validator, the renderer and
 *   the skill reference all read, so the three never drift apart.
 * - `WIDGET_COMPONENTS`, `WIDGET_FUNCTIONS`, `WIDGET_ICONS`: the catalog itself.
 * - `CONTAINER_COMPONENTS`, `ACTION_FUNCTIONS`: which components hold others and which functions run on a tap.
 *
 * Key constructs:
 * - A2UI 1.0 lets an application define its own catalog; this one keeps the basic catalog's names and
 *   properties where Telegram can draw them and drops what a widget cannot have: no keyboard (TextField,
 *   DateTimeInput), no dialogs (Modal), no media or remote images (Video, AudioPlayer, Image), no
 *   scrolling. It adds what a family chat needs and a widget can draw: Table, Chart, Progress, Badge,
 *   Countdown and Quiz.
 * - Icons are emoji: a widget loads no fonts or remote images, and emoji cost a few bytes.
 * - `openUrl` takes only https pages outside Telegram: Telegram links open without a confirmation, so a
 *   page that talked the model into one could start a bot or join a chat behind a harmless label.
 */

export const WIDGET_CATALOG_ID = "urn:osinara:a2ui:telegram-widget:1";

export type PropSpec =
  | { readonly kind: "string"; readonly max: number }
  | { readonly kind: "number"; readonly min: number; readonly max: number; readonly integer?: true }
  | { readonly kind: "dynamicString" }
  | { readonly kind: "dynamicNumber" }
  | { readonly kind: "dynamicBoolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "child" }
  | { readonly kind: "children" }
  | { readonly kind: "inputPath"; readonly valueType: "boolean" | "stringList" }
  | { readonly kind: "options"; readonly min: number; readonly max: number }
  | { readonly kind: "tabs"; readonly min: number; readonly max: number }
  | { readonly kind: "action" }
  | { readonly kind: "stringList"; readonly max: number }
  | { readonly kind: "series"; readonly max: number }
  | { readonly kind: "rows"; readonly maxRows: number; readonly maxColumns: number }
  | { readonly kind: "questions"; readonly max: number };

export interface PropDefinition {
  readonly description: string;
  readonly required?: true;
  readonly spec: PropSpec;
}

export interface ComponentSpec {
  readonly description: string;
  readonly props: Readonly<Record<string, PropDefinition>>;
}

export interface FunctionSpec {
  readonly args: Readonly<Record<string, { readonly description: string; readonly required?: true; readonly type: "string" | "number" | "boolean" | "value" | "booleanList" }>>;
  readonly description: string;
  /** Functions run on a tap only, as a button's action; never inside a value. */
  readonly onTapOnly?: true;
  readonly returns: "string" | "boolean" | "void";
}

export const WIDGET_ICONS: Readonly<Record<string, string>> = {
  baby: "👶", bell: "🔔", book: "📚", calendar: "📅", car: "🚗", cart: "🛒", check: "✅", clock: "🕒", close: "❌",
  cloud: "☁️", food: "🍽️", fire: "🔥", gift: "🎁", heart: "❤️", home: "🏠", info: "ℹ️", location: "📍", mail: "✉️",
  medicine: "💊", money: "💰", music: "🎵", pet: "🐾", phone: "📞", plane: "✈️", rain: "🌧️", school: "🏫", snow: "❄️",
  sport: "⚽", star: "⭐", sun: "☀️", task: "📝", trophy: "🏆", user: "👤", users: "👥", warning: "⚠️",
};

const ALIGN = ["start", "center", "end", "stretch"] as const;
const JUSTIFY = ["start", "center", "end", "spaceBetween", "spaceAround"] as const;

const weight: PropDefinition = {
  description: "Share of the free space this component takes inside a Row or Column (flex-grow), 1-10.",
  spec: { kind: "number", max: 10, min: 1, integer: true },
};

export const WIDGET_COMPONENTS: Readonly<Record<string, ComponentSpec>> = {
  Text: {
    description: "Text. Supports **bold**, *italic* and line breaks; no links or HTML.",
    props: {
      text: { description: "The text.", required: true, spec: { kind: "dynamicString" } },
      variant: { description: "title, subtitle, body (default) or caption (small, muted).", spec: { kind: "enum", values: ["title", "subtitle", "body", "caption"] } },
      weight,
    },
  },
  Icon: {
    description: "A small icon from the list of icon names.",
    props: { name: { description: "Icon name from the icon list.", required: true, spec: { kind: "enum", values: Object.keys(WIDGET_ICONS) } }, weight },
  },
  Row: {
    description: "Children side by side; wraps to the next line when the bubble is narrow.",
    props: {
      align: { description: "Cross-axis alignment.", spec: { kind: "enum", values: ALIGN } },
      children: { description: "Child ids, or a template over a data list.", required: true, spec: { kind: "children" } },
      justify: { description: "Main-axis distribution.", spec: { kind: "enum", values: JUSTIFY } },
      weight,
    },
  },
  Column: {
    description: "Children stacked top to bottom.",
    props: {
      align: { description: "Cross-axis alignment.", spec: { kind: "enum", values: ALIGN } },
      children: { description: "Child ids, or a template over a data list.", required: true, spec: { kind: "children" } },
      justify: { description: "Main-axis distribution.", spec: { kind: "enum", values: JUSTIFY } },
      weight,
    },
  },
  List: {
    description: "A list of items with separators; never scrolls, so keep it short (the widget is at most 600 px tall).",
    props: {
      align: { description: "Cross-axis alignment.", spec: { kind: "enum", values: ALIGN } },
      children: { description: "Child ids, or a template over a data list.", required: true, spec: { kind: "children" } },
      direction: { description: "vertical (default) or horizontal (wraps).", spec: { kind: "enum", values: ["vertical", "horizontal"] } },
      weight,
    },
  },
  Card: {
    description: "A rounded panel around one child.",
    props: { child: { description: "The child id.", required: true, spec: { kind: "child" } }, weight },
  },
  Tabs: {
    description: "Tabs switched on the device; only the open tab is shown. Up to 6 tabs.",
    props: { tabs: { description: "Tabs: [{ title, child }].", required: true, spec: { kind: "tabs", max: 6, min: 1 } }, weight },
  },
  Divider: {
    description: "A thin separating line.",
    props: { axis: { description: "horizontal (default) or vertical.", spec: { kind: "enum", values: ["horizontal", "vertical"] } } },
  },
  Button: {
    description: "A button. Its action either reaches the agent (event) or runs on the device (openUrl, copyText).",
    props: {
      action: { description: "{ event: { name, context?, userMessage? } } or { functionCall: { @call: openUrl|copyText, args } }.", required: true, spec: { kind: "action" } },
      child: { description: "Id of a Text (or Icon) shown on the button.", required: true, spec: { kind: "child" } },
      variant: { description: "default, primary (main action) or borderless (looks like a link).", spec: { kind: "enum", values: ["default", "primary", "borderless"] } },
      weight,
    },
  },
  CheckBox: {
    description: "A check mark the person toggles on the device; its value goes to the agent with an event in the same widget.",
    props: {
      label: { description: "The label.", required: true, spec: { kind: "dynamicString" } },
      value: { description: "{ @path } to a boolean in the data model.", required: true, spec: { kind: "inputPath", valueType: "boolean" } },
      weight,
    },
  },
  ChoicePicker: {
    description: "Options to pick on the device; the picked values go to the agent with an event in the same widget.",
    props: {
      label: { description: "The label above the options.", spec: { kind: "dynamicString" } },
      options: { description: "[{ label, value }], 2-30 options; value is a short id.", required: true, spec: { kind: "options", max: 30, min: 2 } },
      value: { description: "{ @path } to a list of the picked option values in the data model.", required: true, spec: { kind: "inputPath", valueType: "stringList" } },
      variant: { description: "mutuallyExclusive (one, default) or multipleSelection.", spec: { kind: "enum", values: ["mutuallyExclusive", "multipleSelection"] } },
      weight,
    },
  },
  Table: {
    description: "A table: header row and up to 20 rows of short cells.",
    props: {
      columns: { description: "Header labels, up to 6.", required: true, spec: { kind: "stringList", max: 6 } },
      rows: { description: "Rows of cells (strings or numbers), or { @path } to them.", required: true, spec: { kind: "rows", maxColumns: 6, maxRows: 20 } },
      weight,
    },
  },
  Chart: {
    description: "A chart drawn when the widget is built: bar, line or pie.",
    props: {
      kind: { description: "bar, line or pie.", required: true, spec: { kind: "enum", values: ["bar", "line", "pie"] } },
      labels: { description: "Category labels, up to 24, or { @path }.", required: true, spec: { kind: "stringList", max: 24 } },
      series: { description: "[{ name, values }] with one number per label; pie takes one series. Up to 4.", required: true, spec: { kind: "series", max: 4 } },
      title: { description: "Chart title.", spec: { kind: "dynamicString" } },
      unit: { description: "Unit after values, such as ₽ or km.", spec: { kind: "string", max: 12 } },
      weight,
    },
  },
  Progress: {
    description: "A progress bar.",
    props: {
      label: { description: "Text above the bar.", spec: { kind: "dynamicString" } },
      max: { description: "The full value (default 100).", spec: { kind: "dynamicNumber" } },
      value: { description: "The current value.", required: true, spec: { kind: "dynamicNumber" } },
      weight,
    },
  },
  Badge: {
    description: "A short label in a colored pill.",
    props: {
      text: { description: "The label.", required: true, spec: { kind: "dynamicString" } },
      tone: { description: "neutral (default), accent, success, warning or danger.", spec: { kind: "enum", values: ["neutral", "accent", "success", "warning", "danger"] } },
      weight,
    },
  },
  Countdown: {
    description: "Time left until a moment, ticking on the device. It shows time only and never notifies: use a reminder for that.",
    props: {
      done: { description: "Text shown once the moment has passed.", required: true, spec: { kind: "dynamicString" } },
      label: { description: "Text above the timer.", spec: { kind: "dynamicString" } },
      target: { description: "ISO 8601 moment with a UTC offset, such as 2026-12-31T23:59:00+03:00.", required: true, spec: { kind: "dynamicString" } },
      weight,
    },
  },
  Quiz: {
    description: "Questions with options, checked on the device. With finish, the score reaches the agent when the last answer is given.",
    props: {
      finish: { description: "Optional { event: { name, userMessage? } }: the agent gets { score, total }.", spec: { kind: "action" } },
      questions: { description: "[{ question, options: [2-4 strings], answer: index of the right option }], up to 10.", required: true, spec: { kind: "questions", max: 10 } },
      weight,
    },
  },
};


export const CONTAINER_COMPONENTS: ReadonlySet<string> = new Set(["Row", "Column", "List", "Card", "Tabs", "Button"]);

export const WIDGET_FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  formatString: {
    args: { value: { description: "Text with ${/absolute/path} or ${relative/path} placeholders; \\${ is a literal ${.", required: true, type: "string" } },
    description: "Text with data model values put in.",
    returns: "string",
  },
  formatNumber: {
    args: {
      decimals: { description: "Digits after the point (default 0).", type: "number" },
      grouping: { description: "Group thousands (default true).", type: "boolean" },
      value: { description: "The number.", required: true, type: "number" },
    },
    description: "A number in Russian notation: 12 345,5.",
    returns: "string",
  },
  formatCurrency: {
    args: {
      currency: { description: "ISO 4217 code: RUB, USD, EUR.", required: true, type: "string" },
      decimals: { description: "Digits after the point (default 0).", type: "number" },
      value: { description: "The amount.", required: true, type: "number" },
    },
    description: "An amount with its currency: 1 500 ₽.",
    returns: "string",
  },
  formatDate: {
    args: {
      format: { description: "TR35 pattern: yyyy yy MMMM MMM MM M dd d EEEE E HH H mm ss, such as 'd MMMM, HH:mm'.", required: true, type: "string" },
      value: { description: "ISO 8601: a date (2026-11-07) or a moment with its offset (2026-11-07T17:30:00+03:00).", required: true, type: "string" },
    },
    description: "A date or a moment in Russian, in the offset it was given with; time zones are never guessed.",
    returns: "string",
  },
  pluralize: {
    args: {
      few: { description: "Form for 2-4: «занятия».", type: "string" },
      many: { description: "Form for 5-20: «занятий».", type: "string" },
      one: { description: "Form for 1, 21: «занятие».", type: "string" },
      other: { description: "Fallback form, required.", required: true, type: "string" },
      value: { description: "The count.", required: true, type: "number" },
    },
    description: "The Russian word form for a count.",
    returns: "string",
  },
  and: { args: { values: { description: "Booleans.", required: true, type: "booleanList" } }, description: "True when all are true.", returns: "boolean" },
  or: { args: { values: { description: "Booleans.", required: true, type: "booleanList" } }, description: "True when any is true.", returns: "boolean" },
  not: { args: { value: { description: "A boolean.", required: true, type: "boolean" } }, description: "The opposite.", returns: "boolean" },
  openUrl: {
    args: { url: { description: "An https web page outside Telegram, up to 256 characters.", required: true, type: "string" } },
    description: "Opens a web page after the person confirms its address.",
    onTapOnly: true,
    returns: "void",
  },
  copyText: {
    args: { text: { description: "1-256 characters to copy.", required: true, type: "string" } },
    description: "Copies text; Telegram shows what was copied.",
    onTapOnly: true,
    returns: "void",
  },
};

export const ACTION_FUNCTIONS: ReadonlySet<string> = new Set(
  Object.entries(WIDGET_FUNCTIONS).filter(([, spec]) => spec.onTapOnly === true).map(([name]) => name),
);
