// DB layer for day windows and scoring (B4/B6): runs the pure rules from src/lib/{day,scoring}
// inside the caller's transaction. Lock order for every per-user mutation: the users row
// first (lockUser), then daily_results rows.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Executor, Tx } from "@/db/client";
import {
  dailyResults,
  missedMeals,
  readingSessions,
  scoringConfig,
  userSettings,
  users,
  userStats,
  type DailyResultRow,
  type UserRow,
  type UserSettingsRow,
} from "@/db/schema";
import { applicableAlarmAtDb, firedAlarmInstantsBetween } from "@/lib/alarm";
import { loadConfig, type ScoringConfig } from "@/lib/config";
import {
  dayKey,
  nextRollover,
  planCatchUp,
  planDay,
  rescheduleWindowEnd,
  type DayWindow,
} from "@/lib/day";
import { decide, fold } from "@/lib/scoring";
import { recomputeTotals, splitAtBoundaries, windowFor, type WindowRef } from "@/lib/sessions";

export async function getConfig(ex: Executor): Promise<ScoringConfig> {
  return loadConfig(() => ex.select({ key: scoringConfig.key, value: scoringConfig.value }).from(scoringConfig));
}

/** SELECT ... FOR UPDATE on the users row: the first lock of every per-user transaction. */
export async function lockUser(tx: Tx, userId: string, opts: { skipLocked?: boolean } = {}): Promise<UserRow | null> {
  const q = tx.select().from(users).where(eq(users.id, userId));
  const rows = opts.skipLocked ? await q.for("update", { skipLocked: true }) : await q.for("update");
  return rows[0] ?? null;
}

export async function getSettings(ex: Executor, userId: string): Promise<UserSettingsRow | null> {
  const rows = await ex.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getPendingDay(ex: Executor, userId: string): Promise<DailyResultRow | null> {
  const rows = await ex
    .select()
    .from(dailyResults)
    .where(and(eq(dailyResults.userId, userId), eq(dailyResults.result, "pending")))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLastDay(ex: Executor, userId: string): Promise<DailyResultRow | null> {
  const rows = await ex
    .select()
    .from(dailyResults)
    .where(eq(dailyResults.userId, userId))
    .orderBy(desc(dailyResults.dayKey))
    .limit(1);
  return rows[0] ?? null;
}

export function toWindowRef(r: DailyResultRow): WindowRef {
  return {
    id: r.id,
    window_start: r.windowStart,
    window_end: r.windowEnd,
    day_key: r.dayKey,
    alarm_at: r.alarmAt,
    result: r.result,
  };
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Recomputes a day's cached totals from reading_sessions (B5): alarm_at via the
 * applicableAlarmAt lookup (backfill), verified seconds, the part before the alarm (clipped),
 * goal_reached_at and self_reported_at. Locks the row first so it serializes with the alarm
 * fire step.
 */
export async function recomputeDay(tx: Tx, dailyResultId: string): Promise<DailyResultRow> {
  const [row] = await tx.select().from(dailyResults).where(eq(dailyResults.id, dailyResultId)).for("update");
  if (!row) throw new Error(`daily_results row ${dailyResultId} not found`);
  const lookup = await applicableAlarmAtDb(tx, row.windowStart, row.windowEnd);
  const alarmAt = minDate(row.alarmAt, lookup);
  const pieces = await tx
    .select({
      start: readingSessions.serverStartAt,
      end: readingSessions.serverEndAt,
      active: readingSessions.activeSeconds,
      source: readingSessions.source,
      scorable: readingSessions.scorable,
    })
    .from(readingSessions)
    .where(and(eq(readingSessions.dailyResultId, row.id), eq(readingSessions.verified, true)));
  const totals = recomputeTotals(
    pieces
      .filter((p) => p.start && p.end)
      .map((p) => ({ start: p.start!, end: p.end!, active: p.active, source: p.source, scorable: p.scorable })),
    row.goalSeconds,
    alarmAt,
  );
  const [updated] = await tx
    .update(dailyResults)
    .set({
      alarmAt,
      verifiedSeconds: totals.verified_seconds,
      verifiedBeforeAlarmSeconds: totals.verified_before_alarm_seconds,
      goalReachedAt: totals.goal_reached_at,
      selfReportedAt: totals.self_reported_at,
    })
    .where(eq(dailyResults.id, row.id))
    .returning();
  return updated;
}

/**
 * Attaches history-only pieces (daily_result_id null) that fall inside a newly opened window,
 * splitting any that straddle its edges or a fired alarm. This is how a session ingested
 * before its day existed (POST /sessions runs ensureDay after ingest) is scored on open.
 */
async function adoptOrphans(tx: Tx, row: DailyResultRow): Promise<void> {
  const orphans = await tx
    .select()
    .from(readingSessions)
    .where(
      and(
        eq(readingSessions.userId, row.userId),
        isNull(readingSessions.dailyResultId),
        eq(readingSessions.verified, true),
        sql`${readingSessions.serverStartAt} < ${row.windowEnd}`,
        sql`${readingSessions.serverEndAt} >= ${row.windowStart}`,
      ),
    );
  if (orphans.length === 0) return;
  const alarms = await firedAlarmInstantsBetween(tx, row.windowStart, row.windowEnd);
  const w = toWindowRef(row);
  for (const o of orphans) {
    const start = o.serverStartAt!;
    const end = o.serverEndAt!;
    if (start.getTime() === end.getTime()) {
      if (windowFor({ start, end }, [w])) {
        await tx.update(readingSessions).set({ dailyResultId: row.id, dayKey: row.dayKey }).where(eq(readingSessions.id, o.id));
      }
      continue;
    }
    const pieces = splitAtBoundaries({ start, end, active: o.activeSeconds }, [row.windowStart, row.windowEnd, ...alarms]);
    if (pieces.length === 1) {
      if (windowFor(pieces[0], [w])) {
        await tx.update(readingSessions).set({ dailyResultId: row.id, dayKey: row.dayKey }).where(eq(readingSessions.id, o.id));
      }
      continue;
    }
    const family = o.parentId ?? o.id;
    const [{ maxIdx }] = await tx
      .select({ maxIdx: sql<number>`coalesce(max(${readingSessions.pieceIndex}), 0)` })
      .from(readingSessions)
      .where(sql`${readingSessions.id} = ${family} or ${readingSessions.parentId} = ${family}`);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const inside = windowFor(p, [w]) !== null;
      const assign = inside ? { dailyResultId: row.id, dayKey: row.dayKey } : { dailyResultId: null, dayKey: o.dayKey };
      if (i === 0) {
        await tx
          .update(readingSessions)
          .set({ serverStartAt: p.start, serverEndAt: p.end, activeSeconds: p.active, ...assign })
          .where(eq(readingSessions.id, o.id));
      } else {
        await tx.insert(readingSessions).values({
          ...o,
          id: randomUUID(),
          parentId: family,
          pieceIndex: Number(maxIdx) + i,
          serverStartAt: p.start,
          serverEndAt: p.end,
          activeSeconds: p.active,
          ...assign,
        });
      }
    }
  }
}

/**
 * openDay (B4): inserts the pending row for a planned window, promoting pending_goal_seconds,
 * adopts orphan pieces, then recomputes (which backfills alarm_at from fired alarms).
 */
export async function insertDay(
  tx: Tx,
  userId: string,
  settings: UserSettingsRow,
  w: DayWindow,
): Promise<DailyResultRow> {
  if (settings.pendingGoalSeconds !== null) {
    settings.goalSeconds = settings.pendingGoalSeconds;
    settings.pendingGoalSeconds = null;
    await tx
      .update(userSettings)
      .set({ goalSeconds: settings.goalSeconds, pendingGoalSeconds: null })
      .where(eq(userSettings.userId, userId));
  }
  const [row] = await tx
    .insert(dailyResults)
    .values({
      userId,
      dayKey: w.day_key,
      windowStart: w.window_start,
      windowEnd: w.window_end,
      tzAtOpen: settings.tz,
      rolloverHourAtOpen: settings.rolloverHour,
      goalSeconds: settings.goalSeconds,
    })
    .returning();
  await adoptOrphans(tx, row);
  return recomputeDay(tx, row.id);
}

export async function openDayAt(
  tx: Tx,
  userId: string,
  settings: UserSettingsRow,
  start: Date,
  prevDayKey: string | null,
  cfg: ScoringConfig,
): Promise<DailyResultRow> {
  const w = planDay({ tz: settings.tz, rolloverHour: settings.rolloverHour, start, prevDayKey, cfg });
  return insertDay(tx, userId, settings, w);
}

/** closeDay (B6): recompute from source data, decide, and close only if still pending. */
export async function closeDay(
  tx: Tx,
  dailyResultId: string,
  now: Date,
  cfg: ScoringConfig,
  opts: { refold?: boolean } = {},
): Promise<boolean> {
  const r = await recomputeDay(tx, dailyResultId);
  if (r.result !== "pending") return false;
  const { result, deadline } = decide({
    window_end: r.windowEnd,
    goal_seconds: r.goalSeconds,
    verified_seconds: r.verifiedSeconds,
    verified_before_alarm_seconds: r.verifiedBeforeAlarmSeconds,
    self_reported_at: r.selfReportedAt,
    alarm_at: r.alarmAt,
  });
  const updated = await tx
    .update(dailyResults)
    .set({ result, deadlineAt: deadline, closedAt: now })
    .where(and(eq(dailyResults.id, r.id), eq(dailyResults.result, "pending")))
    .returning({ id: dailyResults.id });
  if (updated.length === 0) return false;
  if (opts.refold ?? true) await refold(tx, r.userId, cfg);
  return true;
}

/** rescoreDay (B6): only missed -> feast; the caller checks the 48 h window. */
export async function rescoreDay(tx: Tx, dailyResultId: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(dailyResults)
    .set({ result: "feast", rescoredAt: now })
    .where(and(eq(dailyResults.id, dailyResultId), eq(dailyResults.result, "missed")))
    .returning({ id: dailyResults.id });
  return updated.length > 0;
}

/**
 * refold (B6): pure fold over the user's whole closed day log from zero, then persist
 * user_stats and missed_meals (upsert by daily_result_id so ids stay stable; rows whose day is
 * no longer missed are deleted).
 */
export async function refold(tx: Tx, userId: string, cfg: ScoringConfig): Promise<void> {
  const days = await tx
    .select({
      id: dailyResults.id,
      day_key: dailyResults.dayKey,
      result: dailyResults.result,
      deadline_at: dailyResults.deadlineAt,
      window_end: dailyResults.windowEnd,
    })
    .from(dailyResults)
    .where(and(eq(dailyResults.userId, userId), ne(dailyResults.result, "pending")))
    .orderBy(asc(dailyResults.dayKey));
  const { stats, meals } = fold(
    days.map((d) => ({
      id: d.id,
      day_key: d.day_key,
      result: d.result as "feast" | "missed",
      deadline_at: d.deadline_at ?? d.window_end,
    })),
    cfg,
  );
  const statValues = {
    currentStreak: stats.current_streak,
    longestStreak: stats.longest_streak,
    totalFeasts: stats.total_feasts,
    totalMissed: stats.total_missed,
    restoreProgress: stats.restore_progress,
    famineSince: stats.famine_since,
    lastClosedDayKey: stats.last_closed_day_key,
  };
  await tx
    .insert(userStats)
    .values({ userId, ...statValues })
    .onConflictDoUpdate({ target: userStats.userId, set: statValues });

  if (meals.length > 0) {
    await tx
      .insert(missedMeals)
      .values(
        meals.map((m) => ({
          userId,
          dailyResultId: m.daily_result_id,
          occurredAt: m.occurred_at,
          restoredAt: m.restored_at,
          restoredByDailyResultId: m.restored_by_daily_result_id,
        })),
      )
      .onConflictDoUpdate({
        target: missedMeals.dailyResultId,
        set: {
          occurredAt: sql`excluded.occurred_at`,
          restoredAt: sql`excluded.restored_at`,
          restoredByDailyResultId: sql`excluded.restored_by_daily_result_id`,
        },
      });
  }
  const keep = meals.map((m) => m.daily_result_id);
  await tx
    .delete(missedMeals)
    .where(
      keep.length
        ? and(eq(missedMeals.userId, userId), notInArray(missedMeals.dailyResultId, keep))
        : eq(missedMeals.userId, userId),
    );
}

export interface EnsureDayResult {
  closed: number;
  opened: number;
  refolded: boolean;
}

/**
 * ensureDay (B6). The caller holds the users row lock. Closes every due day (provisionally
 * decided at close), opens the next ones, and refolds once per call.
 */
export async function ensureDay(
  tx: Tx,
  user: UserRow,
  settings: UserSettingsRow | null,
  now: Date,
  cfg: ScoringConfig,
): Promise<EnsureDayResult> {
  const res: EnsureDayResult = { closed: 0, opened: 0, refolded: false };
  if (!user.onboardedAt || !settings) return res;
  const pending = await getPendingDay(tx, user.id);
  if (!pending) {
    const last = await getLastDay(tx, user.id);
    await openDayAt(tx, user.id, settings, nextRollover(settings.tz, settings.rolloverHour, now), last?.dayKey ?? null, cfg);
    res.opened = 1;
    return res;
  }
  const plan = planCatchUp({
    pending: { window_end: pending.windowEnd, day_key: pending.dayKey },
    now,
    tz: settings.tz,
    rolloverHour: settings.rolloverHour,
    dormantSince: user.dormantSince,
    cfg,
  });
  if (plan.mode === "none") return res;
  if (await closeDay(tx, pending.id, now, cfg, { refold: false })) res.closed++;
  for (let i = 0; i < plan.windows.length; i++) {
    const row = await insertDay(tx, user.id, settings, plan.windows[i]);
    res.opened++;
    if (plan.mode === "catchup" && i < plan.windows.length - 1) {
      if (await closeDay(tx, row.id, now, cfg, { refold: false })) res.closed++;
    }
  }
  if (res.closed > 0) {
    await refold(tx, user.id, cfg);
    res.refolded = true;
  }
  return res;
}

/**
 * rescheduleOpenDay (B4) after a tz or rollover-hour change. A day that has not started yet
 * (day 0, or the day after a long absence) is re-planned from the next rollover; an open day
 * only moves its window_end, never below now or a stamped alarm_at.
 */
export async function rescheduleOpenDay(
  tx: Tx,
  user: UserRow,
  settings: UserSettingsRow,
  now: Date,
  cfg: ScoringConfig,
): Promise<void> {
  const pending = await getPendingDay(tx, user.id);
  if (!pending) return;
  if (pending.windowStart.getTime() > now.getTime()) {
    const prev = await tx
      .select({ dayKey: dailyResults.dayKey })
      .from(dailyResults)
      .where(and(eq(dailyResults.userId, user.id), ne(dailyResults.id, pending.id)))
      .orderBy(desc(dailyResults.dayKey))
      .limit(1);
    const start = nextRollover(settings.tz, settings.rolloverHour, now);
    const w = planDay({ tz: settings.tz, rolloverHour: settings.rolloverHour, start, prevDayKey: prev[0]?.dayKey ?? null, cfg });
    await tx
      .update(dailyResults)
      .set({
        windowStart: w.window_start,
        windowEnd: w.window_end,
        dayKey: w.day_key,
        tzAtOpen: settings.tz,
        rolloverHourAtOpen: settings.rolloverHour,
      })
      .where(eq(dailyResults.id, pending.id));
    if (user.firstDayStartsAt && user.firstDayStartsAt.getTime() === pending.windowStart.getTime()) {
      await tx.update(users).set({ firstDayStartsAt: w.window_start }).where(eq(users.id, user.id));
      user.firstDayStartsAt = w.window_start;
    }
  } else {
    const end = rescheduleWindowEnd({
      tz: settings.tz,
      rolloverHour: settings.rolloverHour,
      start: pending.windowStart,
      now,
      alarmAt: pending.alarmAt,
      cfg,
    });
    await tx.update(dailyResults).set({ windowEnd: end }).where(eq(dailyResults.id, pending.id));
  }
  await recomputeDay(tx, pending.id);
}

/** Fallback day key for history-only pieces, from the user's current settings. */
export function fallbackDayKeyFn(settings: UserSettingsRow | null): (t: Date) => string {
  const tz = settings?.tz ?? "America/Denver";
  const hour = settings?.rolloverHour ?? 3;
  return (t) => dayKey(tz, hour, t);
}

/** Days of a user overlapping [from, to] (windows for ingest). */
export async function windowsOverlapping(ex: Executor, userId: string, from: Date, to: Date): Promise<DailyResultRow[]> {
  return ex
    .select()
    .from(dailyResults)
    .where(
      and(
        eq(dailyResults.userId, userId),
        sql`${dailyResults.windowStart} <= ${to}`,
        sql`${dailyResults.windowEnd} >= ${from}`,
      ),
    )
    .orderBy(asc(dailyResults.windowStart));
}

export async function dayTotalsFor(ex: Executor, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const rows = await ex
    .select({ id: readingSessions.dailyResultId, total: sql<number>`coalesce(sum(${readingSessions.activeSeconds}), 0)` })
    .from(readingSessions)
    .where(
      and(
        inArray(readingSessions.dailyResultId, ids),
        eq(readingSessions.verified, true),
        eq(readingSessions.scorable, true),
        ne(readingSessions.source, "self_report"),
      ),
    )
    .groupBy(readingSessions.dailyResultId);
  return Object.fromEntries(rows.map((r) => [r.id!, Number(r.total)]));
}
