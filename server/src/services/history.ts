// GET /history (B9): daily_results union history-only sessions, grouped by day_key.
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { dailyResults, readingSessions } from "@/db/schema";
import { iso } from "@/lib/http";

export const HISTORY_MAX_DAYS = 93;

export interface HistorySessionDTO {
  id: string;
  session_id: string;
  source: "reader" | "self_report" | "audio";
  server_start_at: string;
  server_end_at: string;
  active_seconds: number;
  scorable: boolean;
  scored: boolean;
  reason: string | null;
  content_ref: string | null;
}

export interface HistoryDayDTO {
  day_key: string;
  result: "pending" | "feast" | "missed" | null;
  window_start: string | null;
  window_end: string | null;
  goal_seconds: number | null;
  verified_seconds: number;
  verified_before_alarm_seconds: number;
  total_seconds: number;
  goal_reached_at: string | null;
  self_reported_at: string | null;
  alarm_at: string | null;
  rescored: boolean;
  sessions: HistorySessionDTO[];
}

export async function getHistory(ex: Executor, userId: string, from: string, to: string): Promise<HistoryDayDTO[]> {
  const days = await ex
    .select()
    .from(dailyResults)
    .where(and(eq(dailyResults.userId, userId), gte(dailyResults.dayKey, from), lte(dailyResults.dayKey, to)))
    .orderBy(asc(dailyResults.dayKey));
  const sessions = await ex
    .select()
    .from(readingSessions)
    .where(
      and(
        eq(readingSessions.userId, userId),
        eq(readingSessions.verified, true),
        gte(readingSessions.dayKey, from),
        lte(readingSessions.dayKey, to),
      ),
    )
    .orderBy(asc(readingSessions.serverStartAt));

  const map = new Map<string, HistoryDayDTO>();
  for (const d of days) {
    map.set(d.dayKey, {
      day_key: d.dayKey,
      result: d.result,
      window_start: d.windowStart.toISOString(),
      window_end: d.windowEnd.toISOString(),
      goal_seconds: d.goalSeconds,
      verified_seconds: d.verifiedSeconds,
      verified_before_alarm_seconds: d.verifiedBeforeAlarmSeconds,
      total_seconds: 0,
      goal_reached_at: iso(d.goalReachedAt),
      self_reported_at: iso(d.selfReportedAt),
      alarm_at: iso(d.alarmAt),
      rescored: d.rescoredAt !== null,
      sessions: [],
    });
  }
  for (const s of sessions) {
    const key = s.dayKey!;
    let day = map.get(key);
    if (!day) {
      day = {
        day_key: key,
        result: null,
        window_start: null,
        window_end: null,
        goal_seconds: null,
        verified_seconds: 0,
        verified_before_alarm_seconds: 0,
        total_seconds: 0,
        goal_reached_at: null,
        self_reported_at: null,
        alarm_at: null,
        rescored: false,
        sessions: [],
      };
      map.set(key, day);
    }
    day.total_seconds += s.activeSeconds;
    day.sessions.push({
      id: s.id,
      session_id: s.parentId ?? s.id,
      source: s.source,
      server_start_at: s.serverStartAt!.toISOString(),
      server_end_at: s.serverEndAt!.toISOString(),
      active_seconds: s.activeSeconds,
      scorable: s.scorable,
      scored: s.scorable && s.dailyResultId !== null,
      reason: s.rejectReason,
      content_ref: s.contentRef,
    });
  }
  return [...map.values()].sort((a, b) => (a.day_key < b.day_key ? -1 : 1));
}
