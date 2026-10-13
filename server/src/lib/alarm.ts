// The shared daily alarm. This file, src/workflows/alarm*.ts, the dev-reveal route and the
// admin alarm helpers are the only places allowed to read daily_alarms.fire_at
// (scripts/check-fire-at.sh enforces it). Everything else uses publicAlarmColumns, and only
// fired alarms (fired_at set) ever leave this module.
import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";
import type { Executor } from "@/db/client";
import { dailyAlarms } from "@/db/schema";
import type { ScoringConfig } from "./config";
import { localDate, localInstant } from "./day";

type AlarmCfg = Pick<ScoringConfig, "alarm_tz" | "alarm_window_start" | "alarm_window_end">;

/** Every column except fire_at. Client-facing code selects only these. */
export const publicAlarmColumns = {
  alarmDate: dailyAlarms.alarmDate,
  windowStart: dailyAlarms.windowStart,
  windowEnd: dailyAlarms.windowEnd,
  firedAt: dailyAlarms.firedAt,
  readerCount: dailyAlarms.readerCount,
  beatCount: dailyAlarms.beatCount,
  pushSent: dailyAlarms.pushSent,
  pushFailed: dailyAlarms.pushFailed,
  pushDryRun: dailyAlarms.pushDryRun,
  workflowRunId: dailyAlarms.workflowRunId,
} as const;

function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad HH:MM value: ${s}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** The alarm date (calendar date in the alarm zone, America/Denver) containing `now`. */
export function alarmDateFor(now: Date, cfg: AlarmCfg): string {
  return localDate(cfg.alarm_tz, now).toString();
}

/** 10:00 and 20:30 local (alarm zone) on the alarm date, DST-aware. */
export function alarmWindowFor(alarmDate: string, cfg: AlarmCfg): { start: Date; end: Date } {
  const date = Temporal.PlainDate.from(alarmDate);
  const s = parseHHMM(cfg.alarm_window_start);
  const e = parseHHMM(cfg.alarm_window_end);
  return {
    start: localInstant(cfg.alarm_tz, date, s.hour, s.minute),
    end: localInstant(cfg.alarm_tz, date, e.hour, e.minute),
  };
}

/** Uniform random integer in [0, n) from crypto.getRandomValues (rejection sampling). */
export function secureRandomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error(`bad range ${n}`);
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * Picks the secret fire instant: uniform over [10:00:00, 20:30:00) local on the alarm date.
 * A late (catch-up) caller shrinks the window to [max(now, 10:00), 20:30). Returns null when
 * the window has already closed.
 */
export function pickFireAt(
  alarmDate: string,
  now: Date,
  cfg: AlarmCfg,
  randomInt: (n: number) => number = secureRandomInt,
): Date | null {
  const { start, end } = alarmWindowFor(alarmDate, cfg);
  const lo = Math.max(start.getTime(), now.getTime());
  const hi = end.getTime();
  if (lo >= hi) return null;
  return new Date(lo + randomInt(hi - lo));
}

export interface FiredAlarm {
  fire_at: Date;
  fired_at: Date | null;
}

/**
 * B4 lookup: alarm instant that decides a window = min(fire_at) over fired alarms with
 * window_start <= fire_at < window_end. Null when no fired alarm lands in the window.
 */
export function applicableAlarmAt(
  window: { window_start: Date; window_end: Date },
  alarms: FiredAlarm[],
): Date | null {
  let best: number | null = null;
  for (const a of alarms) {
    if (!a.fired_at) continue;
    const t = a.fire_at.getTime();
    if (t >= window.window_start.getTime() && t < window.window_end.getTime()) {
      if (best === null || t < best) best = t;
    }
  }
  return best === null ? null : new Date(best);
}

/** DB form of applicableAlarmAt. */
export async function applicableAlarmAtDb(
  ex: Executor,
  windowStart: Date,
  windowEnd: Date,
): Promise<Date | null> {
  const rows = await ex
    .select({ t: dailyAlarms.fireAt })
    .from(dailyAlarms)
    .where(
      and(
        isNotNull(dailyAlarms.firedAt),
        gte(dailyAlarms.fireAt, windowStart),
        lt(dailyAlarms.fireAt, windowEnd),
      ),
    )
    .orderBy(asc(dailyAlarms.fireAt))
    .limit(1);
  return rows[0]?.t ?? null;
}

/** Fired alarm instants in [from, to] (session split boundaries). Unfired alarms never leak. */
export async function firedAlarmInstantsBetween(ex: Executor, from: Date, to: Date): Promise<Date[]> {
  const rows = await ex
    .select({ t: dailyAlarms.fireAt })
    .from(dailyAlarms)
    .where(
      and(isNotNull(dailyAlarms.firedAt), gte(dailyAlarms.fireAt, from), sql`${dailyAlarms.fireAt} <= ${to}`),
    )
    .orderBy(asc(dailyAlarms.fireAt));
  return rows.map((r) => r.t);
}

export interface PublicAlarm {
  alarm_date: string;
  fired: boolean;
  fired_at: string | null;
  beat_count: number | null;
  reader_count: number | null;
  beat_pct: number | null;
}

export function beatPct(beat: number | null, readers: number | null): number | null {
  if (beat === null || readers === null || readers <= 0) return null;
  return Math.round((100 * beat) / readers);
}

/** The client-facing alarm block for an alarm date. Time and counts only once fired. */
export async function publicAlarmFor(ex: Executor, alarmDate: string): Promise<PublicAlarm> {
  const rows = await ex
    .select(publicAlarmColumns)
    .from(dailyAlarms)
    .where(eq(dailyAlarms.alarmDate, alarmDate))
    .limit(1);
  const r = rows[0];
  if (!r || !r.firedAt) {
    return { alarm_date: alarmDate, fired: false, fired_at: null, beat_count: null, reader_count: null, beat_pct: null };
  }
  return {
    alarm_date: alarmDate,
    fired: true,
    fired_at: r.firedAt.toISOString(),
    beat_count: r.beatCount ?? 0,
    reader_count: r.readerCount ?? 0,
    beat_pct: beatPct(r.beatCount ?? 0, r.readerCount ?? 0),
  };
}

/**
 * Dev/admin: today's row including the secret instant. Only the dev-reveal route
 * (DEV_REVEAL_ALARM=true) and admin helpers call this.
 */
export async function revealAlarm(ex: Executor, alarmDate: string) {
  const rows = await ex.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, alarmDate)).limit(1);
  return rows[0] ?? null;
}
