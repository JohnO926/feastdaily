// Scoring (B6): decide one day, and the deterministic fold from the ordered day log to
// stats + missed meals. Pure; `now` is always an argument.
import type { ScoringConfig } from "./config";

const DAY_MS = 86_400_000;

export interface DecideInput {
  window_end: Date;
  goal_seconds: number;
  verified_seconds: number;
  verified_before_alarm_seconds: number;
  self_reported_at: Date | null;
  alarm_at: Date | null;
}

/**
 * Feast iff the goal was reached by the deadline (alarm, or window_end when no alarm landed
 * in the window), or a self-report was tapped at or before it. A self-report after the
 * alarm is a miss (fixed rule).
 */
export function decide(d: DecideInput): { result: "feast" | "missed"; deadline: Date } {
  const deadline = d.alarm_at ?? d.window_end;
  const seconds = d.alarm_at ? d.verified_before_alarm_seconds : d.verified_seconds;
  const feast =
    seconds >= d.goal_seconds || (d.self_reported_at !== null && d.self_reported_at.getTime() <= deadline.getTime());
  return { result: feast ? "feast" : "missed", deadline };
}

export type TodayStatus = "not_started" | "racing" | "safe" | "missed";

/** Home status of the open (pending) day at `now`. Same enum as the iOS TodayStatus. */
export function statusOf(
  d: DecideInput & { window_start: Date },
  now: Date,
  firstDayStartsAt: Date | null,
): TodayStatus {
  if (now.getTime() < d.window_start.getTime()) return "not_started";
  if (firstDayStartsAt && now.getTime() < firstDayStartsAt.getTime()) return "not_started";
  if (d.alarm_at) return decide(d).result === "feast" ? "safe" : "missed";
  if (d.verified_seconds >= d.goal_seconds || d.self_reported_at) return "safe";
  return "racing";
}

export interface ClosedDay {
  id: string;
  day_key: string;
  result: "feast" | "missed";
  deadline_at: Date;
}

export interface FoldMeal {
  daily_result_id: string;
  occurred_at: Date;
  restored_at: Date | null;
  restored_by_daily_result_id: string | null;
}

export interface FoldStats {
  current_streak: number;
  longest_streak: number;
  total_feasts: number;
  total_missed: number;
  restore_progress: number;
  famine_since: Date | null;
  last_closed_day_key: string | null;
}

export interface FoldResult {
  stats: FoldStats;
  meals: FoldMeal[];
}

type FoldCfg = Pick<ScoringConfig, "missed_meal_expiry_days" | "feasts_to_restore" | "famine_threshold">;

export function mealExpiresAt(occurredAt: Date, cfg: Pick<ScoringConfig, "missed_meal_expiry_days">): Date {
  return new Date(occurredAt.getTime() + cfg.missed_meal_expiry_days * DAY_MS);
}

/** Active at t: occurred by t, not yet expired (occurred + expiry > t), not restored by t. */
export function isMealActive(
  m: { occurred_at: Date; restored_at: Date | null },
  t: Date,
  cfg: Pick<ScoringConfig, "missed_meal_expiry_days">,
): boolean {
  if (m.occurred_at.getTime() > t.getTime()) return false;
  if (m.restored_at && m.restored_at.getTime() <= t.getTime()) return false;
  return mealExpiresAt(m.occurred_at, cfg).getTime() > t.getTime();
}

/**
 * Fold over the WHOLE closed day log from the zero state (ordered by day_key). Deterministic
 * given the log and config, so close, re-score and admin recompute all agree.
 */
export function fold(days: ClosedDay[], cfg: FoldCfg): FoldResult {
  const sorted = [...days].sort((a, b) => (a.day_key < b.day_key ? -1 : a.day_key > b.day_key ? 1 : 0));
  const stats: FoldStats = {
    current_streak: 0,
    longest_streak: 0,
    total_feasts: 0,
    total_missed: 0,
    restore_progress: 0,
    famine_since: null,
    last_closed_day_key: null,
  };
  const meals: FoldMeal[] = [];
  for (const d of sorted) {
    const t = d.deadline_at;
    if (d.result === "feast") {
      stats.current_streak += 1;
      stats.longest_streak = Math.max(stats.longest_streak, stats.current_streak);
      stats.total_feasts += 1;
      stats.restore_progress += 1;
      if (stats.restore_progress >= cfg.feasts_to_restore) {
        const oldest = meals
          .filter((m) => isMealActive(m, t, cfg))
          .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())[0];
        if (oldest) {
          oldest.restored_at = t;
          oldest.restored_by_daily_result_id = d.id;
          stats.restore_progress = 0;
        }
      }
    } else {
      stats.current_streak = 0;
      stats.restore_progress = 0;
      stats.total_missed += 1;
      meals.push({ daily_result_id: d.id, occurred_at: t, restored_at: null, restored_by_daily_result_id: null });
    }
    // Famine transitions evaluated at this day's deadline.
    const active = meals.filter((m) => isMealActive(m, t, cfg)).length;
    if (active >= cfg.famine_threshold) {
      if (!stats.famine_since) stats.famine_since = t;
    } else {
      stats.famine_since = null;
    }
    stats.last_closed_day_key = d.day_key;
  }
  return { stats, meals };
}

/** Read-time projection (not persisted): active missed meals and famine at `now`. */
export function activeMeals<T extends { occurred_at: Date; restored_at: Date | null }>(
  meals: T[],
  now: Date,
  cfg: Pick<ScoringConfig, "missed_meal_expiry_days">,
): T[] {
  return meals
    .filter((m) => m.restored_at === null && mealExpiresAt(m.occurred_at, cfg).getTime() > now.getTime())
    .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
}

export function isFamine(activeCount: number, cfg: Pick<ScoringConfig, "famine_threshold">): boolean {
  return activeCount >= cfg.famine_threshold;
}

/** Whether a late session may flip a closed missed day (B5): only within the offline window. */
export function canRescore(
  row: { result: string; window_end: Date },
  receivedAt: Date,
  cfg: Pick<ScoringConfig, "offline_sync_window_hours">,
): boolean {
  return (
    row.result === "missed" &&
    receivedAt.getTime() <= row.window_end.getTime() + cfg.offline_sync_window_hours * 3_600_000
  );
}
