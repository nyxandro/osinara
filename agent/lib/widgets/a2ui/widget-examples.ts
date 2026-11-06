/**
 * Reference A2UI widgets of the catalog: what the skill shows the model and what the tests build.
 *
 * Exports:
 * - `WidgetExample`: a request a person might make and the A2UI message that answers it.
 * - `WIDGET_EXAMPLES`: six widgets covering every component of the catalog.
 *
 * Key constructs:
 * - One source for the skill's examples, the renderer tests and the official-check script, so an
 *   example the model copies is always one that validates, fits Telegram's size and passes the check.
 * - Names and data are made up; the repository is public.
 */
import { WIDGET_CATALOG_ID } from "./catalog.js";

export interface WidgetExample {
  readonly caption: string;
  readonly message: { readonly version: "1.0"; readonly createSurface: Record<string, unknown> };
  readonly name: string;
  readonly request: string;
}

function surface(surfaceId: string, components: unknown[], dataModel: Record<string, unknown> = {}) {
  return { createSurface: { catalogId: WIDGET_CATALOG_ID, components, dataModel, surfaceId }, version: "1.0" as const };
}

export const WIDGET_EXAMPLES: readonly WidgetExample[] = [
  {
    caption: "Меню на неделю: отметьте блюда и нажмите «Готово»",
    message: surface("menu_2026_11_09", [
      { children: ["title", "dishes", "done"], component: "Column", id: "root" },
      { component: "Text", id: "title", text: "Меню на неделю", variant: "title" },
      {
        component: "ChoicePicker", id: "dishes", label: "Что готовим?", value: { "@path": "/picked" }, variant: "multipleSelection",
        options: [
          { label: "Борщ", value: "borsch" }, { label: "Плов", value: "plov" }, { label: "Сырники", value: "syrniki" },
          { label: "Паста", value: "pasta" }, { label: "Котлеты", value: "cutlets" }, { label: "Рыба", value: "fish" },
        ],
      },
      { action: { event: { context: { dishes: { "@path": "/picked" } }, name: "menu_done", userMessage: "Выбрала блюда на неделю" } }, child: "done_text", component: "Button", id: "done", variant: "primary" },
      { component: "Text", id: "done_text", text: "Готово" },
    ], { picked: [] }),
    name: "menu",
    request: "составь меню на неделю, я выберу",
  },
  {
    caption: "Кружки на неделю. Ближайшее — плавание у Пети, вт 17:30",
    message: surface("clubs_week_46", [
      { component: "Tabs", id: "root", tabs: [{ child: "mon", title: "Пн" }, { child: "tue", title: "Вт" }, { child: "thu", title: "Чт" }] },
      { children: { componentId: "slot", path: "/mon" }, component: "List", id: "mon" },
      { children: { componentId: "slot", path: "/tue" }, component: "List", id: "tue" },
      { children: { componentId: "slot", path: "/thu" }, component: "List", id: "thu" },
      { children: ["slot_time", "slot_name", "slot_kid"], component: "Row", id: "slot" },
      { component: "Text", id: "slot_time", text: { "@path": "time" }, variant: "subtitle" },
      { component: "Text", id: "slot_name", text: { "@path": "name" }, weight: 1 },
      { component: "Badge", id: "slot_kid", text: { "@path": "kid" }, tone: "accent" },
    ], {
      mon: [{ kid: "Аня", name: "Английский", time: "16:00" }],
      thu: [{ kid: "Аня", name: "Рисование", time: "18:00" }, { kid: "Петя", name: "Шахматы", time: "19:00" }],
      tue: [{ kid: "Петя", name: "Плавание", time: "17:30" }],
    }),
    name: "schedule",
    request: "покажи расписание кружков на неделю",
  },
  {
    caption: "Расходы за октябрь: 48 300 ₽, больше всего — продукты",
    message: surface("spend_2026_10", [
      { children: ["total", "budget", "chart", "table"], component: "Column", id: "root" },
      { component: "Text", id: "total", text: { "@call": "formatCurrency", args: { currency: "RUB", value: { "@path": "/total" } } }, variant: "title" },
      { component: "Progress", id: "budget", label: { "@call": "formatString", args: { value: "Бюджет: ${/total} из ${/budget} ₽" } }, max: { "@path": "/budget" }, value: { "@path": "/total" } },
      { component: "Chart", id: "chart", kind: "pie", labels: { "@path": "/labels" }, series: [{ name: "Октябрь", values: { "@path": "/values" } }] },
      { columns: ["Категория", "₽"], component: "Table", id: "table", rows: [["Продукты", 21400], ["Дом", 12800], ["Дети", 9100], ["Транспорт", 5000]] },
    ], { budget: 60000, labels: ["Продукты", "Дом", "Дети", "Транспорт"], total: 48300, values: [21400, 12800, 9100, 5000] }),
    name: "spending",
    request: "сколько мы потратили в октябре и на что",
  },
  {
    caption: "Сырники: 4 шага, 25 минут",
    message: surface("syrniki_steps", [
      { children: ["head", "steps", "copy"], component: "Column", id: "root" },
      { component: "Text", id: "head", text: "Сырники на 4 порции", variant: "title" },
      { children: ["s1", "s2", "s3", "s4"], component: "List", id: "steps" },
      { component: "CheckBox", id: "s1", label: "Смешать творог, яйцо и сахар", value: { "@path": "/s1" } },
      { component: "CheckBox", id: "s2", label: "Добавить муку, слепить 8 штук", value: { "@path": "/s2" } },
      { component: "CheckBox", id: "s3", label: "Жарить по 3 минуты с каждой стороны", value: { "@path": "/s3" } },
      { component: "CheckBox", id: "s4", label: "Подать со сметаной", value: { "@path": "/s4" } },
      { action: { functionCall: { "@call": "copyText", args: { text: "творог 500 г, яйцо 1, сахар 2 ст. л., мука 4 ст. л." } } }, child: "copy_text", component: "Button", id: "copy", variant: "borderless" },
      { component: "Text", id: "copy_text", text: "Скопировать список продуктов" },
    ], { s1: false, s2: false, s3: false, s4: false }),
    name: "recipe",
    request: "рецепт сырников по шагам",
  },
  {
    caption: "Викторина: таблица умножения на 7",
    message: surface("quiz_times_7", [
      { children: ["title", "quiz"], component: "Column", id: "root" },
      { component: "Text", id: "title", text: "Умножение на 7", variant: "title" },
      {
        component: "Quiz", finish: { event: { name: "quiz_done", userMessage: "Прошла викторину" } }, id: "quiz",
        questions: [
          { answer: 1, options: ["42", "49", "56"], question: "7 × 7" },
          { answer: 0, options: ["56", "54", "63"], question: "7 × 8" },
          { answer: 2, options: ["27", "35", "21"], question: "7 × 3" },
        ],
      },
    ]),
    name: "quiz",
    request: "проверь меня по умножению на 7",
  },
  {
    caption: "До отпуска — 2026-12-27, вылет в 08:40",
    message: surface("vacation_countdown", [
      { child: "inner", component: "Card", id: "root" },
      { children: ["icon_row", "timer", "open"], component: "Column", id: "inner", align: "center" },
      { children: ["icon", "where"], component: "Row", id: "icon_row" },
      { component: "Icon", id: "icon", name: "plane" },
      { component: "Text", id: "where", text: "Сочи, рейс в 08:40", variant: "subtitle" },
      { component: "Countdown", done: "Пора в аэропорт!", id: "timer", label: "До вылета", target: "2026-12-27T08:40:00+03:00" },
      { action: { functionCall: { "@call": "openUrl", args: { url: "https://example.com/booking" } } }, child: "open_text", component: "Button", id: "open", variant: "borderless" },
      { component: "Text", id: "open_text", text: "Бронь" },
    ]),
    name: "countdown",
    request: "сколько осталось до отпуска",
  },
];
