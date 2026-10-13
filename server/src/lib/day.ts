// Day math (B4). Pure: every function takes the instant it reasons about explicitly.
// All time zone math goes through Temporal; DST gaps/overlaps use 'compatible'
// disambiguation (a missing 02:xx resolves forward, a repeated hour resolves to the first).
import { Temporal } from "temporal-polyfill";
import type { ScoringConfig } from "./config";

export type DayKey = string; // YYYY-MM-DD

const HOUR_MS = 3_600_000;

export function toInstant(d: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(d.getTime());
}

export function fromInstant(i: Temporal.Instant): Date {
  return new Date(i.epochMilliseconds);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    Temporal.Now.instant().toZonedDateTimeISO(tz);
    return true;
  } catch {
    return false;
  }
}

/** Calendar date of an instant in a zone (no rollover adjustment). */
export function localDate(tz: string, instant: Date): Temporal.PlainDate {
  return toInstant(instant).toZonedDateTimeISO(tz).toPlainDate();
}

/** The instant of `hour:minute` local time on a given local date. */
export function localInstant(
  tz: string,
  date: Temporal.PlainDate,
  hour: number,
  minute = 0,
): Date {
  const zdt = Temporal.ZonedDateTime.from(
    { timeZone: tz, year: date.year, month: date.month, day: date.day, hour, minute },
    { disambiguation: "compatible" },
  );
  return new Date(zdt.epochMilliseconds);
}

/** First rollover instant strictly after `after`. */
export function nextRollover(tz: string, hour: number, after: Date): Date {
  const d0 = localDate(tz, after);
  for (let k = 0; k <= 2; k++) {
    const candidate = localInstant(tz, d0.add({ days: k }), hour);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("nextRollover: no rollover within 2 days (impossible)");
}

/** First rollover instant at or after `t`. */
export function firstRolloverAtOrAfter(tz: string, hour: number, t: Date): Date {
  const d0 = localDate(tz, t);
  for (let k = 0; k <= 2; k++) {
    const candidate = localInstant(tz, d0.add({ days: k }), hour);
    if (candidate.getTime() >= t.getTime()) return candidate;
  }
  throw new Error("firstRolloverAtOrAfter: no rollover within 2 days (impossible)");
}

/** Day key of an instant: the local date, minus one day before the rollover hour. */
export function dayKey(tz: string, rolloverHour: number, instant: Date): DayKey {
  const zdt = toInstant(instant).toZonedDateTimeISO(tz);
  const date = zdt.hour < rolloverHour ? zdt.toPlainDate().subtract({ days: 1 }) : zdt.toPlainDate();
  return date.toString();
}

export function addDays(key: DayKey, days: number): DayKey {
  return Temporal.PlainDate.from(key).add({ days }).toString();
}

export function compareDayKeys(a: DayKey, b: DayKey): number {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}

export function daysBetween(from: DayKey, to: DayKey): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: "days" }).days;
}

export interface DayWindow {
  window_start: Date;
  window_end: Date;
  day_key: DayKey;
}

export interface PlanDayInput {
  tz: string;
  rolloverHour: number;
  start: Date;
  prevDayKey: DayKey | null;
  cfg: Pick<ScoringConfig, "min_day_hours" | "max_day_hours">;
}

/**
 * Window for a day opened at `start` (openDay): it ends at the first local rollover at or
 * after start + min_day_hours, capped at start + max_day_hours. Its key is the local date of
 * the last second of the window, but never <= the previous key, so keys are real local dates
 * and can be skipped after travel but never drift ahead of the calendar.
 */
export function planDay({ tz, rolloverHour, start, prevDayKey, cfg }: PlanDayInput): DayWindow {
  const minEnd = new Date(start.getTime() + cfg.min_day_hours * HOUR_MS);
  const cap = new Date(start.getTime() + cfg.max_day_hours * HOUR_MS);
  let end = firstRolloverAtOrAfter(tz, rolloverHour, minEnd);
  if (end.getTime() > cap.getTime()) end = cap;
  let key = dayKey(tz, rolloverHour, new Date(end.getTime() - 1000));
  if (prevDayKey && compareDayKeys(key, prevDayKey) <= 0) key = addDays(prevDayKey, 1);
  return { window_start: start, window_end: end, day_key: key };
}

export interface RescheduleInput {
  tz: string;
  rolloverHour: number;
  start: Date;
  now: Date;
  alarmAt: Date | null;
  cfg: Pick<ScoringConfig, "min_day_hours" | "max_day_hours">;
}

/**
 * New window_end for the open day after a tz or rollover-hour change: the first rollover in
 * the new settings at or after max(start + min_day_hours, now, alarm_at), capped at
 * max(now, start + max_day_hours). Never below `now` or a stamped `alarm_at`.
 */
export function rescheduleWindowEnd({ tz, rolloverHour, start, now, alarmAt, cfg }: RescheduleInput): Date {
  const floorMs = Math.max(
    start.getTime() + cfg.min_day_hours * HOUR_MS,
    now.getTime(),
    alarmAt ? alarmAt.getTime() : -Infinity,
  );
  const capMs = Math.max(now.getTime(), start.getTime() + cfg.max_day_hours * HOUR_MS);
  const end = firstRolloverAtOrAfter(tz, rolloverHour, new Date(floorMs));
  return new Date(Math.min(end.getTime(), capMs));
}

export type CatchUpPlan =
  | { mode: "none" }
  /** Close the pending row, then open each window in order; all but the last get closed too. */
  | { mode: "catchup"; windows: DayWindow[] }
  /** Returning after a long absence: close the pending row, skip the gap, open one day at the next rollover. */
  | { mode: "dormant"; windows: [DayWindow] };

export const MAX_CATCHUP_DAYS = 60;

/**
 * Pure part of ensureDay (B6): which windows to open (each one after closing its predecessor)
 * so that the pending day contains `now`.
 */
export function planCatchUp(input: {
  pending: { window_end: Date; day_key: DayKey };
  now: Date;
  tz: string;
  rolloverHour: number;
  dormantSince: Date | null;
  cfg: Pick<ScoringConfig, "min_day_hours" | "max_day_hours" | "dormant_after_days">;
}): CatchUpPlan {
  const { pending, now, tz, rolloverHour, cfg } = input;
  if (pending.window_end.getTime() > now.getTime()) return { mode: "none" };
  const gapMs = now.getTime() - pending.window_end.getTime();
  if (input.dormantSince || gapMs > cfg.dormant_after_days * 24 * HOUR_MS) {
    const start = nextRollover(tz, rolloverHour, now);
    return {
      mode: "dormant",
      windows: [planDay({ tz, rolloverHour, start, prevDayKey: pending.day_key, cfg })],
    };
  }
  const windows: DayWindow[] = [];
  let prev = { window_end: pending.window_end, day_key: pending.day_key };
  for (let i = 0; i < MAX_CATCHUP_DAYS; i++) {
    const w = planDay({ tz, rolloverHour, start: prev.window_end, prevDayKey: prev.day_key, cfg });
    windows.push(w);
    if (w.window_end.getTime() > now.getTime()) break;
    prev = w;
  }
  return { mode: "catchup", windows };
}
