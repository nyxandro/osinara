/**
 * Minute scheduler for the application's periodic work.
 *
 * Exports:
 * - `startScheduler`: at the start of every minute (process clock) runs each schedule whose cron
 *   expression matches that minute; `stop` waits a bounded time for the work schedules started.
 * - `cronMatches`: five-field cron (minute hour day-of-month month day-of-week) with `*`, `*\/n`,
 *   numbers, ranges, steps and lists; day-of-month and day-of-week match either when both are set.
 * - `RuntimeSchedule`: one schedule.
 *
 * Replaces Eve's Nitro cron tasks: the same expressions (`* * * * *`, `0 *\/6 * * *`), the same
 * clock, and a missed minute is skipped rather than caught up, as Nitro did. A schedule runs one
 * cycle at a time: while the work its last cycle started is unfinished, its minute is skipped —
 * Nitro's `runTask` returned the running task instead of starting it again, and Eve's schedule
 * task awaited all of its `waitUntil` work.
 */

export interface RuntimeSchedule {
  readonly cron: string;
  readonly name: string;
  run(context: { waitUntil(work: Promise<unknown>): void }): void;
}

const FIELDS = [
  { max: 59, min: 0, name: "minute" },
  { max: 23, min: 0, name: "hour" },
  { max: 31, min: 1, name: "day of month" },
  { max: 12, min: 1, name: "month" },
  { max: 7, min: 0, name: "day of week" },
] as const;

function invalid(expression: string, reason: string): Error {
  return new Error(`AGENT_SCHEDULE_CRON_INVALID: "${expression}": ${reason}`);
}

function parseNumber(expression: string, text: string, field: { readonly max: number; readonly min: number; readonly name: string }): number {
  if (!/^\d+$/u.test(text)) throw invalid(expression, `${field.name} "${text}" is not a number`);
  const value = Number(text);
  if (value < field.min || value > field.max) throw invalid(expression, `${field.name} ${value} is outside ${field.min}-${field.max}`);
  return value;
}

/** The values a field allows, or `null` when it allows every value (`*`). */
function parseField(expression: string, text: string, field: (typeof FIELDS)[number]): Set<number> | null {
  if (text === "*") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : parseNumber(expression, stepText, { max: field.max, min: 1, name: `${field.name} step` });
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range!.includes("-")) {
      const [start, end] = range!.split("-");
      from = parseNumber(expression, start!, field);
      to = parseNumber(expression, end!, field);
      if (from > to) throw invalid(expression, `${field.name} range ${range} runs backwards`);
    } else {
      from = parseNumber(expression, range!, field);
      to = stepText === undefined ? from : field.max;
    }
    for (let value = from; value <= to; value += step) values.add(field.name === "day of week" && value === 7 ? 0 : value);
  }
  return values;
}

function parseCron(expression: string): Array<Set<number> | null> {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== FIELDS.length) throw invalid(expression, `expected ${FIELDS.length} fields, got ${parts.length}`);
  return parts.map((part, index) => parseField(expression, part, FIELDS[index]!));
}

export function cronMatches(expression: string, date: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parseCron(expression);
  const allows = (values: Set<number> | null | undefined, value: number) => values === null || values!.has(value);
  if (!allows(minute, date.getMinutes()) || !allows(hour, date.getHours()) || !allows(month, date.getMonth() + 1)) return false;
  const dayMatches = allows(dayOfMonth, date.getDate());
  const weekdayMatches = allows(dayOfWeek, date.getDay());
  // Standard cron: with both day fields restricted, either one is enough.
  return dayOfMonth !== null && dayOfWeek !== null ? dayMatches || weekdayMatches : dayMatches && weekdayMatches;
}

export function startScheduler(input: {
  readonly now?: () => Date;
  readonly schedules: readonly RuntimeSchedule[];
}): { stop(graceMilliseconds: number): Promise<void> } {
  const now = input.now ?? (() => new Date());
  // An invalid expression stops the start, not a minute months later.
  for (const schedule of input.schedules) parseCron(schedule.cron);
  // A schedule's cycles are told apart by its name.
  const names = input.schedules.map((schedule) => schedule.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new Error(`AGENT_SCHEDULE_NAME_DUPLICATE: "${repeated}"`);
  const work = new Set<Promise<unknown>>();
  // Unfinished work of each schedule's last cycle.
  const running = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function waitUntilFor(schedule: RuntimeSchedule) {
    return (promise: Promise<unknown>) => {
      const tracked = promise.catch((error: unknown) => {
        // Each schedule logs its own cycle failure; this line marks that the cycle ended in one.
        console.error(JSON.stringify({
          code: "AGENT_SCHEDULE_WORK_FAILED", error: error instanceof Error ? error.message : String(error), schedule: schedule.name,
        }));
      });
      work.add(tracked);
      running.set(schedule.name, (running.get(schedule.name) ?? 0) + 1);
      void tracked.finally(() => {
        work.delete(tracked);
        const left = running.get(schedule.name)! - 1;
        if (left === 0) running.delete(schedule.name);
        else running.set(schedule.name, left);
      });
    };
  }

  function tick(minute: Date): void {
    for (const schedule of input.schedules) {
      if (!cronMatches(schedule.cron, minute)) continue;
      if (running.has(schedule.name)) {
        console.info(JSON.stringify({ code: "AGENT_SCHEDULE_CYCLE_SKIPPED", schedule: schedule.name }));
        continue;
      }
      try {
        schedule.run({ waitUntil: waitUntilFor(schedule) });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_SCHEDULE_RUN_FAILED", error: error instanceof Error ? error.message : String(error), schedule: schedule.name,
        }));
      }
    }
  }

  function arm(): void {
    if (stopped) return;
    const current = now();
    const next = new Date(current);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    timer = setTimeout(() => {
      tick(next);
      arm();
    }, next.getTime() - current.getTime());
  }

  arm();
  return {
    async stop(graceMilliseconds) {
      stopped = true;
      clearTimeout(timer);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMilliseconds); });
      await Promise.race([Promise.allSettled([...work]), grace]);
      clearTimeout(graceTimer);
    },
  };
}
