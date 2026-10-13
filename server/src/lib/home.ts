// Client read model (B9): the GET /home payload. Active missed meals and famine are computed
// here at read time from missed_meals and `now`; nothing time-dependent is stored.
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { dailyResults, missedMeals, userStats, type UserRow, type UserSettingsRow } from "@/db/schema";
import { alarmDateFor, publicAlarmFor, type PublicAlarm } from "./alarm";
import type { ScoringConfig } from "./config";
import { iso } from "./http";
import { activeMeals, isFamine, mealExpiresAt, statusOf, type TodayStatus } from "./scoring";
import { getPendingDay } from "@/services/days";

export interface SettingsDTO {
  tz: string;
  rollover_hour: number;
  goal_seconds: number;
  pending_goal_seconds: number | null;
  reminder_enabled: boolean;
  reminder_local_time: string | null;
}

export interface TodayDTO {
  day_key: string;
  window_start: string;
  window_end: string;
  goal_seconds: number;
  verified_seconds: number;
  verified_before_alarm_seconds: number;
  goal_reached_at: string | null;
  self_reported_at: string | null;
  alarm_at: string | null;
  status: TodayStatus;
}

export interface HomeDTO {
  server_now: string;
  onboarded: boolean;
  settings: SettingsDTO | null;
  today: TodayDTO | null;
  first_day_starts_at: string | null;
  alarm: PublicAlarm;
  stats: {
    current_streak: number;
    longest_streak: number;
    total_feasts: number;
    active_missed_meals: number;
    famine: boolean;
    restore_progress: number;
  };
  missed_meals: { occurred_at: string; expires_at: string }[];
  last_closed: { day_key: string; result: "feast" | "missed" } | null;
  config: {
    famine_threshold: number;
    missed_meal_expiry_days: number;
    feasts_to_restore: number;
    alarm_window: { tz: string; start: string; end: string };
  };
}

/** "HH:MM:SS" (Postgres time) -> "HH:MM". */
export function hhmm(t: string | null): string | null {
  return t ? t.slice(0, 5) : null;
}

export function settingsDTO(s: UserSettingsRow | null): SettingsDTO | null {
  if (!s) return null;
  return {
    tz: s.tz,
    rollover_hour: s.rolloverHour,
    goal_seconds: s.goalSeconds,
    pending_goal_seconds: s.pendingGoalSeconds,
    reminder_enabled: s.reminderEnabled,
    reminder_local_time: hhmm(s.reminderLocalTime),
  };
}

export async function buildHome(
  ex: Executor,
  user: UserRow,
  settings: UserSettingsRow | null,
  cfg: ScoringConfig,
  now: Date,
): Promise<HomeDTO> {
  const pending = await getPendingDay(ex, user.id);
  const [stats] = await ex.select().from(userStats).where(eq(userStats.userId, user.id));
  const meals = await ex
    .select({ occurred_at: missedMeals.occurredAt, restored_at: missedMeals.restoredAt })
    .from(missedMeals)
    .where(and(eq(missedMeals.userId, user.id), isNull(missedMeals.restoredAt)));
  const active = activeMeals(meals, now, cfg);
  const [last] = await ex
    .select({ dayKey: dailyResults.dayKey, result: dailyResults.result })
    .from(dailyResults)
    .where(and(eq(dailyResults.userId, user.id), ne(dailyResults.result, "pending")))
    .orderBy(desc(dailyResults.dayKey))
    .limit(1);
  const alarm = await publicAlarmFor(ex, alarmDateFor(now, cfg));

  let today: TodayDTO | null = null;
  if (pending) {
    today = {
      day_key: pending.dayKey,
      window_start: pending.windowStart.toISOString(),
      window_end: pending.windowEnd.toISOString(),
      goal_seconds: pending.goalSeconds,
      verified_seconds: pending.verifiedSeconds,
      verified_before_alarm_seconds: pending.verifiedBeforeAlarmSeconds,
      goal_reached_at: iso(pending.goalReachedAt),
      self_reported_at: iso(pending.selfReportedAt),
      alarm_at: iso(pending.alarmAt),
      status: statusOf(
        {
          window_start: pending.windowStart,
          window_end: pending.windowEnd,
          goal_seconds: pending.goalSeconds,
          verified_seconds: pending.verifiedSeconds,
          verified_before_alarm_seconds: pending.verifiedBeforeAlarmSeconds,
          self_reported_at: pending.selfReportedAt,
          alarm_at: pending.alarmAt,
        },
        now,
        user.firstDayStartsAt,
      ),
    };
  }

  return {
    server_now: now.toISOString(),
    onboarded: user.onboardedAt !== null,
    settings: settingsDTO(settings),
    today,
    first_day_starts_at: iso(user.firstDayStartsAt),
    alarm,
    stats: {
      current_streak: stats?.currentStreak ?? 0,
      longest_streak: stats?.longestStreak ?? 0,
      total_feasts: stats?.totalFeasts ?? 0,
      active_missed_meals: active.length,
      famine: isFamine(active.length, cfg),
      restore_progress: stats?.restoreProgress ?? 0,
    },
    missed_meals: active.map((m) => ({
      occurred_at: m.occurred_at.toISOString(),
      expires_at: mealExpiresAt(m.occurred_at, cfg).toISOString(),
    })),
    last_closed: last ? { day_key: last.dayKey, result: last.result as "feast" | "missed" } : null,
    config: {
      famine_threshold: cfg.famine_threshold,
      missed_meal_expiry_days: cfg.missed_meal_expiry_days,
      feasts_to_restore: cfg.feasts_to_restore,
      alarm_window: { tz: cfg.alarm_tz, start: cfg.alarm_window_start, end: cfg.alarm_window_end },
    },
  };
}
